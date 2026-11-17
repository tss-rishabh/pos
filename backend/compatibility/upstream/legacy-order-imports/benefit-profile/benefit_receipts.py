"""Native evidence capture AFTER actual source order/approved per-HP refunds.

No synthetic HP/grant IDs, no source-order writes, no wallet spending. The
caller persists these descriptors in its existing source receipt transaction.
"""
import hmac
import json
from decimal import Decimal
from sqlalchemy import text
from benefit_source import BenefitReview
from benefit_history import canonical, seal

COUPON_USERS = "LOWER(SHA2(CAST(JSON_OBJECT('id',coupons_users.id,'coupon_id',coupons_users.c_id,'customer_id',coupons_users.user_id,'allowed',coupons_users.coupon_allowed_count,'used',coupons_users.coupon_used_count,'monthly_allowed',coupons_users.coupon_month_allowed_count) AS CHAR CHARACTER SET utf8mb4),256))"
COUPON_LOG = "LOWER(SHA2(CAST(JSON_OBJECT('id',order_coupon_log.id,'user_id',order_coupon_log.user_id,'order_id',order_coupon_log.order_id,'coupon_id',order_coupon_log.coupon_id,'status',order_coupon_log.status,'created_at',DATE_FORMAT(order_coupon_log.created_at,'%Y-%m-%d %H:%i:%s'),'updated_at',DATE_FORMAT(order_coupon_log.updated_at,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))"
GRANT = "LOWER(SHA2(CAST(JSON_OBJECT('id',order_freebies.id,'order_id',order_freebies.order_id,'has_product_id',order_freebies.has_product_id,'freebie_prod_id',order_freebies.freebie_prod_id,'freebie_id',order_freebies.freebie_id,'freebie_sale_id',order_freebies.freebie_sale_id,'grant_level',order_freebies.grant_level,'trigger_id',order_freebies.trigger_id,'trigger_key',order_freebies.trigger_key,'mov',order_freebies.mov,'qualified_value',order_freebies.qualified_value,'is_exclusive_order',order_freebies.is_exclusive_order,'base_field',order_freebies.base_field,'status',order_freebies.status,'revoked_at',DATE_FORMAT(order_freebies.revoked_at,'%Y-%m-%d %H:%i:%s'),'revoke_reason',order_freebies.revoke_reason,'created_at',DATE_FORMAT(order_freebies.created_at,'%Y-%m-%d %H:%i:%s'),'updated_at',DATE_FORMAT(order_freebies.updated_at,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))"
REFUND = "LOWER(SHA2(CAST(JSON_OBJECT('id',has_products.id,'disc',has_products.disc,'refundable',has_products.amount_to_be_refunded) AS CHAR CHARACTER SET utf8mb4),256))"
PRODUCT = "LOWER(SHA2(CAST(JSON_OBJECT('id',products.id,'type',products.prod_type,'price',products.price,'special_price',products.spl_price) AS CHAR CHARACTER SET utf8mb4),256))"
COUPON_CONTROL = "LOWER(SHA2(CAST(JSON_OBJECT('id',coupons.id,'voucher_type',coupons.voucher_type,'disc_apply_items',coupons.disc_apply_items,'min_order_amt',coupons.min_order_amt,'voucher_code',coupons.voucher_code,'voucher_val',coupons.voucher_val,'voucher_valid_for',coupons.voucher_valid_for,'platform',coupons.platform,'voucher_percentage_max_val',coupons.voucher_percentage_max_val,'for_new_user',coupons.for_new_user,'user_specific',coupons.user_specific,'buyable_quantity',coupons.buyable_quantity,'free_quantity',coupons.free_quantity,'is_applicable_on_discounted_products',coupons.is_applicable_on_discounted_products,'voucher_mxn_type',coupons.voucher_mxn_type,'no_times_allowed',coupons.no_times_allowed,'coupon_lot_no',coupons.coupon_lot_no,'unique_no_times_allowed',coupons.unique_no_times_allowed,'message',coupons.message,'user_type',coupons.user_type,'default_country_id',coupons.default_country_id,'is_deleted',coupons.is_deleted,'start_date',DATE_FORMAT(coupons.start_date,'%Y-%m-%d %H:%i:%s'),'end_date',DATE_FORMAT(coupons.end_date,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))"
REFUND_PATCH = 'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11'


