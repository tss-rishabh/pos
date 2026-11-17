"""Shared ticket reservation and separate ordinary POS creation provenance."""
import hashlib
import hmac
import json
from sqlalchemy import text
from writer_protocol import CONTRACT,fail
from native_authority import rows,one,value_json
from screening_profile import (SOURCE,CONTRACT as RESERVATION_CONTRACT,SKU,COUNT_SQL,
                               checked_state,native_projection,write_state)
from protocol import digest,canonical
from transaction import TransactionSession

CREATION_CONTRACT='pos-node-screening-creation-v1'
CREATION_FIELDS={'contract','operationId','checkoutId','checkoutVersion','actorId','customerId','storeId','counterId',
                 'requestHash','cartHash','actorVersion','actorEpoch','contact','source','sourceControllerHash',
                 'orderId','method','lineItemsEnabled','lines','markers','effectsHash','createdAt'}


def creation_hash(key,value):
    return digest(key,'public-screening-creation',value)


def scope(cap):
    return {'actorId':cap['actorId'],'operationId':cap['operationId'],'storeId':cap['storeId'],'counterId':cap['counterId']}


def plan_hash(key,cap):
    # A public quote scope, never a fabricated CSV plan or CSV operation.
    return digest(key,'public-screening-plan',{'checkoutId':cap['checkoutId'],'checkoutVersion':cap['checkoutVersion'],'cartHash':cap['cartHash']})


def authority_hash(key,cap):
    return digest(key,'public-screening-authority',{name:cap[name] for name in ('actorId','actorVersion','actorEpoch','customerId','contact','storeId','counterId')})


def reserve(session,cap,key,quantity,line_items,now):
    if type(quantity) is not int or quantity not in (1,2) or type(line_items) is not bool:fail('SCREENING_WRITER_LIMIT')
    if rows(session,'SELECT operation_id FROM pos_rewrite_import_screening_reservations WHERE operation_id=:id FOR UPDATE',{'id':cap['operationId']},1):fail('SCREENING_WRITER_RECONCILIATION_REQUIRED')
    bought=int(one(session,COUNT_SQL,{'user_id':cap['customerId'],'sku':SKU})['cnt'])
    pending=0
    others=rows(session,'SELECT * FROM pos_rewrite_import_screening_reservations FORCE INDEX (ix_import_screening_customer) WHERE customer_id=:id AND sku=:sku ORDER BY operation_id',{'id':cap['customerId'],'sku':SKU},1000)
    for row in others:
        value=checked_state(row,key)
        if value['phase']=='RESERVED':pending+=value['markerRows']
        elif value['phase']=='BOUND' and not native_projection(session,value,value['orderId'])[1]:pending+=value['markerRows']
    if bought+pending+quantity>2:fail('SCREENING_WRITER_LIMIT')
    value={'contract':RESERVATION_CONTRACT,'scope':scope(cap),'source':SOURCE,'customerId':cap['customerId'],'sku':SKU,'kind':'pos',
           'planHash':plan_hash(key,cap),'requestHash':cap['requestHash'],'authorityHash':authority_hash(key,cap),'catalogHash':cap['cartHash'],
           'quantity':quantity,'lineItemsEnabled':line_items,'markerRows':quantity if line_items else 1,'sourceCountBefore':str(bought),
           'pendingBefore':pending,'phase':'RESERVED','orderId':None,'lines':[],'markers':[],'sourceReceiptHash':None,
           'completionHash':None,'rejectionHash':None,'version':1,'createdAt':now,'updatedAt':now}
    session.execute(text('INSERT INTO pos_rewrite_import_screening_reservations(operation_id,customer_id,sku,order_id,data,proof_hash) VALUES(:op,:customer,:sku,NULL,:data,:hash)'),
                    {'op':cap['operationId'],'customer':cap['customerId'],'sku':SKU,'data':canonical(value),'hash':digest(key,'screening-state',value)})
    return value


