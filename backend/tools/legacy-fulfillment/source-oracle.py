"""Run only pinned old status/packing/RTO method ASTs with inert ORM adapters.

The RTO oracle deliberately retains the old repeat and wrong-split behavior so
tests can distinguish preserved normal behavior from the approved correction.
"""
import ast
import asyncio
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import sys

source = Path(__file__).resolve().parents[4] / 'backend-pos-web'
text = subprocess.check_output(['git', '-C', str(source), 'show', '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:order/views.py'], text=True)
tree = ast.parse(text)
classes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}

def method(class_name, method_name, scope):
    original = next(node for node in classes[class_name].body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == method_name)
    original.decorator_list = []
    exec(compile(ast.fix_missing_locations(ast.Module(body=[original], type_ignores=[])), '<pinned-legacy-fulfillment>', 'exec'), scope)
    return scope[method_name]

def cancelled_webhook(case):
    """Execute the real cancellation method with an inert successful refund."""
    class Query:
        def __init__(self, rows):
            self.rows = rows
        def __bool__(self):
            return bool(self.rows)
        def __iter__(self):
            return iter(self.rows)
        def first(self):
            return self.rows[0] if self.rows else None
        def update(self, **values):
            for row in self.rows:
                for key, value in values.items():
                    setattr(row, key, value)
        def filter(self, **filters):
            def matches(row, key, value):
                parts = key.split('__')
                many = parts[-1] == 'in'
                if many:
                    parts = parts[:-1]
                for part in parts:
                    row = getattr(row, part)
                return str(row) in [str(item) for item in value] if many else str(row) == str(value)
            return Query([row for row in self.rows if all(matches(row, key, value) for key, value in filters.items())])
    stocks = [SimpleNamespace(**row, save=lambda: None) for row in case['stocks']]
    lines = [SimpleNamespace(order_id=1, qty=int(row['quantity']), product=SimpleNamespace(id=row['productId']), status='DELIVERED', order_platform=SimpleNamespace(id=int(row['platform']))) for row in case['lines']]
    order = SimpleNamespace(id=1, location_type='SW', location_id=1, user=SimpleNamespace(id=1, email='fixture@example.test'), is_split_order=case.get('split', False))
    log = SimpleNamespace(order_id=1, is_refunded=0, action='ACCEPTED', is_created_in_borzo=1)
    effects, transactions = [], []
    def synchronize(store, ids, after, **_kwargs):
        before = next(row.stock for row in stocks if str(row.product_id) == str(ids[0]) and str(row.store_id) == str(store))
        effects.append({'storeId': str(store), 'productId': str(ids[0]), 'before': before, 'after': after})
    scope = {
        'Order': SimpleNamespace(objects=Query([order])),
        'HyperlocalOrderLog': SimpleNamespace(objects=Query([log])),
        'OrderStatus': SimpleNamespace(objects=Query([SimpleNamespace(id=4, order_status='CANCELLED')])),
        'HasProduct': SimpleNamespace(objects=Query(lines)),
        'ProductStore': SimpleNamespace(objects=Query(stocks)),
        'Helpers': SimpleNamespace(hl_order_cancel_refund=lambda *_args, **_kwargs: SimpleNamespace(status_code=200), transaction_logger=lambda *args: transactions.append(args), cancel_transaction_logger=lambda *_args: None, sync_pos_inventory=synchronize, sync_pos_product=lambda _ids: None),
    }
    outcome = method('AjaxHlOrderView', 'cancel', scope)(SimpleNamespace(), 'RTO-intransit', 1, 0, platform='webhook')
    return {'outcome': outcome, 'action': log.action, 'transactions': transactions, 'effects': effects, 'stocks': [{'productId': str(row.product_id), 'stock': row.stock} for row in stocks]}

results = []
for case in json.load(sys.stdin):
    if case['kind'] == 'cancel-webhook':
        results.append(cancelled_webhook(case))
        continue
    if case['kind'] == 'status':
        log = SimpleNamespace(**case['log']) if case['log'] else None
        async def check(_order):
            return log
        body = SimpleNamespace(check_hl_status=check)
        function = method('AjaxCheckOrderStatusView', 'post', {'JsonResponse': lambda value: value})
        results.append(asyncio.run(function(body, SimpleNamespace(POST={'order_id': 1}))))
        continue
    flags = {'is_pack': 0, 'rto_recieved': 0}
    transactions, effects = [], []
    class Query:
        def __init__(self, rows):
            self.rows = rows
        def __bool__(self):
            return bool(self.rows)
        def __iter__(self):
            return iter(self.rows)
        def first(self):
            return self.rows[0] if self.rows else None
        def update(self, **values):
            flags.update(values)
        def filter(self, **filters):
            return Query([row for row in self.rows if all(str(getattr(row, key)) == str(value) for key, value in filters.items())])
    stocks = [SimpleNamespace(**row, save=lambda: None) for row in case.get('stocks', [])]
    products = [SimpleNamespace(qty=int(row['quantity']), product=SimpleNamespace(id=row['productId'])) for row in case.get('lines', [])]
    def synchronize(store, ids, after, **kwargs):
        before = next(row.stock for row in stocks if str(row.product_id) == str(ids[0]) and str(row.store_id) == str(store))
        effects.append({'storeId': str(store), 'productId': str(ids[0]), 'before': before, 'after': after, 'type': kwargs['type']})
    scope = {
        'HyperlocalOrderLog': SimpleNamespace(objects=Query([SimpleNamespace(order_id=1)])),
        'Order': SimpleNamespace(objects=Query([SimpleNamespace(id=1, location_type='SW', location_id=1)])),
        'HasProduct': SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: Query(products))),
        'ProductStore': SimpleNamespace(objects=Query(stocks)),
        'Helpers': SimpleNamespace(transaction_logger=lambda *args: transactions.append(args), sync_pos_inventory=synchronize, sync_pos_product=lambda ids: None),
    }
    body = SimpleNamespace(request=SimpleNamespace(user=SimpleNamespace(id=44, first_name=case['firstName'])))
    if case['kind'] == 'packing':
        method('AjaxOrderPackView', 'txn_logger', scope)(body, 1, case['note'])
    else:
        logger = method('AjaxRtoRecievedView', 'txn_logger', scope)
        inward = method('AjaxRtoRecievedView', 'inventory_inward', scope)
        for _ in range(case.get('repeat', 1)):
            logger(body, 1, case['note'])
            inward(body, 1)
    results.append({'flags': flags, 'transactions': transactions, 'effects': effects, 'stocks': [{'productId': str(row.product_id), 'stock': row.stock} for row in stocks]})
json.dump(results, sys.stdout, ensure_ascii=True)