def rows(session, query, params, maximum=1000):
    result = session.execute(text(query), params)
    values = [dict(row) for row in result.mappings().fetchmany(maximum+1)]
    result.close()
    if len(values) > maximum: raise BenefitReview('ORDER_IMPORT_BENEFIT_RESULT_TOO_LARGE')
    return values


def money(value):
    number = Decimal(str(value))
    if not number.is_finite() or number < 0 or number > Decimal('9999999999.99') or number != number.quantize(Decimal('.01')):
        raise BenefitReview('ORDER_IMPORT_BENEFIT_AMOUNT_INVALID')
    return format(number, '.2f')


def authority_hash(authority, key):
    return seal('authority',authority,key)


def scope(state, order, as_of, key):
    return {'operationId': state['scope']['operationId'], 'requestHash': state['requestHash'],
        'planHash': state['planHash'], 'actorId': state['scope']['actorId'],
        'authorityHash': authority_hash(state['authority'], key), 'namespace': state['namespace'],
        'orderId': order['orderId'], 'customerId': state['authority']['customerId'],
        'storeId': state['scope']['storeId'], 'counterId': state['scope']['counterId'],
        'method': order['method'], 'sourceCommit': '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
        'headerHash': order['headerHash'], 'lineHash': order['lineHash'], 'asOf': as_of}


def coupon_users(session, customer_id, coupon_id):
    values = rows(session, 'SELECT id,coupon_allowed_count,coupon_used_count,coupon_month_allowed_count,'+COUPON_USERS+' AS native_hash FROM coupons_users WHERE user_id=:customer AND c_id=:coupon ORDER BY id FOR UPDATE',
        {'customer': customer_id, 'coupon': coupon_id})
    return [{'id': str(row['id']), 'allowed': str(row['coupon_allowed_count']),
        'used': str(row['coupon_used_count']), 'monthlyAllowed': str(row['coupon_month_allowed_count']),
        'inputHash': row['native_hash']} for row in values]


def current_coupon_control(session,coupon_id):
    if not 0<int(coupon_id)<=2147483647:raise BenefitReview()
    query = 'SELECT id AS coupon_id,id,voucher_type AS type,disc_apply_items AS min_quantity,min_order_amt AS min_amount,voucher_code,voucher_val AS discount,voucher_valid_for AS valid_for,platform,voucher_percentage_max_val,for_new_user,user_specific,buyable_quantity,free_quantity,is_applicable_on_discounted_products,voucher_mxn_type,no_times_allowed,coupon_lot_no,message,'+COUPON_CONTROL+' AS native_hash FROM coupons WHERE id=:id FOR SHARE'
    values = rows(session,query,{'id':coupon_id},1)
    if len(values)!=1:raise BenefitReview('ORDER_IMPORT_COUPON_CONFIGURATION_CHANGED')
    return values[0]


def current_coupon_assignments(session,customer_id,coupon_id):
    return rows(session,'SELECT id,c_id,user_id,coupon_used_count,coupon_allowed_count,coupon_month_allowed_count FROM coupons_users WHERE user_id=:customer AND c_id=:coupon ORDER BY id LIMIT 1001 FOR SHARE',
        {'customer':customer_id,'coupon':coupon_id})


