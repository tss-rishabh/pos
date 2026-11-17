"""Native SQL evidence shared with the Node adapter; never reserialize FLOATs."""
import hashlib
import json
from sqlalchemy import text
from protocol import ImportReview, amount

CHECKOUT_HEADER = "LOWER(SHA2(CAST(JSON_OBJECT('order_id',orders.id,'user_id',orders.user_id,'payment_method',orders.payment_method,'pay_amt',orders.pay_amt,'cashback_used',orders.cashback_used,'tss_money_used',orders.tss_money_used,'tss_points_used',orders.tss_points_used,'voucher_used',orders.voucher_used,'voucher_amt_used',orders.voucher_amt_used,'coupon_used',orders.coupon_used,'coupon_amt_used',orders.coupon_amt_used) AS CHAR CHARACTER SET utf8mb4),256))"
HEADER = "LOWER(SHA2(CAST(JSON_OBJECT('financial_header_hash',"+CHECKOUT_HEADER+",'created_at',DATE_FORMAT(orders.created_at,'%Y-%m-%d %H:%i:%s'),'currency',orders.currency,'currency_conv_rate',orders.currency_conv_rate,'shipping_amt',orders.shipping_amt,'order_amt',orders.order_amt,'fraction_value',orders.fraction_value,'first_name',orders.first_name,'last_name',orders.last_name,'address1',orders.address1,'address2',orders.address2,'address3',orders.address3,'phone_no',orders.phone_no,'country_id',orders.country_id,'zone_id',orders.zone_id,'postal_code',orders.postal_code,'city',orders.city) AS CHAR CHARACTER SET utf8mb4),256))"
LINE = "LOWER(SHA2(CAST(JSON_OBJECT('id',has_products.id,'product_id',has_products.prod_id,'sub_product_id',has_products.sub_prod_id,'quantity',has_products.qty,'price',has_products.price,'gst',has_products.gst,'pre_gst_amt',has_products.pre_gst_amt,'disc',has_products.disc,'wallet_disc',has_products.wallet_disc,'voucher_disc',has_products.voucher_disc,'points',has_products.hp_tss_points_used,'refundable',has_products.amount_to_be_refunded,'fraction_value',has_products.fraction_value) AS CHAR CHARACTER SET utf8mb4),256))"
CONTACT = "LOWER(SHA2(CAST(JSON_OBJECT('customer_id',users.id,'email',users.email,'telephone',users.telephone) AS CHAR CHARACTER SET utf8mb4),256))"


def rows(session,query,parameters=None,limit=1001):
    result=session.execute(text(query),parameters or {})
    values=result.mappings().fetchmany(limit)
    result.close()
    if len(values)>=limit:
        raise ImportReview('ORDER_IMPORT_RESULT_TOO_LARGE')
    return [dict(row) for row in values]


def one(session,query,parameters=None):
    values=rows(session,query,parameters,2)
    if len(values)!=1:
        raise ImportReview('ORDER_IMPORT_NATIVE_SCOPE_INVALID')
    return values[0]


def json_value(value):
    return json.loads(value) if isinstance(value,(str,bytes)) else value


def lock_command(session,capability,phase):
    operation=one(session,"SELECT actor_id,store_id,counter_id,request_hash,plan_hash,namespace,state FROM pos_rewrite_import_financial_operations WHERE id=:id AND OCTET_LENGTH(state)<=16000 FOR UPDATE",{'id':capability['operationId']})
    state=json_value(operation['state'])
    for name,column in [('actorId','actor_id'),('storeId','store_id'),('counterId','counter_id')]:
        if operation[column]!=capability['scope'][name]:
            raise ImportReview('ORDER_IMPORT_NATIVE_SCOPE_INVALID')
    if (operation['request_hash']!=capability['requestHash'] or operation['plan_hash']!=capability['planHash'] or
        operation['namespace']!=capability['namespace'] or state['scope']!=capability['scope'] or
        state['authority']!=capability['authority'] or state['status'] not in ('running','unknown')):
        raise ImportReview('ORDER_IMPORT_NATIVE_SCOPE_INVALID')
    stage=one(session,"SELECT nonce,status FROM pos_rewrite_import_financial_stages WHERE operation_id=:id AND kind=:kind FOR UPDATE",{'id':capability['operationId'],'kind':phase})
    if stage['nonce']!=capability['nonce'] or stage['status']!='dispatched':
        raise ImportReview('ORDER_IMPORT_ORIGINAL_STAGE_UNCERTAIN')
    return state


