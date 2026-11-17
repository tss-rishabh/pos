"""Immutable no-order outcome under the public writer's creation lock.

Absence alone is never a receipt. The selected source frame owns every write
for this nonce in one transaction; its tombstone is checked before that frame
can run again. A timeout or database exception cannot enter this writer.
"""
import hmac
import re
from sqlalchemy import text
from writer_protocol import fail,validate_saved
from native_authority import one,rows,value_json,lock_authority
from protocol import digest,canonical
from screening_profile import SOURCE
from source_refunds import CORRECTED_CONTROLLER_SHA256

CONTRACT='pos-node-screening-no-order-v1'
CODES={'SCREENING_WRITER_LIMIT','SCREENING_WRITER_QUOTE_CHANGED','SCREENING_WRITER_STOCK_CHANGED',
       'SCREENING_WRITER_LINE_LIMIT','SCREENING_WRITER_EXPIRED','SCREENING_MEMBERSHIP_PROFILE_REQUIRED',
       'SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED','SCREENING_SOURCE_COMMAND_CLOSED'}
FIELDS={'contract','intent','intentHash','dispatchHash','source','sourceControllerHash',
        'code','noOrder','noFinancialEffects','createdAt'}


def intent(session,operation,key):
    row=one(session,'SELECT operation_id,checkout_id,actor_id,store_id,data,proof_hash FROM pos_rewrite_public_screening_work WHERE operation_id=:op AND OCTET_LENGTH(data)<=8000 FOR SHARE',{'op':operation})
    cap=validate_saved(value_json(row['data']))
    if (cap['operationId']!=operation or any(str(row[column])!=cap[name] for column,name in
            (('operation_id','operationId'),('checkout_id','checkoutId'),('actor_id','actorId'),('store_id','storeId'))) or
            not hmac.compare_digest(digest(key,'public-screening-intent',cap),row['proof_hash'])):fail()
    dispatch=one(session,'SELECT data,proof_hash FROM pos_rewrite_public_screening_submission_dispatches WHERE operation_id=:op AND OCTET_LENGTH(data)<=1000 FOR SHARE',{'op':operation})
    value=value_json(dispatch['data'])
    if (not isinstance(value,dict) or set(value)!={'contract','operationId','requestHash','dispatchedAt'} or
            value['contract']!='pos-node-screening-submission-dispatch-v1' or value['operationId']!=operation or
            value['requestHash']!=cap['requestHash'] or type(value['dispatchedAt']) is not int or
            not cap['issuedAt']<=value['dispatchedAt']<cap['expiresAt'] or
            not hmac.compare_digest(digest(key,'public-screening-submission-dispatch',value),dispatch['proof_hash'])):fail()
    return cap,row['proof_hash'],dispatch['proof_hash']


def read(session,cap,key):
    found=rows(session,'SELECT operation_id,checkout_id,request_hash,CASE WHEN OCTET_LENGTH(data)<=12000 THEN data ELSE NULL END AS data,proof_hash FROM pos_rewrite_public_screening_negatives WHERE operation_id=:op FOR SHARE',{'op':cap['operationId']},1)
    if not found:return None
    row=found[0];value=value_json(row['data'])
    if (not isinstance(value,dict) or set(value)!=FIELDS or value['contract']!=CONTRACT or value['intent']!=cap or
            value['source']!=SOURCE or value['sourceControllerHash']!=CORRECTED_CONTROLLER_SHA256 or
            value['code'] not in CODES or value['noOrder'] is not True or value['noFinancialEffects'] is not True or
            type(value['createdAt']) is not int or not cap['issuedAt']<=value['createdAt']<=9007199254740991 or
            any(str(row[column])!=cap[name] for column,name in
                (('operation_id','operationId'),('checkout_id','checkoutId'),('request_hash','requestHash'))) or
            not all(isinstance(value[name],str) and re.fullmatch(r'[a-f0-9]{64}',value[name]) for name in ('intentHash','dispatchHash')) or
            not hmac.compare_digest(digest(key,'public-screening-negative',value),row['proof_hash'])):fail()
    return {'data':value,'proofHash':row['proof_hash']}


def assert_open(session,cap,key):
    if read(session,cap,key) is not None:fail('SCREENING_SOURCE_COMMAND_CLOSED')