def complementary_receipt(session, state, plan, order, selection_meta, as_of, key):
    selected = selection_meta.get('items') if isinstance(selection_meta, dict) else None
    if not isinstance(selected, dict) or not selected or any(type(qty) is not int or qty != 1 for qty in selected.values()):
        raise BenefitReview()
    declarations = {line['productId']: line for line in plan['lines']}
    if len(declarations) != len(plan['lines']) or not set(selected) <= set(declarations): raise BenefitReview()
    grants = rows(session, 'SELECT *,'+GRANT+' AS native_hash FROM order_freebies WHERE order_id=:order ORDER BY id FOR UPDATE', {'order': order['orderId']})
    triggers = rows(session, 'SELECT id FROM order_freebie_triggers WHERE order_id=:order LIMIT 1 FOR UPDATE', {'order': order['orderId']}, 1)
    if len(grants) != len(selected) or triggers: raise BenefitReview()
    selections = []
    for product_id in sorted(selected, key=int):
        declared = declarations[product_id]
        actual = [line for line in order['lines'] if line['productId'] == product_id]
        products = rows(session, 'SELECT id,prod_type,price,spl_price,'+PRODUCT+' AS native_hash FROM products WHERE id=:id FOR SHARE', {'id': product_id}, 1)
        hp = rows(session, 'SELECT id,prod_id,qty,price,type,CAST(CAST(amount_to_be_refunded AS DECIMAL(12,2)) AS CHAR) AS refundable,'+REFUND+' AS refund_hash FROM has_products WHERE order_id=:order AND prod_id=:product ORDER BY id FOR UPDATE',
            {'order': order['orderId'], 'product': product_id}, 2)
        if len(actual) != 1 or len(hp) != 1 or actual[0]['quantity'] != 1 or len(products) != 1 or products[0]['prod_type'] != 4:
            raise BenefitReview()
        line = hp[0]
        base_price = products[0]['spl_price'] if products[0]['spl_price'] > 0 else products[0]['price']
        # PosFreebieWrapper explicitly converts the DECIMAL catalog fields to
        # float before the pinned DOUBLE HP constructor.
        expected_price = 0 if order['lineItemsEnabled'] else float(base_price)
        if line['price'] != expected_price:
            raise BenefitReview('ORDER_IMPORT_FREEBIE_PRICE_MISMATCH')
        if str(line['id']) != actual[0]['id'] or line['qty'] != 1 or line['type'] != 'FREEBIE' or (order['lineItemsEnabled'] and line['refundable'] != '0.00'):
            raise BenefitReview()
        matching = [row for row in grants if str(row['has_product_id']) == actual[0]['id']]
        if len(matching) != 1: raise BenefitReview()
        grant = matching[0]
        if (str(grant['freebie_prod_id']) != product_id or any(grant[n] != 0 for n in ('freebie_id','freebie_sale_id','trigger_id','mov','is_exclusive_order')) or
            Decimal(str(grant['qualified_value'])) != 0 or grant['grant_level'] != 'POS_MANUAL' or grant['trigger_key'] != 'pos_manual:0' or
            grant['status'] != 'ACTIVE' or any(grant[n] is not None for n in ('base_field','revoked_at','revoke_reason'))): raise BenefitReview()
        selections.append({'productId': product_id, 'declaredQuantity': declared['quantity'], 'declaredUnitPrice': declared['unitPrice'],
            'sourceRows': declared['sourceRows'], 'productInputHash': products[0]['native_hash'],
            'catalogBasePrice': money(base_price), 'priceRule': 'source-zero-per-unit' if order['lineItemsEnabled'] else 'source-base-aggregate',
            'line': {**actual[0], 'price': money(line['price']), 'type': 'FREEBIE', 'refundable': line['refundable'], 'refundInputHash': line['refund_hash']},
            'grant': {'id': str(grant['id']), 'inputHash': grant['native_hash'], 'level': 'POS_MANUAL', 'triggerKey': 'pos_manual:0',
                      'status': 'ACTIVE', 'triggerCount': 0}})
    receipt = {'contract': 'pos-csv-pos-complementary-v1', 'scope': scope(state, order, as_of, key),
               'origin': 'original-csv-pos-selection', 'selections': selections, 'additionalLines': []}
    return receipt, seal('complementary', receipt, key)


