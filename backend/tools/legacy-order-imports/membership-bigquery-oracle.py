"""Pinned source eligibility vs sealed memory replay; stdlib, no DB/network.

Only synthetic fixture facts enter stdin. Source repositories are read-only.
No customer/order IDs, document, key, payload or raw exception is printed.
"""
import ast
from datetime import datetime, timedelta
from enum import IntEnum
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(sys.argv[1]).resolve()
HERE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HERE / 'compatibility/upstream/legacy-order-imports'))
from membership_history import HistorySession, validate, signature

PINS = {
    'controllers/cart/Cart.py': '1f9eff0f1a4ea66f3cac8903d3c1cb9a5b39e2a3babd6dd6c8dcf192de7defd3',
    'constants/StatusEnum.py': '42cb694ff628c61ef8a5ec169a4b319a8c1491ef2a698f93665348e6b22d0a06',
}


def pinned(path):
    raw = (ROOT / path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != PINS[path]:
        raise RuntimeError('Source revision mismatch')
    return ast.parse(raw.decode())


class Result:
    def __init__(self, rows): self.rows = rows
    def fetchone(self): return self.rows[0] if self.rows else None
    def fetchall(self): return list(self.rows)


class NativeFacts:
    """The exact three SELECTs against complete synthetic source facts."""
    def __init__(self, rows, scope):
        self.rows, self.scope, self.calls = rows, scope, []

    def execute(self, statement, params=None, **_kwargs):
        compact = ' '.join(str(statement).split())
        params = params or {}
        if compact == 'SELECT prod_id,is_exclusive_order FROM has_products WHERE order_id = :order_id':
            self.calls.append('lines')
            match = next(row for row in self.rows if row['id'] == str(params['order_id']))
            return Result([{'prod_id': int(row['productId']), 'is_exclusive_order': row['isExclusiveOrder']} for row in match['lines']])
        if compact not in (
            'SELECT id, payment_method, order_status FROM orders WHERE user_id = :user_id AND order_status = 3 ORDER BY created_at DESC LIMIT 1',
            'SELECT id, payment_method, order_status FROM orders WHERE user_id = :user_id AND order_status = 3 AND created_at > :date_before ORDER BY created_at DESC',
        ): raise AssertionError('Unexpected source SELECT')
        if str(params['user_id']) != self.scope['customerId']: raise AssertionError('Wrong source customer')
        delivered = sorted((row for row in self.rows if row['customerId'] == self.scope['customerId'] and row['orderStatus'] == 3), key=lambda row: row['createdAt'], reverse=True)
        if 'date_before' in params:
            if params['date_before'] != self.scope['cutoff']: raise AssertionError('Wrong wall cutoff')
            delivered = [row for row in delivered if row['createdAt'] > params['date_before']]
            self.calls.append('recent')
        else:
            delivered = delivered[:1]
            self.calls.append('last')
        return Result([{'id': int(row['id']), 'payment_method': row['paymentMethod'], 'order_status': row['orderStatus']} for row in delivered])


class NoHistoricalIO:
    def execute(self, *_args, **_kwargs): raise AssertionError('Historical SQL fallback forbidden')


def main():
    payload = json.load(sys.stdin)
    namespace = {'_IntEnum': IntEnum}
    payment = next(node for node in pinned('constants/StatusEnum.py').body if isinstance(node, ast.ClassDef) and node.name == 'PaymentMethod')
    exec(compile(ast.Module(body=[payment], type_ignores=[]), '<pinned-PaymentMethod>', 'exec'), namespace)
    original = next(node for node in pinned('controllers/cart/Cart.py').body if isinstance(node, ast.ClassDef) and node.name == 'AddFreeMembership')
    # The complete actual class is compiled; fixture setup skips unrelated I/O
    # in __init__/process. check_criteria itself is not rewritten or re-created.
    results = []
    for case in payload['cases']:
        scope, document = case['scope'], case['document']
        point = datetime.strptime(scope['asOf'], '%Y-%m-%d %H:%M:%S')
        class Clock:
            @staticmethod
            def now(): return point
        namespace.update(datetime=Clock, timedelta=timedelta, MEMBERSHIP_PROD_ID=payload['memberProductIds'])
        exec(compile(ast.Module(body=[original], type_ignores=[]), '<pinned-AddFreeMembership>', 'exec'), namespace)
        klass = namespace['AddFreeMembership']
        native = NativeFacts(case['all'], scope)
        body = {key: value for key, value in document.items() if key != 'signature'}
        if document['signature'] != signature(body, payload['key']): raise AssertionError('Node/Python HMAC mismatch')
        facts = validate(document, scope, payload['key'], set(payload['memberProductIds']), payload['now'])
        outcomes = []
        for session in (native, HistorySession(NoHistoricalIO(), facts)):
            instance = object.__new__(klass)
            instance.cart_value = case.get('cartValue', 1999)
            instance.user = {'user_id': int(scope['customerId'])}
            instance.session = session
            outcomes.append(instance.check_criteria())
        results.append({'source': outcomes[0], 'memory': outcomes[1], 'same': outcomes[0] == outcomes[1], 'sourceCalls': native.calls})
    print(json.dumps({'cases': results, 'sourcePins': PINS}, separators=(',', ':')))


if __name__ == '__main__':
    try: main()
    except Exception:
        print('{"error":"MEMBERSHIP_SOURCE_ORACLE_FAILED"}')
        sys.exit(1)
