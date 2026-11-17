"""Current native Node POS scope. No browser value is an authorization grant."""
import hashlib
import json
from datetime import datetime,timezone
from sqlalchemy import text
from writer_protocol import fail,portable_hash,quote_snapshot

CONTACT="LOWER(SHA2(CAST(JSON_OBJECT('customer_id',users.id,'email',users.email,'telephone',users.telephone) AS CHAR CHARACTER SET utf8mb4),256))"


def rows(session,query,parameters=None,maximum=2):
    result=session.execute(text(query),parameters or {})
    try:values=[dict(row) for row in result.mappings().fetchmany(maximum+1)]
    finally:result.close()
    if len(values)>maximum:fail()
    return values


def one(session,query,parameters=None):
    values=rows(session,query,parameters,1)
    if len(values)!=1:fail()
    return values[0]


def value_json(value):
    try:return json.loads(value) if isinstance(value,(str,bytes)) else value
    except Exception:fail()


def actor_version(actor,epoch):
    credentials=[actor['username'],actor['email'],actor['password'],bool(actor['is_mfa']),actor['mfa_hash'],
                 actor['phone'],actor['contact_email'],actor['otp_method'],actor['role'],actor['user_type'],
                 bool(actor['is_staff']),bool(actor['is_superuser'])]
    base=hashlib.sha256(json.dumps(credentials,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    return hashlib.sha256((base+':'+str(epoch)).encode()).hexdigest()


def lock_authority(session,cap,now,closing=False):
    # Archive/revocation holds actor before retiring check-ins. Match the
    # shared actor/epoch -> Store prefix; never take check-in before actor.
    # Every read is locking until the customer is held; the owned TX is RC.
    actor=one(session,'SELECT * FROM pos_user WHERE id=:id FOR SHARE',{'id':cap['actorId']})
    epochs=rows(session,'SELECT epoch FROM pos_rewrite_operator_auth_epochs WHERE operator_id=:id FOR SHARE',{'id':cap['actorId']},1)
    epoch=0 if not epochs else epochs[0]['epoch']
    if (actor['is_active']!=1 or actor['role'] not in (1,2,3,4,5) or actor['user_type'] not in (1,2) or
        str(epoch)!=cap['actorEpoch'] or actor_version(actor,epoch)!=cap['actorVersion']):fail()
    store=one(session,'SELECT id,type,is_active,category FROM stores WHERE id=:id FOR UPDATE',{'id':cap['storeId']})
    if store['is_active']!=1 or store['type'] not in ('STORE','CORE_WAREHOUSE'):fail()
    if actor['user_type']==2 and store['category']!='FRANCHISE':fail()
    if actor['role']!=1 or actor['user_type']!=1:
        if not rows(session,'SELECT id FROM user_stores WHERE django_user_id=:actor AND store_id=:store LIMIT 1 FOR SHARE',{'actor':cap['actorId'],'store':cap['storeId']},1):fail()
    one(session,'SELECT id FROM store_counters WHERE id=:counter AND store_id=:store AND is_active=1 FOR SHARE',{'counter':cap['counterId'],'store':cap['storeId']})
    checkin=one(session,'SELECT store_id,counter_id,expires_at FROM pos_rewrite_operator_checkins WHERE operator_id=:id FOR UPDATE',{'id':cap['actorId']})
    expiry=checkin['expires_at']
    if isinstance(expiry,str):
        try:expiry=datetime.fromisoformat(expiry)
        except ValueError:fail()
    if (str(checkin['store_id'])!=cap['storeId'] or str(checkin['counter_id'])!=cap['counterId'] or
        not isinstance(expiry,datetime) or int(expiry.replace(tzinfo=timezone.utc).timestamp()*1000)<=now):fail()
    checkout=one(session,'SELECT operator_id,store_id,version,state FROM pos_rewrite_checkout_sessions WHERE id=:id AND OCTET_LENGTH(state)<=4000000 FOR UPDATE',{'id':cap['checkoutId']})
    state=value_json(checkout['state'])
    if (checkout['operator_id']!=cap['actorId'] or checkout['store_id']!=cap['storeId'] or checkout['version']!=cap['checkoutVersion'] or
        not isinstance(state,dict) or state.get('id')!=cap['checkoutId'] or state.get('version')!=cap['checkoutVersion'] or
        state.get('operatorId')!=cap['actorId'] or state.get('storeId')!=cap['storeId'] or state.get('counterId')!=cap['counterId'] or
        closing and (not isinstance(state.get('screeningAdmission'),dict) or state['screeningAdmission'].get('operationId')!=cap['operationId']) or
        (state.get('busyOperationId') not in (None,cap['operationId']) if closing else state.get('busyOperationId')!=cap['operationId']) or
        (state.get('phase') not in ('quoted','uncertain') if closing else state.get('phase')!='quoted') or state.get('orderId') is not None or
        (state.get('customerId') or state.get('operatorCustomerId'))!=cap['customerId'] or
        not isinstance(state.get('draftImport'),dict) or state['draftImport'].get('status')!='complete' or
        state.get('orderCopy') is not None and state['orderCopy'].get('status')!='acknowledged' or
        portable_hash(quote_snapshot(state.get('quote')))!=cap['cartHash']):fail()
    if state.get('customerId') is not None:
        lease=one(session,'SELECT checkout_id,expires_at_ms FROM pos_rewrite_customer_cart_leases WHERE customer_id=:id FOR UPDATE',{'id':cap['customerId']})
        if lease['checkout_id']!=cap['checkoutId'] or not closing and lease['expires_at_ms']<=now:fail()
    operation=one(session,'SELECT status FROM pos_rewrite_checkout_operations WHERE checkout_id=:checkout AND id=:id FOR UPDATE',{'checkout':cap['checkoutId'],'id':cap['operationId']})
    if (operation['status'] not in ('inflight','uncertain','rejected') if closing else operation['status']!='inflight'):fail()
    customer=one(session,'SELECT users.*,'+CONTACT+' AS contact_digest FROM users WHERE id=:id FOR UPDATE',{'id':cap['customerId']})
    revisions=rows(session,'SELECT revision FROM pos_rewrite_customer_contact_revisions WHERE customer_id=:id FOR SHARE',{'id':cap['customerId']},1)
    if (customer['status']!=1 or customer['is_block'] not in (None,0) or customer['is_disabled'] not in (None,0) or
        customer['contact_digest']!=cap['contact']['digest'] or
        str(0 if not revisions else revisions[0]['revision'])!=cap['contact']['revision']):fail()
    return state,customer