def coupon_receipt(session, state, plan, order, cart, types, history, claim, users_before, key):
    meta = cart.get_item(types.META, {'name':'coupon'})
    calculations = cart.get_item(types.META, {'name':'calculations'})
    if not meta or not calculations or not claim: raise BenefitReview()
    coupon_id = str(meta['coupon_id'])
    controls = rows(session,'SELECT '+COUPON_CONTROL+' AS hash FROM coupons WHERE id=:id FOR UPDATE',{'id':coupon_id},1)
    if len(controls)!=1:raise BenefitReview()
    if coupon_id != history['scope']['couponId'] or claim['scope'] != history['scope']:
        raise BenefitReview()
    if not hmac.compare_digest(seal('birthday-claim', {k:v for k,v in claim.items() if k != 'receiptHash'}, key), claim['receiptHash']):
        raise BenefitReview()
    header = rows(session, 'SELECT coupon_used,CAST(CAST(coupon_amt_used AS DECIMAL(12,2)) AS CHAR) AS coupon_amount FROM orders WHERE id=:order FOR UPDATE', {'order': order['orderId']}, 1)
    if len(header) != 1: raise BenefitReview()
    lines = rows(session, 'SELECT id,prod_id,CAST(CAST(disc AS DECIMAL(12,2)) AS CHAR) AS discount,CAST(CAST(amount_to_be_refunded AS DECIMAL(12,2)) AS CHAR) AS refundable,'+REFUND+' AS refund_hash FROM has_products WHERE order_id=:order ORDER BY id FOR UPDATE', {'order': order['orderId']})
    actual = {line['id']:line for line in order['lines']}
    if len(actual) != len(lines): raise BenefitReview()
    allocations = []
    for line in lines:
        reference = actual.get(str(line['id']))
        if not reference or reference['productId'] != str(line['prod_id']): raise BenefitReview()
        allocations.append({**reference, 'discount': line['discount'], 'refundable': line['refundable'], 'refundInputHash': line['refund_hash']})
    recorded = header[0]
    receipt = {'contract': 'pos-csv-automatic-coupon-v1', 'scope': scope(state, order, history['scope']['asOf'], key),
        'trigger': 'automatic-birthday', 'couponId': coupon_id, 'configurationHash': history['scope']['configurationHash'],
        'couponInputHash': controls[0]['hash'],
        'history': {'generationId': history['generationId'], 'documentHash': history['signature'],
                    'scopeHash': seal('coupon-history-scope', history['scope'], key)},
        'birthdayClaim': {n:claim[n] for n in ('id','keyHash','receiptHash','expiresAt')},
        'cartCouponDiscount': money(calculations['coupon_discount']),
        'headerCouponId': str(recorded['coupon_used']) if recorded['coupon_used'] else None,
        'headerCouponAmount': recorded['coupon_amount'],
        'consumption': 'offline-go-confirmation' if plan['kind']=='offline' else 'shopify-none',
        'couponUsersBefore': users_before, 'allocations': allocations,
        'refundAllocationContract': 'pos-refund-per-hp-v1', 'refundSourcePatchHash': REFUND_PATCH}
    if (receipt['scope']['method'] == 14 and (receipt['headerCouponId'] != coupon_id or receipt['headerCouponAmount'] != receipt['cartCouponDiscount'])) or (receipt['scope']['method'] == 15 and receipt['headerCouponId'] is not None):
        raise BenefitReview()
    return receipt, seal('coupon', receipt, key)


