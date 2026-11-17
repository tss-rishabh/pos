"""Genuine other-origin coupon staging; no imported/Node financial authority.

All mutations remain in the original Order/Go functions. This module only locks
current native rows and seals their exact before/after evidence in that same TX.
"""
import copy
import hmac
from sqlalchemy import text
from native import one,rows,HEADER,LINE
from origin_contracts import canonical,digest,identifier,fail,unsafe,command
from benefit_receipts import COUPON_CONTROL,COUPON_USERS,COUPON_LOG,REFUND,money,coupon_users

CONTRACT='pos-screening-origin-coupon-v1'
HISTORY='pos-screening-origin-coupon-history-v1'
SOURCE='2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
TABLE='pos_rewrite_screening_origin_coupons'


def check_command(session,value,key,phases=('PREPARED','RESERVED')):
    from origin_ledger import read
    command(value)
    actual=read(session,value['id'],value['customerId'],key)
    if actual!=value or actual['phase'] not in phases:unsafe('SCREENING_ORIGIN_COUPON_SCOPE_CHANGED')
    return actual


def current_users(session,customer_id,coupon_id):
    return coupon_users(session,identifier(customer_id),identifier(coupon_id))


def read(session,value,key):
    """Immutable receipt reader. No current eligibility check or new mutation.

    The surrounding caller still authenticates its original command/creation;
    later contact/config changes must not rewrite an already completed fact.
    """
    found=rows(session,'SELECT order_id,data,proof_hash FROM '+TABLE+' WHERE command_id=:id AND OCTET_LENGTH(data)<=500000 FOR SHARE',{'id':value['id']},2)
    if not found:return None
    if len(found)!=1:unsafe('SCREENING_ORIGIN_COUPON_PROOF_INVALID')
    from native import json_value
    body=json_value(found[0]['data'])
    if (not isinstance(body,dict) or body.get('contract')!=CONTRACT or body.get('commandId')!=value['id']
            or body.get('origin')!=value['origin'] or body.get('customerId')!=value['customerId']
            or body.get('orderId')!=str(found[0]['order_id'])
            or any(body.get(name)!=value[name] for name in ('actorId','storeId','counterId','authorityHash','requestHash','cartHash','namespaceHash'))
            or not hmac.compare_digest(digest(key,'coupon',body),found[0]['proof_hash'])):unsafe('SCREENING_ORIGIN_COUPON_PROOF_INVALID')
    return {'data':body,'proofHash':found[0]['proof_hash']}