def bind(session,cap,value,key,result,source_controller_hash,effects_hash,now,benefits_hash=None):
    if set(result)!={'order','method','isValid','name'} or result['isValid'] is not True or result['name']!='placed_order' or result['method'] not in (3,14):fail()
    order_id=str(result['order'])
    projection,_=native_projection(session,value,order_id)
    header=one(session,'SELECT payment_method,payment_status,order_status,pay_amt,parent_order_id,original_order_id FROM orders WHERE id=:id FOR SHARE',{'id':order_id})
    if (header['payment_method']!=result['method'] or header['payment_status']!=0 or header['order_status']!=0 or
        result['method']==3 and header['pay_amt']!=0 or header['parent_order_id']!=0 or header['original_order_id']!=0):fail()
    proof={name:cap[name] for name in ('operationId','checkoutId','checkoutVersion','actorId','customerId','storeId','counterId',
                                     'requestHash','cartHash','actorVersion','actorEpoch','contact')}
    proof.update(contract=CREATION_CONTRACT,source=SOURCE,sourceControllerHash=source_controller_hash,orderId=order_id,method=result['method'],
                 lineItemsEnabled=value['lineItemsEnabled'],**projection,effectsHash=effects_hash,createdAt=now)
    if benefits_hash is not None:proof['benefitsHash']=benefits_hash
    seal=creation_hash(key,proof)
    session.execute(text('INSERT INTO pos_rewrite_public_screening_orders(operation_id,checkout_id,actor_id,customer_id,store_id,counter_id,order_id,request_hash,data,proof_hash) VALUES(:op,:checkout,:actor,:customer,:store,:counter,:order,:request,:data,:hash)'),
                    {'op':cap['operationId'],'checkout':cap['checkoutId'],'actor':cap['actorId'],'customer':cap['customerId'],
                     'store':cap['storeId'],'counter':cap['counterId'],'order':order_id,'request':cap['requestHash'],'data':canonical(proof),'hash':seal})
    value=write_state(TransactionSession(session),key,{**value,'phase':'BOUND','orderId':order_id,**projection,'sourceReceiptHash':seal},now)
    return proof,value


def read_creation(session,operation_id,key,expected_scope):
    """Internal immutable read: caller authenticates current read access separately."""
    found=rows(session,'SELECT * FROM pos_rewrite_public_screening_orders WHERE operation_id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE',{'id':operation_id},1)
    if not found:return None
    row=found[0];value=value_json(row['data'])
    if (not isinstance(value,dict) or set(value) not in (CREATION_FIELDS,CREATION_FIELDS|{'benefitsHash'}) or value['contract']!=CREATION_CONTRACT or value['source']!=SOURCE or
        value['operationId']!=operation_id or any(value[name]!=expected_scope[name] for name in ('actorId','storeId','counterId')) or
        any(str(row[column])!=value[name] for name,column in (('operationId','operation_id'),('checkoutId','checkout_id'),('actorId','actor_id'),
            ('customerId','customer_id'),('storeId','store_id'),('counterId','counter_id'),('orderId','order_id'),('requestHash','request_hash'))) or
        not hmac.compare_digest(creation_hash(key,value),row['proof_hash'])):fail('SCREENING_WRITER_RECONCILIATION_REQUIRED')
    reservation=checked_state(one(session,'SELECT * FROM pos_rewrite_import_screening_reservations WHERE operation_id=:id FOR SHARE',{'id':operation_id}),key)
    if (reservation['kind']!='pos' or reservation['orderId']!=value['orderId'] or reservation['sourceReceiptHash']!=row['proof_hash'] or
        reservation['lines']!=value['lines'] or reservation['markers']!=value['markers'] or
        reservation['requestHash']!=value['requestHash'] or reservation['catalogHash']!=value['cartHash']):fail()
    native_projection(session,reservation,value['orderId'])
    if 'benefitsHash' in value:
        from public_benefits import read
        read(session,value,key)
    return value
