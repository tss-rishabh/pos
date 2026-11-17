"""Temporary, explicit unsupported-source profiles; no financial mutation."""
from decimal import Decimal
from protocol import ImportReview
from correction_profile import CalculatedImportReview,effective_tender


def assert_plain_profile(cart,types,settings,plan,calculations):
    from membership_profile import CONTEXT
    member_context=CONTEXT.get()
    additional=[] if member_context is None else member_context['profile'].admit(cart,types,plan)
    products=cart.get(types.PRODUCTS)
    member_ids={str(value) for value in settings.EXCLUSIVE_PRODUCT}|{str(value) for value in settings.EXCLUSIVE_UPGRADE_PRODUCT}
    if member_context is None and any(str(row['prod_id']) in member_ids for row in products):
        raise ImportReview('ORDER_IMPORT_MEMBERSHIP_PROFILE_REQUIRED')
    if any(str(row['prod_id'])=='390238' for row in products):
        raise ImportReview('ORDER_IMPORT_SCREENING_PROFILE_REQUIRED')
    expected={str(row['productId']):row['quantity'] for row in [*plan['lines'],*additional]}
    if member_context is not None and member_context.get('replacement'):
        # admit() above validates the actual source-removal causality and the
        # unchanged original CSV line before projecting its replacement.
        del expected[member_context['replacement']['originalLine']['productId']]
    actual={}
    for row in products:
        key=str(row['prod_id'])
        actual[key]=actual.get(key,0)+row['quantity']
    if actual!=expected or cart.get(types.GIFT_VOUCHERS) or cart.get(types.COMPLEMENTARY_PRODUCTS):
        raise ImportReview('ORDER_IMPORT_AUTO_BENEFIT_PROFILE_REQUIRED')
    if not calculations or any(Decimal(str(calculations.get(key) or 0))!=0 for key in
        ('used_tss_money','used_tss_points','used_reward_points','gift_voucher_value','coupon_discount','used_pg_discount','used_store_discount_pg')):
        raise ImportReview('ORDER_IMPORT_AUTO_BENEFIT_PROFILE_REQUIRED')
    if plan['kind']=='offline' and Decimal(str(calculations['total']))!=Decimal(effective_tender(plan)):
        raise CalculatedImportReview(calculations['total'])
