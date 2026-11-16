"""Execute pinned create_order bodies against in-memory captors; no Django or I/O."""
import ast
import datetime
import hashlib
import json
import math
from pathlib import Path
import random
import sys
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[4] / 'backend-pos-web/helpers/task_helpers.py'
EXPECTED = 'ee9053da7d0a90b145bdeb0c669e846014d7e664cae8939d76aa2db051351d60'


class QuietLogger:
    def exception(self, *_args, **_kwargs):
        pass

    error = exception


def run(kind, group):
    source = SOURCE.read_bytes()
    if hashlib.sha256(source).hexdigest() != EXPECTED:
        raise ValueError('SOURCE_SNAPSHOT_CHANGED')
    name = 'OfflineOrderPunchInParseCSV' if kind == 'offline' else 'ShopifyOrderPunchInParseCSV'
    original = next(node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == name)
    methods = [node for node in original.body if isinstance(node, ast.FunctionDef)
               and node.name in {'create_order', 'check_date', 'check_convert_date'}]
    isolated = ast.Module(body=[ast.ClassDef(name=name, bases=[], keywords=[], body=methods,
                                           decorator_list=[])], type_ignores=[])
    ast.fix_missing_locations(isolated)
    calls = []

    def capture(event, args, kwargs):
        calls.append(json.loads(json.dumps({'event': event, 'args': args, 'kwargs': kwargs})))

    class Response:
        status_code = 200

        def json(self):
            return {'order': 101, 'method': 'fixture', 'isValid': True, 'name': 'fixture'}

    def recorder(event):
        def action(_self, *args, **kwargs):
            capture(event, args, kwargs)
            return Response()
        return action

    def complete_order(*args, **kwargs):
        capture('complete', args, kwargs)

    def cart(_self, *args, **kwargs):
        capture('cart', args, kwargs)
        return {'fixture': True}

    class Objects:
        def filter(self, **kwargs):
            return self

        def first(self):
            return SimpleNamespace(id=555, gtin='1234567890123', order_ref_no='fixture-ref')

    namespace = {
        'datetime': datetime, 'math': math, 'random': random, 'logger': QuietLogger(),
        'pytz': SimpleNamespace(timezone=lambda _name: datetime.timezone(datetime.timedelta(hours=5, minutes=30))),
        'ProductBarcode': SimpleNamespace(objects=Objects()),
        'MUser': SimpleNamespace(objects=Objects()), 'Order': SimpleNamespace(objects=Objects()),
        'Helpers': SimpleNamespace(complete_order=complete_order, create_token=lambda _id: ['fixture-auth'],
                                   push_order_kinesis=lambda order: capture('publish', [order], {})),
        'AjaxCartView': SimpleNamespace(add_to_cart=recorder('add')),
        'CreateOrderView': SimpleNamespace(get_user_cart=cart),
        'AjaxValidateProcessOrderView': SimpleNamespace(validatecheckout=recorder('validate'), processorder=recorder('process')),
        'AjaxOrderView': SimpleNamespace(order=recorder('order'), orders=recorder('confirm')),
        'tasks': SimpleNamespace(send_sms=SimpleNamespace(delay=lambda order: capture('sms', [order], {}))),
    }
    exec(compile(isolated, 'pinned-import-order', 'exec'), namespace)
    instance = object.__new__(namespace[name])
    instance.user_id = 7
    instance.store_id = int(group['order_details'][0]['store_id'])
    instance.stores_list = [instance.store_id]
    instance.user_stores_list = [instance.store_id]
    instance.role_id = 1
    instance.main_failed_records_list = []
    instance.fetch_user = lambda _email: 'fixture-auth'
    instance.reduce_stock = lambda lines, store: capture('stock', [lines, store], {})
    instance.create_order(group)
    return {'calls': calls, 'failureCount': len(instance.main_failed_records_list)}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    print(json.dumps(run(request['kind'], request['group'])))
