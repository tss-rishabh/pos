"""Native nonce/quota/creation ledger shared by genuine source origins."""
import copy
import hmac
from sqlalchemy import text
from origin_contracts import PROOF,command,checked,digest,canonical,identifier,fail
from native import rows,one,json_value
from screening_profile import checked_state,native_projection

def read(session,command_id,customer_id,key,lock=True):
    found=rows(session,'SELECT * FROM pos_rewrite_screening_origin_commands WHERE id=:id AND customer_id=:customer AND OCTET_LENGTH(data)<=16000'+(' FOR UPDATE' if lock else ' FOR SHARE'),{'id':command_id,'customer':customer_id},2)
    return None if not found else checked(found[0],key)

def save(session,value,key,now):
    value=command({**value,'version':value['version']+1,'updatedAt':now})
    session.execute(text('UPDATE pos_rewrite_screening_origin_commands SET phase=:phase,order_id=:order,data=:data,proof_hash=:proof WHERE id=:id AND customer_id=:customer'),
        {'phase':value['phase'],'order':value['orderId'],'data':canonical(value),'proof':digest(key,'command',value),'id':value['id'],'customer':value['customerId']})
    return value

def insert(session,value,key):
    value=command(value)
    # A caller-chosen financial command cannot adopt a server-issued cart
    # preview UUID and redirect its independently authenticated worker scope.
    if rows(session,'SELECT preview_id FROM pos_rewrite_screening_origin_cart_previews WHERE preview_id=:id FOR SHARE',{'id':value['id']},1):fail('SCREENING_ORIGIN_COMMAND_CONFLICT')
    session.execute(text('INSERT INTO pos_rewrite_screening_origin_commands(id,origin,customer_id,actor_id,store_id,counter_id,phase,order_id,data,proof_hash) VALUES(:id,:origin,:customer,:actor,:store,:counter,:phase,NULL,:data,:proof)'),
        {'id':value['id'],'origin':value['origin'],'customer':value['customerId'],'actor':value['actorId'],'store':value['storeId'],'counter':value['counterId'],
         'phase':value['phase'],'data':canonical(value),'proof':digest(key,'command',value)})
    return value

def projection(session,value):
    order=one(session,'SELECT user_id,order_status FROM orders WHERE id=:id FOR SHARE',{'id':value['orderId']})
    lines=rows(session,'SELECT id,qty,sub_prod_id FROM has_products WHERE order_id=:id AND prod_id=390238 ORDER BY id LIMIT 3',{'id':value['orderId']},3)
    markers=rows(session,'SELECT id,has_product_id,user_id FROM spiderman_screening_orders FORCE INDEX(idx_order_id) WHERE order_id=:id ORDER BY id LIMIT 3',{'id':value['orderId']},3)
    identity={'lines':[{'id':str(row['id']),'quantity':row['qty']} for row in lines],
              'markers':[{'id':str(row['id']),'lineId':str(row['has_product_id'])} for row in markers]}
    if (str(order['user_id'])!=value['customerId'] or any(row['sub_prod_id']!=0 for row in lines) or any(str(row['user_id'])!=value['customerId'] for row in markers)
            or identity['lines']!=value['lines'] or identity['markers']!=value['markers']):fail('SCREENING_ORIGIN_STRUCTURE_CHANGED')
    if value['origin'] in ('legacy-django','mpos'):
        stores=rows(session,'SELECT store_id,counter_id FROM order_stores WHERE order_id=:id',{'id':value['orderId']},2)
        if len(stores)!=1 or str(stores[0]['store_id'])!=value['storeId'] or str(stores[0]['counter_id'])!=value['counterId']:fail()
    return order['order_status'] is not None and order['order_status'] not in (0,17)

def creation(session,value,key):
    row=one(session,'SELECT order_id,data,proof_hash FROM pos_rewrite_screening_origin_creations WHERE command_id=:id AND OCTET_LENGTH(data)<=256000 FOR SHARE',{'id':value['id']})
    proof=json_value(row['data'])
    if (not isinstance(proof,dict) or proof.get('contract')!='pos-screening-origin-creation-v1' or proof.get('commandId')!=value['id']
            or proof.get('origin')!=value['origin'] or proof.get('customerId')!=value['customerId'] or proof.get('orderId')!=value['orderId']
            or str(row['order_id'])!=value['orderId'] or row['proof_hash']!=value['creationHash']
            or not hmac.compare_digest(digest(key,'creation',proof),row['proof_hash'])):fail()
    return proof

