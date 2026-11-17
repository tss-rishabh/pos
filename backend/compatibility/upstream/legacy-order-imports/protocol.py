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


def verify_capability(key, supplied, operation_id, phase, plan=None, now_ms=None):
    expected = {'contract','phase','operationId','requestHash','planHash','namespace','planDigest',
                'scope','authority','orderId','nonce','issuedAt','expiresAt','signature'}
    if not isinstance(supplied, dict) or set(supplied) not in (expected,expected|{'correctionHash'}):
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
    if 'correctionHash' in supplied and (phase!='order' or not isinstance(supplied['correctionHash'],str) or not re.fullmatch(r'[a-f0-9]{64}',supplied['correctionHash'])):
        raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
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
    return supplied


def amount(value):
    number = Decimal(str(value))
    if not number.is_finite() or number < 0 or number > Decimal('9999999999.99') or number * 100 != (number * 100).to_integral_value():
        raise ImportReview('ORDER_IMPORT_AMOUNT_REVIEW')
    return format(number, '.2f')


def source_custom_data(plan):
    value = {'price': {row['productId']: float(row['unitPrice']) for row in plan['lines']}}
    if plan['kind'] == 'shopify':
        value.update(tax=float(plan['legacyTaxDigit']), shipping_charges=float(plan['shippingCharges']),
                     is_shopify_order=1, currency=plan['currency'], discount_amount=float(plan['discountAmount']),
                     address=plan['address'])
    return value