def capture(frame,state,header_hash,now):
    """Called before the enclosing creation proof, while its original locks live."""
    from controllers.cart.Cart import ItemTypes
    cart=frame.cart;meta=cart.get_item(ItemTypes.META,{'name':'coupon'})
    calc=cart.get_item(ItemTypes.META,{'name':'calculations'})
    if not meta:
        if calc and calc.get('coupon_discount',0):unsafe('SCREENING_ORIGIN_COUPON_UNBOUND')
        if state is not None:state.validate_after_native()
        return None
    if state is None or not state.validated:unsafe('SCREENING_ORIGIN_COUPON_UNBOUND')
    value=check_command(frame.session,frame.value,frame.owner.key,('RESERVED',))
    coupon_id=identifier(meta.get('coupon_id'))
    entry=state.choose(coupon_id)
    if not entry['validated'] or not calc:unsafe('SCREENING_ORIGIN_COUPON_CHANGED')
    order_id=identifier(frame.order_id)
    header=one(frame.session,'SELECT user_id,payment_method,coupon_used,CAST(CAST(coupon_amt_used AS DECIMAL(12,2)) AS CHAR) AS amount,'+HEADER+' AS hash FROM orders WHERE id=:id FOR SHARE',{'id':order_id})
    if str(header['user_id'])!=value['customerId'] or str(header['coupon_used'])!=coupon_id or header['hash']!=header_hash:unsafe('SCREENING_ORIGIN_COUPON_CHANGED')
    controls=one(frame.session,'SELECT '+COUPON_CONTROL+' AS hash FROM coupons WHERE id=:id FOR SHARE',{'id':coupon_id})
    if controls['hash']!=state.selection['couponInputHash']:unsafe('SCREENING_ORIGIN_COUPON_CHANGED')
    before=state.users_before;after=current_users(frame.session,value['customerId'],coupon_id)
    if len(before)!=len(after):unsafe('SCREENING_ORIGIN_COUPON_COUNTER_CHANGED')
    source_consumed=frame.kind=='customer' and state.settings['PREPAID_AMT_DEDUCTION']
    for old,new in zip(before,after):
        if (old['id']!=new['id'] or any(old[name]!=new[name] for name in ('allowed','monthlyAllowed'))
                or int(new['used'])!=int(old['used'])+(1 if source_consumed else 0)
                or (not source_consumed and old['inputHash']!=new['inputHash'])):unsafe('SCREENING_ORIGIN_COUPON_COUNTER_CHANGED')
    logs=rows(frame.session,'SELECT id,user_id,coupon_id,status,'+COUPON_LOG+' AS hash FROM order_coupon_log WHERE order_id=:id ORDER BY id LIMIT 2 FOR SHARE',{'id':order_id},2)
    if len(logs)!=(1 if source_consumed else 0):unsafe('SCREENING_ORIGIN_COUPON_LEDGER_CHANGED')
    source_log=None
    if logs:
        log=logs[0]
        if str(log['user_id'])!=value['customerId'] or str(log['coupon_id'])!=coupon_id or log['status']!=1:unsafe('SCREENING_ORIGIN_COUPON_LEDGER_CHANGED')
        source_log={'id':str(log['id']),'inputHash':log['hash'],'status':1}
    allocations=[]
    for row in rows(frame.session,'SELECT id,prod_id,qty,'+LINE+' AS hash,CAST(CAST(disc AS DECIMAL(12,2)) AS CHAR) AS discount,CAST(CAST(amount_to_be_refunded AS DECIMAL(12,2)) AS CHAR) AS refundable,'+REFUND+' AS refund_hash FROM has_products WHERE order_id=:id ORDER BY id LIMIT 1001 FOR SHARE',{'id':order_id},1001):
        if type(row['qty']) is not int or not 1<=row['qty']<=1000:unsafe('SCREENING_ORIGIN_COUPON_LINE_CHANGED')
        allocations.append({'id':str(row['id']),'productId':str(row['prod_id']),'quantity':row['qty'],
            'inputHash':row['hash'],'discount':money(row['discount']),'refundable':money(row['refundable']),'refundInputHash':row['refund_hash']})
    if not 1<=len(allocations)<=1000:unsafe('SCREENING_ORIGIN_COUPON_LINE_CHANGED')
    discount=money(calc.get('coupon_discount',0));amount=money(header['amount'])
    if discount!=amount:unsafe('SCREENING_ORIGIN_COUPON_AMOUNT_CHANGED')
    document=state.document
    body={'contract':CONTRACT,'sourceCommit':SOURCE,'commandId':value['id'],'origin':value['origin'],
        **{name:value[name] for name in ('actorId','customerId','storeId','counterId','authorityHash','requestHash','cartHash','namespaceHash')},
        'orderId':order_id,'headerHash':header_hash,'couponId':coupon_id,'couponInputHash':controls['hash'],
        'configurationHash':state.selection['configurationHash'],'originConfigurationHash':state.selection['originConfigurationHash'],
        'history':{'generationId':document['generationId'],'documentHash':document['signature'],'witnessHash':digest(frame.owner.key,'coupon-witness',document['witness'])},
        'birthdayClaim':copy.deepcopy(state.cache.claim),'cartCouponDiscount':discount,'headerCouponAmount':amount,
        'consumption':'source-prepaid' if source_consumed else 'go-confirmation',
        'couponUsersBefore':before,'couponUsersAfter':after,'sourceLog':source_log,'allocations':allocations,'createdAt':now}
    if state.welcome_consent is not None:body['welcomeConsent']=copy.deepcopy(state.welcome_consent)
    if len(canonical(body).encode())>500000:unsafe('SCREENING_ORIGIN_COUPON_PROOF_TOO_LARGE')
    proof=digest(frame.owner.key,'coupon',body)
    prior=read(frame.session,value,frame.owner.key)
    if prior is not None:
        if prior['data']!=body or prior['proofHash']!=proof:unsafe('SCREENING_ORIGIN_COUPON_PROOF_CONFLICT')
        return proof
    state.validate_after_native()
    frame.session.execute(text('INSERT INTO '+TABLE+'(command_id,order_id,data,proof_hash) VALUES(:id,:order,:data,:proof)'),
        {'id':value['id'],'order':order_id,'data':canonical(body),'proof':proof})
    return proof