def payment(session,value,key):
    row=one(session,'SELECT order_id,data,proof_hash FROM pos_rewrite_screening_origin_payments WHERE command_id=:id AND OCTET_LENGTH(data)<=1000000 FOR SHARE',{'id':value['id']})
    proof=json_value(row['data'])
    if (not isinstance(proof,dict) or proof.get('contract')!='pos-screening-origin-payment-v1' or proof.get('status')!='CONFIRMED'
            or proof.get('commandId')!=value['id'] or proof.get('orderId')!=value['orderId'] or proof.get('customerId')!=value['customerId']
            or proof.get('creationHash')!=value['creationHash'] or str(row['order_id'])!=value['orderId']
            or not hmac.compare_digest(digest(key,'payment',proof),row['proof_hash'])):fail()
    coupon_effect(session,value,key,creation(session,value,key),proof,'confirm')
    return proof

def coupon_effect(session,value,key,source,outcome,action):
    required=source.get('couponHash')
    if required is None:
        if 'couponConsumptionHash' in outcome:fail()
        return
    from origin_contracts import HASH
    seal=outcome.get('couponConsumptionHash')
    if not isinstance(required,str) or not HASH.fullmatch(required) or not isinstance(seal,str) or not HASH.fullmatch(seal):fail()
    row=one(session,'SELECT order_id,data,proof_hash FROM pos_rewrite_screening_origin_coupon_consumptions WHERE command_id=:id AND action=:action AND OCTET_LENGTH(data)<=500000 FOR SHARE',{'id':value['id'],'action':action})
    proof=json_value(row['data'])
    if (not isinstance(proof,dict) or proof.get('contract')!='pos-screening-origin-coupon-consumption-v1' or row['proof_hash']!=seal
            or str(row['order_id'])!=value['orderId'] or proof.get('orderId')!=value['orderId'] or proof.get('customerId')!=value['customerId']
            or proof.get('commandId')!=value['id'] or proof.get('creationHash')!=value['creationHash'] or proof.get('sourceReceiptHash')!=required
            or proof.get('headerHash')!=source['headerHash'] or proof.get('action')!=action
            or proof.get('sourceCommit')!='434f3e438d1cb48c64e5723222c6efda506db571'
            or not hmac.compare_digest(digest(key,'coupon-consumption',proof),row['proof_hash'])):fail()