def fresh_authority(session,capability):
    scope,authority=capability['scope'],capability['authority']
    # Native flag types are checked rather than relying on Python truthiness.
    actor=one(session,"SELECT * FROM pos_user WHERE id=:id FOR SHARE",{'id':scope['actorId']})
    if actor['is_active']!=1 or actor['user_type']!=1 or actor['role'] not in (1,2,3):
        raise ImportReview('ORDER_IMPORT_AUTHORITY_CHANGED')
    epoch=rows(session,"SELECT epoch FROM pos_rewrite_operator_auth_epochs WHERE operator_id=:id FOR SHARE",{'id':scope['actorId']},2)
    actual_epoch=0 if not epoch else int(epoch[0]['epoch'])
    credentials=[actor['username'],actor['email'],actor['password'],bool(actor['is_mfa']),actor['mfa_hash'],
                 actor['phone'],actor['contact_email'],actor['otp_method'],actor['role'],actor['user_type'],
                 bool(actor['is_staff']),bool(actor['is_superuser'])]
    base=hashlib.sha256(json.dumps(credentials,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    version=hashlib.sha256((base+':'+str(actual_epoch)).encode()).hexdigest()
    if version!=authority['actorVersion'] or str(actual_epoch)!=authority['actorEpoch']:
        raise ImportReview('ORDER_IMPORT_AUTHORITY_CHANGED')
    one(session,"SELECT id FROM stores WHERE id=:id AND is_active=1 AND type IN ('STORE','CORE_WAREHOUSE') FOR UPDATE",{'id':scope['storeId']})
    if actor['role']!=1:
        assignment=rows(session,"SELECT id FROM user_stores WHERE django_user_id=:actor AND store_id=:store LIMIT 1 FOR SHARE",{'actor':scope['actorId'],'store':scope['storeId']},2)
        if not assignment:
            raise ImportReview('ORDER_IMPORT_AUTHORITY_CHANGED')
    one(session,"SELECT id FROM store_counters WHERE id=:counter AND store_id=:store AND is_active=1 FOR SHARE",{'counter':scope['counterId'],'store':scope['storeId']})
    customer=one(session,"SELECT *,"+CONTACT+" AS contact_digest FROM users WHERE id=:id FOR UPDATE",{'id':authority['customerId']})
    revision=rows(session,"SELECT revision FROM pos_rewrite_customer_contact_revisions WHERE customer_id=:id FOR SHARE",{'id':authority['customerId']},2)
    if (customer['status']!=1 or customer['is_block'] not in (None,0) or customer['is_disabled'] not in (None,0) or
        customer['contact_digest']!=authority['contact']['digest'] or
        str(0 if not revision else revision[0]['revision'])!=authority['contact']['revision']):
        raise ImportReview('ORDER_IMPORT_AUTHORITY_CHANGED')
    return customer


def native_order(session,order_id,plan,capability,additional=None):
    from correction_profile import effective_tender
    header=one(session,'SELECT orders.*,DATE_FORMAT(created_at,\'%Y-%m-%d %H:%i:%s\') AS recorded_at,'+HEADER+' AS native_hash FROM orders WHERE id=:id FOR UPDATE',{'id':order_id})
    mapping=one(session,'SELECT store_id,counter_id FROM order_stores WHERE order_id=:id FOR UPDATE',{'id':order_id})
    values=rows(session,'SELECT id,prod_id,sub_prod_id,qty,price,'+LINE+' AS native_hash FROM has_products WHERE order_id=:id ORDER BY id FOR UPDATE',{'id':order_id})
    if (str(header['user_id'])!=capability['authority']['customerId'] or header['recorded_at']!=plan['createdAt'] or
        str(mapping['store_id'])!=capability['scope']['storeId'] or str(mapping['counter_id'])!=capability['scope']['counterId'] or
        header['payment_method']!=(14 if plan['kind']=='offline' else 15) or
        header['payment_status']!=(0 if plan['kind']=='offline' else 1) or
        header['order_status']!=(0 if plan['kind']=='offline' else 1) or
        any(header[name] not in (None,0) for name in ('cashback_used','tss_money_used','tss_points_used','voucher_used','voucher_amt_used','coupon_used','parent_order_id','original_order_id'))):
        raise ImportReview('ORDER_IMPORT_NATIVE_SOURCE_MISMATCH')
    additional=additional or []
    if any(row['productId'] in {line['productId'] for line in plan['lines']} or row['quantity']!=1 or row['unitPrice']!='0.00' for row in additional) or len(additional)>1:
        raise ImportReview('ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')
    expected={row['productId']:row for row in [*plan['lines'],*additional]}
    counts={}
    result=[]
    for line in values:
        key=str(line['prod_id'])
        if key not in expected or line['sub_prod_id']!=0 or not 1<=line['qty']<=999 or float(line['price'])!=float(expected[key]['unitPrice'])*line['qty']:
            raise ImportReview('ORDER_IMPORT_CUSTOM_PRICE_MISMATCH')
        counts[key]=counts.get(key,0)+line['qty']
        result.append({'id':str(line['id']),'productId':key,'quantity':line['qty'],'inputHash':line['native_hash']})
    if not result or counts!={key:row['quantity'] for key,row in expected.items()}:
        raise ImportReview('ORDER_IMPORT_NATIVE_LINES_MISMATCH')
    payable=amount(header['pay_amt'])
    if plan['kind']=='offline' and payable!=effective_tender(plan):
        raise ImportReview('ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH')
    line_hash=hashlib.sha256('\n'.join(f"{row['id']}:{row['productId']}:{row['quantity']}:{row['inputHash']}" for row in result).encode()).hexdigest()
    return header,result,line_hash,payable