def assert_absent(session,cap,state):
    # These are causal journals keyed by the original creation nonce. Order,
    # HP, benefits and stock cannot commit outside the selected frame and its
    # atomically bound creation receipt. Never infer absence from paid status.
    for table in ('pos_rewrite_public_screening_orders','pos_rewrite_public_screening_effects',
                  'pos_rewrite_public_screening_completions','pos_rewrite_public_screening_abandonments',
                  'pos_rewrite_public_screening_payment_evidence','pos_rewrite_public_screening_publication_dispatches',
                  'pos_rewrite_public_screening_publication_replies','pos_rewrite_import_screening_reservations'):
        if rows(session,'SELECT operation_id FROM '+table+' WHERE operation_id=:op LIMIT 1 FOR SHARE',{'op':cap['operationId']},1):fail()
    if (state.get('orderId') is not None or state.get('orderSubmissionOperationId') is not None or
            state.get('paymentConfirmation') is not None or state.get('orderCustomerConsent') is not None or
            state.get('confirmationPhase') not in (None,'not-dispatched') or
            state.get('confirmationRecovery') is not None or state.get('paymentReceipt') is not None):fail()
    operation=one(session,'SELECT status,result FROM pos_rewrite_checkout_operations WHERE checkout_id=:checkout AND id=:op FOR UPDATE',{'checkout':cap['checkoutId'],'op':cap['operationId']})
    if operation['status'] not in ('inflight','uncertain','rejected') or operation['result'] is not None:fail()
    if rows(session,'SELECT id FROM pos_rewrite_payment_attempts WHERE id=:op LIMIT 1 FOR SHARE',{'op':cap['operationId']},1):fail()
    if rows(session,'SELECT id FROM pos_rewrite_payment_outbox WHERE id=:op OR id LIKE :prefix LIMIT 1 FOR SHARE',{'op':cap['operationId'],'prefix':cap['operationId']+':%'},1):fail()
    draft=state.get('draftId')
    if draft is not None and rows(session,'SELECT id FROM pos_rewrite_offline_cash_receipts WHERE operator_id=:actor AND draft_id=:draft LIMIT 1 FOR SHARE',{'actor':cap['actorId'],'draft':draft},1):fail()


def seal(session,cap,state,key,code,now):
    if code not in CODES or type(now) is not int or not cap['issuedAt']<=now<=9007199254740991:fail()
    saved,intent_hash,dispatch_hash=intent(session,cap['operationId'],key)
    if saved!=cap:fail()
    assert_absent(session,cap,state)
    existing=read(session,cap,key)
    if existing:
        if existing['data']['intentHash']!=intent_hash or existing['data']['dispatchHash']!=dispatch_hash:fail()
        return existing
    proof={'contract':CONTRACT,'intent':cap,'intentHash':intent_hash,'dispatchHash':dispatch_hash,
           'source':SOURCE,'sourceControllerHash':CORRECTED_CONTROLLER_SHA256,'code':code,
           'noOrder':True,'noFinancialEffects':True,'createdAt':now}
    signature=digest(key,'public-screening-negative',proof)
    session.execute(text('INSERT INTO pos_rewrite_public_screening_negatives(operation_id,checkout_id,request_hash,data,proof_hash) VALUES(:op,:checkout,:hash,:data,:proof)'),
                    {'op':cap['operationId'],'checkout':cap['checkoutId'],'hash':cap['requestHash'],'data':canonical(proof),'proof':signature})
    return {'data':proof,'proofHash':signature}


class NegativeResource:
    def __init__(self,sessions,proof_key,clock):
        self.sessions,self.proof_key,self.clock=sessions,proof_key,clock

    def hint(self,operation):
        with self.sessions() as session:return intent(session,operation,self.proof_key)[0]

    def read(self,operation):
        cap=self.hint(operation)
        with self.sessions() as session:
            with session.begin():
                session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                # Retained proof access is authenticated by the private caller;
                # this prefix is not authorization for new work after revocation.
                rows(session,'SELECT id FROM pos_user WHERE id=:id FOR SHARE',{'id':cap['actorId']},1)
                rows(session,'SELECT epoch FROM pos_rewrite_operator_auth_epochs WHERE operator_id=:id FOR SHARE',{'id':cap['actorId']},1)
                one(session,'SELECT id FROM stores WHERE id=:id FOR UPDATE',{'id':cap['storeId']})
                one(session,'SELECT id FROM pos_rewrite_checkout_sessions WHERE id=:id FOR UPDATE',{'id':cap['checkoutId']})
                one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':cap['customerId']})
                original,ih,dh=intent(session,operation,self.proof_key)
                if original!=cap:fail()
                value=read(session,cap,self.proof_key)
                if value and (value['data']['intentHash']!=ih or value['data']['dispatchHash']!=dh):fail()
                return value

    def post(self,operation):
        # A retry of an already immutable proof does not require today's old
        # actor/contact keys, flags or lease; it can never create another order.
        existing=self.read(operation)
        if existing:return existing
        cap=self.hint(operation)
        with self.sessions() as session:
            with session.begin():
                session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                now=self.clock()
                if now<cap['expiresAt']:fail('SCREENING_SOURCE_COMMAND_INFLIGHT')
                state,_customer=lock_authority(session,cap,now,closing=True)
                # Same Store/checkout/customer boundary as original creation.
                # A winner's receipt blocks this seal; a winning seal blocks all
                # delayed original senders before any source body can execute.
                return seal(session,cap,state,self.proof_key,'SCREENING_SOURCE_COMMAND_CLOSED',now)