def failed_payment(session,value,key):
    """Only a retained genuine decline may release a not-counted order.

    A timeout, authorization-only failure, phase flag, or mutable status alone
    never relinquishes the original reservation. Caller holds the customer.
    """
    attempt=rows(session,'SELECT order_id,customer_id,phase,data,proof_hash FROM pos_rewrite_screening_origin_payment_attempts WHERE command_id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE',{'id':value['id']},2)
    if not attempt:return False
    if len(attempt)!=1:fail()
    row=attempt[0];record=json_value(row['data'])
    if (not isinstance(record,dict) or record.get('contract')!='pos-screening-origin-payments-v1'
            or record.get('commandId')!=value['id'] or record.get('orderId')!=value['orderId'] or record.get('customerId')!=value['customerId']
            or str(row['order_id'])!=value['orderId'] or str(row['customer_id'])!=value['customerId'] or record.get('phase')!=row['phase']
            or record.get('creationHash')!=value['creationHash'] or record.get('requestHash')!=value['requestHash']
            or record.get('referenceHash')!=value['referenceHash'] or not hmac.compare_digest(digest(key,'payment-attempt',record),row['proof_hash'])):fail()
    if record['phase']!='FAILED':return False
    observation=record.get('observationHash')
    if not isinstance(observation,str) or len(observation)!=64:fail()
    negative=one(session,'SELECT order_id,data,proof_hash FROM pos_rewrite_screening_origin_payment_outcomes WHERE command_id=:id AND observation_hash=:hash AND OCTET_LENGTH(data)<=1000000 FOR SHARE',{'id':value['id'],'hash':observation})
    proof=json_value(negative['data'])
    if (not isinstance(proof,dict) or proof.get('contract')!='pos-screening-origin-payment-outcome-v1' or proof.get('status')!='FAILED'
            or proof.get('noConfirmation') is not True or proof.get('commandId')!=value['id'] or proof.get('origin')!=value['origin']
            or proof.get('customerId')!=value['customerId'] or proof.get('orderId')!=value['orderId'] or str(negative['order_id'])!=value['orderId']
            or proof.get('creationHash')!=value['creationHash'] or proof.get('requestHash')!=value['requestHash'] or proof.get('referenceHash')!=value['referenceHash']
            or proof.get('observationHash')!=observation or not isinstance(proof.get('after'),dict)
            or not hmac.compare_digest(digest(key,'payment-outcome',proof),negative['proof_hash'])):fail()
    if proof['after'].get('orderStatus')!=17:return False
    coupon_effect(session,value,key,creation(session,value,key),proof,'decline')
    if rows(session,'SELECT order_id FROM pos_rewrite_screening_origin_payments WHERE command_id=:id FOR SHARE',{'id':value['id']},2):fail()
    native=one(session,'SELECT user_id,order_status FROM orders WHERE id=:id FOR SHARE',{'id':value['orderId']})
    return str(native['user_id'])==value['customerId'] and native['order_status']==17

def pending(session,customer,key,except_id=None):
    customer=identifier(customer)
    found=rows(session,'SELECT * FROM pos_rewrite_screening_origin_commands FORCE INDEX(ix_screening_origin_customer) WHERE customer_id=:customer ORDER BY id LIMIT 1001',{'customer':customer},1001)
    if len(found)>1000:fail('SCREENING_ORIGIN_COHORT_TOO_LARGE')
    total=0
    for row in found:
        value=checked(row,key)
        if value['id']==except_id:continue
        if value['phase']=='RESERVED':total+=value['markerRows']
        elif value['phase']=='COUNTED':
            creation(session,value,key);payment(session,value,key)
        elif value['phase']=='BOUND':
            creation(session,value,key)
            included=projection(session,value)
            if not included and not failed_payment(session,value,key):total+=value['markerRows']
        elif value['phase']=='REJECTED':
            closure=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_closures WHERE command_id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE',{'id':value['id']})
            proof=json_value(closure['data'])
            if (proof.get('commandId')!=value['id'] or proof.get('customerId')!=customer or proof.get('noFinancialEffects') is not True
                    or closure['proof_hash']!=value['closureHash'] or not hmac.compare_digest(digest(key,'closure',proof),closure['proof_hash'])):fail()
    return total

def all_pending(session,customer,legacy_key,origin_key,except_origin=None,except_legacy=None):
    total=pending(session,customer,origin_key,except_origin)
    legacy=rows(session,'SELECT * FROM pos_rewrite_import_screening_reservations FORCE INDEX(ix_import_screening_customer) WHERE customer_id=:customer AND sku=390238 ORDER BY operation_id LIMIT 1001',{'customer':customer},1001)
    if len(legacy)>1000:fail('SCREENING_ORIGIN_COHORT_TOO_LARGE')
    for row in legacy:
        value=checked_state(row,legacy_key)
        if value['scope']['operationId']==except_legacy:continue
        if value['phase']=='RESERVED' or value['phase']=='BOUND' and not native_projection(session,value,value['orderId'])[1]:total+=value['markerRows']
    return total

def reserve(session,value,key,legacy_key,counter,now):
    if value['phase']!='PREPARED' or value['expiresAt']<=now:fail('SCREENING_ORIGIN_EXPIRED')
    pending_rows=all_pending(session,value['customerId'],legacy_key,key,value['id'])
    if counter.count+pending_rows+value['quantity']>2:fail('SCREENING_ORIGIN_LIMIT')
    return save(session,{**value,'phase':'RESERVED'},key,now)
