"""Execute selected pure legacy methods in isolation; never import Django or touch a DB."""
import ast
import json
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3] / 'backend-pos-web'


def selected_class(file, class_name, names):
    tree = ast.parse((ROOT / file).read_text())
    original = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name)
    node = ast.ClassDef(name=class_name, bases=[], keywords=[], body=[n for n in original.body if isinstance(n, ast.FunctionDef) and n.name in names], decorator_list=[])
    module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
    return compile(module, str(ROOT / file), 'exec')


def report(value):
    scope = {}
    exec(selected_class('report/datatables/daily_store_report.py', 'AjaxDailyStoreReportView', ['_num', '_combine', '_merge_rows', '_sum', '_totals']), scope)
    instance = scope['AjaxDailyStoreReportView']()
    aux = value['aux']
    def mapping(key, numeric_key=False):
        result = {}
        for k, v in aux[key].items():
            a, b = k.split('\x00')
            result[(int(a) if numeric_key else a, b)] = v
        return result
    rows = instance._merge_rows([SimpleNamespace(**r) for r in value['store']], [SimpleNamespace(**r) for r in value['online']], mapping('footfall'), mapping('target'), mapping('banking', True))
    return {'rows': rows, 'totals': instance._totals(rows)}


def payloads(value):
    results = []
    scope = {'MIGRATION_TO_API_V2': True, 'MAIN_API_V2_URL': 'https://api.example.test/', 'API_V2_URL': 'https://old.example.test/', 'requests': SimpleNamespace(post=lambda url, **kwargs: {'path': url.split('.test/')[1], 'payload': kwargs['json']})}
    exec(selected_class('order/views.py', 'AjaxCartView', ['add_to_cart', 'set_to_cart', 'delete_from_cart']), scope)
    exec(selected_class('order/views.py', 'AjaxValidateProcessOrderView', ['validatecheckout', 'processorder']), scope)
    cart = scope['AjaxCartView']()
    checkout = scope['AjaxValidateProcessOrderView']()
    for end_user in (False, True):
        results.append(cart.add_to_cart('fixture-token', 1001, 1, '8900000001001', 2, end_user, None))
        results.append(cart.set_to_cart('fixture-token', 1001, 1, 2, 3, end_user))
        results.append(cart.delete_from_cart('fixture-token', 1001, 1, 2, 'products', 0, end_user))
        results.append(cart.delete_from_cart('fixture-token', 1001, 1, 2, 'products', 12, end_user))
        results.append(checkout.validatecheckout('fixture-token', 1, 2, end_user))
        results.append(checkout.processorder('fixture-token', 1, 2, {'products': {'items': []}}, end_user))
    return results


if __name__ == '__main__':
    value = json.load(sys.stdin)
    operation = value['operation']
    if operation == 'reports': result = [report(item) for item in value['cases']]
    elif operation == 'payloads': result = payloads(value)
    elif operation == 'round': result = [round(v, 2) for v in value['values']]
    else: raise ValueError('Unsupported oracle operation')
    json.dump(result, sys.stdout, allow_nan=False)
