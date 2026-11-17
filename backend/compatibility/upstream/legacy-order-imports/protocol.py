"""Private CSV scope/receipt codecs. No source app, I/O, or logger is imported."""
import hashlib
import hmac
import json
import re
import time
from decimal import Decimal
from uuid import UUID

SOURCE_CONTRACT = 'pos-legacy-order-import-source-v1'
PUBLICATION_CONTRACT = 'pos-legacy-order-import-publication-v1'
SOURCE_COMMIT = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
PREPARATION_CONTRACT = 'pos-import-order-preparation-v1'


class ImportReview(RuntimeError):
    def __init__(self, code='ORDER_IMPORT_SOURCE_REVIEW'):
        if not re.fullmatch(r'ORDER_IMPORT_[A-Z0-9_]{1,45}', code):
            code = 'ORDER_IMPORT_SOURCE_REVIEW'
        self.code = code
        super().__init__('The original import needs reconciliation.')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(key, kind, value):
    if not isinstance(key, str) or not re.fullmatch(r'[!-~]{32,4096}', key):
        raise ImportReview('ORDER_IMPORT_KEY_UNAVAILABLE')
    payload = '{"kind":' + json.dumps('legacy-order-imports.source.' + kind + '.v1') + ',"input":' + canonical(value) + '}'
    return hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def uuid(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID') from None
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,18}', value) or int(value) > 9223372036854775807:
        raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
    return value


def verify_benefit_contracts(value):
    allowed={'automaticCoupon':'pos-csv-automatic-coupon-v1','complementary':'pos-csv-pos-complementary-v1'}
    if (not isinstance(value,dict) or not value or set(value)-set(allowed)
            or any(value[name]!=allowed[name] for name in value)):
        raise ImportReview('ORDER_IMPORT_BENEFIT_CONFIGURATION_REQUIRED')
    return value


def verify_capability(key, supplied, operation_id, phase, plan=None, now_ms=None):
    expected = {'contract','phase','operationId','requestHash','planHash','namespace','planDigest',
                'scope','authority','orderId','nonce','issuedAt','expiresAt','signature'}
    optional={'succession','correctionHash','membershipHistoryHash','preparationContract','couponHistoryHash','benefitContracts'}
    if (not isinstance(supplied, dict) or not expected.issubset(supplied)
            or set(supplied)-expected-optional):
        raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
    value = {k:v for k,v in supplied.items() if k != 'signature'}
    current = int(time.time() * 1000) if now_ms is None else now_ms
    if (not isinstance(supplied['signature'], str) or not hmac.compare_digest(digest(key,'capability',value), supplied['signature']) or
        supplied['contract'] != SOURCE_CONTRACT or supplied['phase'] != phase or
        supplied['operationId'] != uuid(operation_id) or uuid(supplied['nonce']) != supplied['nonce'] or
        supplied['namespace'] != 'pos-import-v1:' + operation_id or
        type(supplied['issuedAt']) is not int or type(supplied['expiresAt']) is not int or
        not supplied['issuedAt'] <= current < supplied['expiresAt'] <= supplied['issuedAt'] + 60000):
        raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
    scope = supplied['scope']
    for name in ('correctionHash','membershipHistoryHash','couponHistoryHash'):
        if name in supplied and (phase!='order' or not isinstance(supplied[name],str) or not re.fullmatch(r'[a-f0-9]{64}',supplied[name])):
            raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
    if 'preparationContract' in supplied and (phase!='order' or supplied['preparationContract']!=PREPARATION_CONTRACT):
        raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
    if 'benefitContracts' in supplied:
        if phase!='order':raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
        verify_benefit_contracts(supplied['benefitContracts'])
    if not isinstance(scope,dict) or set(scope) != {'actorId','operationId','storeId','counterId'} or scope['operationId'] != operation_id:
        raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
    for name in ('actorId','storeId','counterId'):
        identifier(scope[name])
    for name in ('requestHash','planHash','planDigest'):
        if not isinstance(supplied[name],str) or not re.fullmatch(r'[a-f0-9]{64}',supplied[name]):
            raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
    if plan is not None and not hmac.compare_digest(supplied['planDigest'],digest(key,'plan',plan)):
        raise ImportReview('ORDER_IMPORT_PLAN_CHANGED')
    if phase != 'order':
        identifier(supplied['orderId'])
    elif supplied['orderId'] is not None:
        raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
    from authority_succession import verify_envelope
    verify_envelope(key,supplied,phase,current)
    return supplied