def coupon_consumption_receipt(session, staged, staged_hash, confirmation_hash, key):
    """Called around the actual Go deduction, not a second deduction.

    This Python equivalent is executable native evidence tooling; the Go worker
    must produce the SAME descriptor inside its existing confirmation TX.
    """
    if staged['scope']['method'] != 14 or staged['consumption'] != 'offline-go-confirmation' or not hmac.compare_digest(seal('coupon', staged, key), staged_hash):
        raise BenefitReview()
    after = coupon_users(session, staged['scope']['customerId'], staged['couponId'])
    before = {row['id']:row for row in staged['couponUsersBefore']}
    if len(after) != len(before): raise BenefitReview()
    changes = []
    for row in after:
        old = before.get(row['id'])
        if not old or int(row['used']) != int(old['used'])+1 or row['allowed'] != old['allowed'] or row['monthlyAllowed'] != old['monthlyAllowed']:
            raise BenefitReview()
        changes.append({'id': row['id'], 'before': old['used'], 'after': row['used'], 'inputHash': row['inputHash']})
    logs = rows(session, 'SELECT *,'+COUPON_LOG+' AS native_hash FROM order_coupon_log WHERE order_id=:order ORDER BY id FOR UPDATE', {'order': staged['scope']['orderId']}, 2)
    if len(logs) != 1 or str(logs[0]['user_id']) != staged['scope']['customerId'] or str(logs[0]['coupon_id']) != staged['couponId'] or logs[0]['status'] != 1:
        raise BenefitReview()
    receipt = {'contract': 'pos-csv-coupon-consumption-v1', 'scope': staged['scope'],
        'stagedReceiptHash': staged_hash, 'couponId': staged['couponId'], 'sourceConfirmationHash': confirmation_hash,
        'changes': changes, 'log': {'id': str(logs[0]['id']), 'inputHash': logs[0]['native_hash'], 'status': 1}}
    return receipt, seal('coupon-consumption', receipt, key)


def store_descriptor(session, state, kind, receipt, key, now_ms):
    """Immutable side receipt under the existing original command row lock.
    The caller's source transaction owns all HP/grant/coupon writes; replay reads
    this first and never re-runs them. Never open a nested transaction here.
    """
    purposes={'coupon-benefit':'coupon','pos-complement':'complementary','coupon-consume':'coupon-consumption'}
    if kind not in purposes or len(canonical(receipt).encode()) > 500000:
        raise BenefitReview()
    scoped=receipt.get('scope',{})
    expected={'operationId':state['scope']['operationId'],'requestHash':state['requestHash'],'planHash':state['planHash'],
        'actorId':state['scope']['actorId'],'storeId':state['scope']['storeId'],'counterId':state['scope']['counterId'],
        'namespace':state['namespace'],'customerId':state['authority']['customerId'],'authorityHash':authority_hash(state['authority'],key)}
    if any(scoped.get(name)!=value for name,value in expected.items()): raise BenefitReview()
    proof=seal(purposes[kind],receipt,key)
    existing=rows(session,'SELECT request_hash,status,proof,proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:operation AND kind=:kind FOR UPDATE',
        {'operation':state['scope']['operationId'],'kind':kind},1)
    if existing:
        row=existing[0];old=json.loads(row['proof']) if isinstance(row['proof'],str) else row['proof']
        if row['request_hash']!=state['requestHash'] or row['status']!='completed' or canonical(old)!=canonical(receipt) or not hmac.compare_digest(row['proof_hash'],proof):
            raise BenefitReview('ORDER_IMPORT_BENEFIT_RECEIPT_CONFLICT')
        return proof
    session.execute(text('INSERT INTO pos_rewrite_import_financial_source_receipts (id,operation_id,kind,request_hash,status,proof,proof_hash,created_at_ms) VALUES (:id,:operation,:kind,:request,:status,:proof,:hash,:created)'),
        {'id':state['scope']['operationId']+':'+kind,'operation':state['scope']['operationId'],'kind':kind,
         'request':state['requestHash'],'status':'completed','proof':canonical(receipt),'hash':proof,'created':now_ms})
    return proof
