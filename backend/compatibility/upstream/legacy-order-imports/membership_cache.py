"""Once-only, post-commit source membership cache invalidation task.

The broker payload contains only operation UUID and signed receipt hash. No
cache key, email, source session, callback or connection is serialized. Unknown
Redis outcomes remain quarantined and never execute again automatically.
"""
import hmac
import os
import re
import time
from sqlalchemy import text
from protocol import ImportReview, canonical, digest, uuid
from native import one, rows, json_value
from membership_profile import CONTRACT, producer

TASK = 'pos_import_invalidate_membership'
KIND = 'member-cache'


def invalidate(session_factory, key, operation_id, receipt_hash, callback, clock=None):
    uuid(operation_id)
    clock = clock or (lambda: int(time.time() * 1000))
    adapter = producer()
    with session_factory() as session:
        with session.begin():
            order_receipt = one(session, "SELECT proof,proof_hash,status,request_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind='membership'", {'op': operation_id})
            proof = json_value(order_receipt['proof'])
            if (order_receipt['status'] != 'completed' or proof['contract'] != CONTRACT
                    or proof['operationId'] != operation_id or order_receipt['request_hash'] != proof['requestHash']
                    or not hmac.compare_digest(order_receipt['proof_hash'], receipt_hash)
                    or not hmac.compare_digest(receipt_hash, digest(key, 'membership', proof))):
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
            # Resolve immutable IDs from a sealed nonlocking lookup, then take
            # Order→customer→provenance locks before any receipt-row write.
            # Re-read the original receipt as a current locking read below.
            order = one(session, 'SELECT user_id FROM orders WHERE id=:id FOR UPDATE', {'id': proof['orderId']})
            if str(order['user_id']) != proof['customerId']:
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
            customer = one(session, 'SELECT id,email FROM users WHERE id=:id FOR UPDATE', {'id': proof['customerId']})
            current = adapter._decode(one(session, 'SELECT * FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=:id FOR UPDATE', {'id': proof['orderId']}))
            locked = one(session, "SELECT proof,proof_hash,status,request_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind='membership' FOR UPDATE", {'op': operation_id})
            if (locked['status'] != 'completed' or locked['request_hash'] != proof['requestHash']
                    or locked['proof_hash'] != receipt_hash or json_value(locked['proof']) != proof):
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
            prior = rows(session, "SELECT status,proof,proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind=:kind FOR UPDATE", {'op': operation_id, 'kind': KIND}, 2)
            if prior:
                original = json_value(prior[0]['proof'])
                if (original.get('membershipHash') != receipt_hash or original.get('operationId') != operation_id or original.get('status') != prior[0]['status'] or prior[0]['proof_hash'] != digest(key, KIND, original)):
                    raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
                if prior[0]['status'] == 'completed':
                    return
                # A prior processing checkpoint may have invalidated Redis.
                # Retrying it cannot be justified by a missing task ACK.
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNCERTAIN')
            member_key, _ = adapter.config()
            if proof['provenance']['entityDigest'] != adapter._hash('pending-cancellation.membership-entity.v1', customer['email'], member_key):
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
            staged = proof['provenance']
            if (current['orderId'] != staged['orderId'] or current['customerId'] != staged['customerId']
                    or current['before'] != staged['before'] or current['operationId'] != staged['operationId']
                    or current['headerHash'] != staged['headerHash'] or current['entityDigest'] != staged['entityDigest']
                    or not hmac.compare_digest(current['proofHash'], adapter.proof_hash(current, member_key))):
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
            binding = one(session, 'SELECT order_id,request_hash FROM pos_rewrite_import_financial_order_bindings WHERE operation_id=:op FOR SHARE', {'op': operation_id})
            if binding['order_id'] != proof['orderId'] or binding['request_hash'] != proof['requestHash']:
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
            claim = {'operationId': operation_id, 'membershipHash': receipt_hash, 'status': 'processing', 'checkpointAt': clock()}
            session.execute(text('INSERT INTO pos_rewrite_import_financial_source_receipts(id,operation_id,kind,request_hash,status,proof,proof_hash,created_at_ms) VALUES(:id,:op,:kind,:request,:status,:proof,:hash,:now)'),
                {'id': operation_id+':'+KIND, 'op': operation_id, 'kind': KIND, 'request': proof['requestHash'],
                 'status': 'processing', 'proof': canonical(claim), 'hash': digest(key, KIND, claim), 'now': clock()})
        # The claim and source order are already COMMITTED before source Redis
        # is touched. Reconstruct only the original scoped session internally.
        try:
            callback(session, int(customer['id']), customer['email'])
        except Exception:
            state = 'uncertain'
        else:
            state = 'completed'
        session.rollback()  # Original cache helper may have opened a read transaction.
        with session.begin():
            result = {**claim, 'status': state, 'finishedAt': clock()}
            session.execute(text('UPDATE pos_rewrite_import_financial_source_receipts SET status=:state,proof=:proof,proof_hash=:hash WHERE operation_id=:op AND kind=:kind AND status=\'processing\''),
                            {'state': state, 'proof': canonical(result), 'hash': digest(key, KIND, result), 'op': operation_id, 'kind': KIND})
        if state != 'completed':
            raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNCERTAIN') from None


def journal_options():
    queue=os.environ.get('POS_LEGACY_IMPORT_MEMBERSHIP_CACHE_QUEUE','')
    if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,128}',queue):
        raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
    return {'queue':queue}


def register_task(tasks, session_factory, proof_key):
    # Registration happens only in this dedicated private source worker and its
    # approved Celery consumer entrypoint. It never adds a public HTTP route.
    if TASK in tasks.app.tasks:
        raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
    from controllers.user import userDal
    def original(session, customer_id, email):
        userDal.cache.region_invalidate(userDal.get_exclusive_token, None, 'exclusive_user', session, customer_id, email)
    def execute(operation_id,receipt_hash):
        try:
            return invalidate(session_factory,proof_key,operation_id,receipt_hash,original)
        except Exception:
            raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNCERTAIN') from None
    registered = tasks.app.task(name=TASK, acks_late=False, autoretry_for=(), max_retries=0,**journal_options())(execute)
    setattr(tasks, TASK, registered)
    return registered
