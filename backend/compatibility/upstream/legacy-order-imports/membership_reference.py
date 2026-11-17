"""Reference-only proof reader for an already consumed CSV membership.

It never decrypts contacts, moves EAV, extends expiry or grants membership. The
Node manager TX authenticates the genuine contact commit and seals these opaque
native references. The consumer checks their unchanged native identities again.
"""
import hashlib
import hmac
import os
from native import rows, one, json_value
from protocol import ImportReview, digest, canonical

CONTRACT = 'pos-csv-membership-contact-reference-v1'


def _fail():
    raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED') from None


def validate(session, key, proof, membership_hash, activation, customer, adapter):
    if os.environ.get('POS_LEGACY_IMPORT_MEMBERSHIP_REFERENCE_CONTRACT') != CONTRACT:
        _fail()
    head = one(session, 'SELECT grant_id,source_hash FROM pos_rewrite_import_authority_heads WHERE operation_id=:op FOR SHARE', {'op': proof['operationId']})
    records = rows(session, 'SELECT id,order_id,data FROM pos_rewrite_import_membership_references WHERE operation_id=:op AND grant_id=:grant AND OCTET_LENGTH(data)<=262144 FOR SHARE', {'op': proof['operationId'], 'grant': head['grant_id']}, 2)
    if len(records) != 1:
        _fail()
    record = records[0]
    envelope = json_value(record['data'])
    if not isinstance(envelope, dict) or set(envelope) != {'data', 'sourceHash'}:
        _fail()
    data = envelope['data']
    fields = {'contract','operationId','requestHash','planHash','namespace','orderId','customerId',
              'sourceReceiptHash','confirmationHash','activation','currentEntity','currentRevision',
              'currentRowsHash','transfers','grantId','managerId','approvedAt'}
    if (not isinstance(data, dict) or set(data) != fields or data['contract'] != CONTRACT
            or record['id'] != envelope['sourceHash'] or record['order_id'] != proof['orderId']
            or not hmac.compare_digest(envelope['sourceHash'], digest(key, 'membership-reference', data))
            or any(data[name] != proof[name] for name in ('operationId','requestHash','planHash','namespace','orderId','customerId'))
            or data['sourceReceiptHash'] != membership_hash or data['activation'] != activation
            or activation['contract'] != 'pos-cancellation-membership-provenance-v2'
            or data['grantId'] != head['grant_id']):
        _fail()
    grant = one(session, 'SELECT data,operation_id,manager_id FROM pos_rewrite_import_authority_successions WHERE id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE', {'id': data['grantId']})
    approval = json_value(grant['data'])
    auth_key = os.environ.get('POS_LEGACY_IMPORT_KEY', '')
    if (not auth_key or approval['sourceHash'] != head['source_hash']
            or not hmac.compare_digest(approval['sourceHash'], digest(auth_key, 'authority-succession', approval['data']))
            or grant['operation_id'] != data['operationId'] or grant['manager_id'] != data['managerId']
            or approval['data']['orderId'] != data['orderId'] or approval['data']['authority']['customerId'] != data['customerId']
            or approval['data']['issuedAt'] != data['approvedAt']):
        _fail()
    member_key, _ = adapter.config()
    revision = one(session, 'SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=:id FOR SHARE', {'id': data['customerId']})
    if (str(revision['revision']) != data['currentRevision']
            or data['currentEntity'] != adapter._hash('pending-cancellation.membership-entity.v1', customer['email'], member_key)
            or data['currentRowsHash'] != digest(key, 'membership-reference-rows', adapter.current(session, customer['email']))):
        _fail()
    confirmation = one(session, "SELECT proof,proof_hash,status,request_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind='confirmation' AND OCTET_LENGTH(proof)<=16000 FOR SHARE", {'op': data['operationId']})
    confirmed = json_value(confirmation['proof'])
    if (confirmation['status'] != 'completed' or confirmation['request_hash'] != data['requestHash']
            or confirmation['proof_hash'] != data['confirmationHash']
            or not hmac.compare_digest(data['confirmationHash'], digest(key, 'confirmation', confirmed))
            or confirmed['operationId'] != data['operationId'] or confirmed['orderId'] != data['orderId']
            or confirmed['headerHash'] != activation['headerHash']):
        _fail()
    transfers = data['transfers']
    if not isinstance(transfers, list) or not 1 <= len(transfers) <= 16:
        _fail()
    previous = activation['entityDigest']
    for transfer in transfers:
        if transfer['previousEntity'] != previous:
            _fail()
        challenge = one(session, 'SELECT customer_id,operator_id,checkout_id,kind,status,stage,encrypted_input FROM pos_rewrite_customer_contact_challenges WHERE id=:id AND OCTET_LENGTH(encrypted_input)<=342000', {'id': transfer['challengeId']})
        effect = one(session, 'SELECT customer_id,operator_id,challenge_id,kind,encrypted_payload,created_at_ms FROM pos_rewrite_customer_contact_deliveries WHERE id=:id AND OCTET_LENGTH(encrypted_payload)<=342000', {'id': transfer['deliveryId']})
        mutation = one(session, 'SELECT id,challenge_id,operator_id,checkout_id,action,input_hash,result,created_at_ms FROM pos_rewrite_customer_contact_mutations WHERE id=:id', {'id': transfer['operationId']})
        result = json_value(mutation['result'])
        mutation_body = {'id': mutation['id'], 'challengeId': mutation['challenge_id'], 'operatorId': mutation['operator_id'],
                         'checkoutId': mutation['checkout_id'], 'action': mutation['action'], 'inputHash': mutation['input_hash'],
                         'result': result, 'createdAt': mutation['created_at_ms']}
        if (challenge['customer_id'] != data['customerId'] or effect['customer_id'] != data['customerId']
                or challenge['operator_id'] != effect['operator_id'] or mutation['operator_id'] != challenge['operator_id']
                or mutation['checkout_id'] != challenge['checkout_id'] or mutation['challenge_id'] != transfer['challengeId']
                or effect['challenge_id'] != transfer['challengeId'] or effect['kind'] != 'source-effects'
                or challenge['kind'] != 'email' or challenge['stage'] != 'new' or challenge['status'] not in ('COMMITTING','COMMITTED','UNCERTAIN')
                or mutation['action'] != 'commit' or result.get('status') != 'success'
                or result.get('id') != mutation['id'] or result.get('challengeId') != transfer['challengeId']
                or mutation['created_at_ms'] != transfer['committedAt'] or effect['created_at_ms'] != transfer['committedAt']
                or hashlib.sha256(challenge['encrypted_input'].encode()).hexdigest() != transfer['inputHash']
                or hashlib.sha256(effect['encrypted_payload'].encode()).hexdigest() != transfer['effectHash']
                or digest(key, 'membership-reference-contact-mutation', mutation_body) != transfer['mutationHash']):
            _fail()
        previous = transfer['nextEntity']
    if previous != data['currentEntity']:
        _fail()
    return envelope
