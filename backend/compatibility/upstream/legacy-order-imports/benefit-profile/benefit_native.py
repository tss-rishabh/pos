"""Exhaustive native verifier for an authenticated invocation benefit scope.

No rewrite of the original plan, coupon balances, tender, money, stock or hash
inputs occurs here. Ordinary calls retain the original native_order verifier.
"""
import hashlib
import math
from decimal import Decimal
from native import one,rows,HEADER,LINE,native_order as ordinary_native_order
from protocol import amount
from correction_profile import effective_tender
from benefit_source import BenefitReview
from benefit_receipts import money


def native_benefit_order(session,order_id,plan,cap,cart,types,invocation,additional=None,replaced=None):
    if invocation.plan is not plan or invocation.cap is not cap or invocation.cart is not cart:
        raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
    selection=cart.get_item(types.META,{'name':'pos_freebies'})
    selected=selection.get('items',{}) if selection else {}
    coupon=cart.get_item(types.META,{'name':'coupon'})
    controls=invocation.controls
    candidate=controls.candidate
    if not selected and not coupon:
        return ordinary_native_order(session,order_id,plan,cap,additional,replaced)
    if selected and cap.get('benefitContracts',{}).get('complementary')!='pos-csv-pos-complementary-v1':
        raise BenefitReview('ORDER_IMPORT_COMPLEMENTARY_PROFILE_REQUIRED')
    if coupon and (candidate is None or not candidate.applied or candidate.cache.claim is None
                   or str(coupon.get('coupon_id'))!=candidate.scope['couponId']):
        raise BenefitReview('ORDER_IMPORT_UNBOUND_COUPON_META')
    header=one(session,"SELECT orders.*,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS recorded_at,"+HEADER+' AS native_hash FROM orders WHERE id=:id FOR UPDATE',{'id':order_id})
    mapping=one(session,'SELECT store_id,counter_id FROM order_stores WHERE order_id=:id FOR UPDATE',{'id':order_id})
    lines=rows(session,'SELECT id,prod_id,sub_prod_id,qty,price,type,'+LINE+' AS native_hash FROM has_products WHERE order_id=:id ORDER BY id FOR UPDATE',{'id':order_id})
    method=14 if plan['kind']=='offline' else 15
    if (str(header['user_id'])!=cap['authority']['customerId'] or header['recorded_at']!=plan['createdAt']
            or str(mapping['store_id'])!=cap['scope']['storeId'] or str(mapping['counter_id'])!=cap['scope']['counterId']
            or header['payment_method']!=method or header['payment_status']!=(0 if method==14 else 1)
            or header['order_status']!=(0 if method==14 else 1)
            or any(header[name] not in (None,0) for name in ('cashback_used','tss_money_used','tss_points_used','voucher_used','voucher_amt_used','parent_order_id','original_order_id'))):
        raise BenefitReview('ORDER_IMPORT_NATIVE_SOURCE_MISMATCH')
    calc=cart.get_item(types.META,{'name':'calculations'})
    discount=money(calc.get('coupon_discount',0))
    if method==14:
        if (header['coupon_used']!=(int(candidate.scope['couponId']) if coupon else 0)
                or money(header['coupon_amt_used'] or 0)!=(discount if coupon else '0.00')):
            raise BenefitReview('ORDER_IMPORT_NATIVE_SOURCE_MISMATCH')
    elif (header['coupon_used'] not in (None,0) or
          money(header['coupon_amt_used'] or 0)!=(discount if Decimal(plan['discountAmount'])>0 else '0.00')):
        raise BenefitReview('ORDER_IMPORT_NATIVE_SOURCE_MISMATCH')
    expected={line['productId']:dict(line) for line in plan['lines']}
    extras=additional or [];replacements=replaced or []
    if len(extras)>1 or len(replacements)>1 or replacements and len(extras)!=1:
        raise BenefitReview('ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')
    for line in extras:
        if line['productId'] in expected or line['quantity']!=1 or line['unitPrice']!='0.00':
            raise BenefitReview('ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')
        expected[line['productId']]=dict(line)
    for original in replacements:
        if original!=expected.get(original.get('productId')) or original['quantity']!=1 or original['productId'] in selected:
            raise BenefitReview('ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')
        del expected[original['productId']]
    for product_id,count in selected.items():
        if product_id not in expected or type(count) is not int or count!=1:
            raise BenefitReview('ORDER_IMPORT_UNOWNED_COMPLEMENTARY_LINE')
        product=one(session,'SELECT prod_type,price,spl_price FROM products WHERE id=:id FOR SHARE',{'id':product_id})
        if product['prod_type']!=4:raise BenefitReview('ORDER_IMPORT_UNOWNED_COMPLEMENTARY_LINE')
        price=0 if invocation.runtime.line_items else float(product['spl_price'] if product['spl_price']>0 else product['price'])
        expected[product_id]={**expected[product_id],'quantity':1,'nativePrice':price}
    counts={};result=[]
    for line in lines:
        pid=str(line['prod_id']);declared=expected.get(pid)
        if (declared is None or line['sub_prod_id']!=0 or not 1<=line['qty']<=999
                or not math.isfinite(float(line['price']))):raise BenefitReview('ORDER_IMPORT_NATIVE_LINES_MISMATCH')
        if pid in selected:
            if line['qty']!=1 or line['type']!='FREEBIE' or line['price']!=declared['nativePrice']:
                raise BenefitReview('ORDER_IMPORT_FREEBIE_PRICE_MISMATCH')
        elif line['type']=='FREEBIE' or line['price']!=float(declared['unitPrice'])*line['qty']:
            raise BenefitReview('ORDER_IMPORT_CUSTOM_PRICE_MISMATCH')
        counts[pid]=counts.get(pid,0)+line['qty']
        result.append({'id':str(line['id']),'productId':pid,'quantity':line['qty'],'inputHash':line['native_hash']})
    if not result or counts!={pid:line['quantity'] for pid,line in expected.items()}:
        raise BenefitReview('ORDER_IMPORT_NATIVE_LINES_MISMATCH')
    payable=amount(header['pay_amt'])
    if method==14 and payable!=effective_tender(plan):raise BenefitReview('ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH')
    line_hash=hashlib.sha256('\n'.join(f"{line['id']}:{line['productId']}:{line['quantity']}:{line['inputHash']}" for line in result).encode()).hexdigest()
    return header,result,line_hash,payable