def amount(value):
    number = Decimal(str(value))
    if not number.is_finite() or number < 0 or number > Decimal('9999999999.99') or number * 100 != (number * 100).to_integral_value():
        raise ImportReview('ORDER_IMPORT_AMOUNT_REVIEW')
    return format(number, '.2f')


def verify_preparation(key,supplied,operation_id,plan,now_ms):
    """A preview capability cannot be used as an order-stage capability."""
    expected={'contract','purpose','operationId','attemptId','requestHash','planHash','namespace',
              'planDigest','authorityHash','scope','authority','issuedAt','expiresAt',
              'attemptExpiresAt','signature'}
    if (not isinstance(supplied,dict) or not expected.issubset(supplied)
            or set(supplied)-expected-{'membershipHistoryHash','couponHistoryHash','benefitContracts'}):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    value={name:item for name,item in supplied.items() if name!='signature'}
    if (supplied['contract']!=PREPARATION_CONTRACT or supplied['purpose']!='source-cart-preview'
            or supplied['operationId']!=uuid(operation_id) or uuid(supplied['attemptId'])!=supplied['attemptId']
            or supplied['namespace']!='pos-import-v1:'+operation_id
            or type(now_ms) is not int or type(supplied['issuedAt']) is not int
            or type(supplied['expiresAt']) is not int or type(supplied['attemptExpiresAt']) is not int
            or not supplied['issuedAt']<=now_ms<supplied['expiresAt']<=min(supplied['attemptExpiresAt'],supplied['issuedAt']+60000)
            or not isinstance(supplied['signature'],str)
            or not hmac.compare_digest(digest(key,'preparation-capability',value),supplied['signature'])):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    scope=supplied['scope']
    if not isinstance(scope,dict) or set(scope)!={'actorId','operationId','storeId','counterId'} or scope['operationId']!=operation_id:
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    for name in ('actorId','storeId','counterId'):identifier(scope[name])
    for name in ('requestHash','planHash','planDigest','authorityHash'):
        if not isinstance(supplied[name],str) or not re.fullmatch(r'[a-f0-9]{64}',supplied[name]):
            raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    for name in ('membershipHistoryHash','couponHistoryHash'):
        if name in supplied and (not isinstance(supplied[name],str) or not re.fullmatch(r'[a-f0-9]{64}',supplied[name])):
            raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    if 'benefitContracts' in supplied:verify_benefit_contracts(supplied['benefitContracts'])
    if not isinstance(plan,dict) or not hmac.compare_digest(supplied['planDigest'],digest(key,'plan',plan)):
        raise ImportReview('ORDER_IMPORT_PLAN_CHANGED')
    if (not isinstance(supplied['authority'],dict) or set(supplied['authority'])!=
            {'customerId','contact','actorVersion','actorEpoch','approvalId','close'}):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    identifier(supplied['authority']['customerId'])
    return supplied


def source_custom_data(plan):
    value = {'price': {row['productId']: float(row['unitPrice']) for row in plan['lines']}}
    if plan['kind'] == 'shopify':
        value.update(tax=float(plan['legacyTaxDigit']), shipping_charges=float(plan['shippingCharges']),
                     is_shopify_order=1, currency=plan['currency'], discount_amount=float(plan['discountAmount']),
                     address=plan['address'])
    return value
