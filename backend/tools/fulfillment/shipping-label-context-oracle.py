"""Run the pinned label handler against inert source-query result adapters.

Inputs are synthetic rows selected by the local native test. `awb_empty` comes
from native MySQL equality, retaining the physical PAD SPACE collation.
"""
import ast
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import sys

source = Path(__file__).resolve().parents[4] / 'backend-pos-web'
text = subprocess.check_output(['git', '-C', str(source), 'show', '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:order/views.py'], text=True)
handler = next(n for n in ast.parse(text).body if isinstance(n, ast.ClassDef) and n.name == 'ShowOnlineOrderShippingView')
methods = [n for n in handler.body if isinstance(n, ast.FunctionDef) and n.name in ['get', '_get_shipping_address']]
definition = ast.ClassDef(name='PinnedLabel', bases=[], keywords=[], body=methods, decorator_list=[])
results = []
for case in json.load(sys.stdin):
    class Values:
        def __init__(self, rows):
            self.rows = rows
        def __iter__(self):
            return iter(self.rows)
        def first(self):
            return self.rows[0] if self.rows else None
    class Rows:
        def __init__(self, rows):
            self.rows = rows
        def __iter__(self):
            return iter(self.rows)
        def filter(self, **filters):
            rows = self.rows
            for field, value in filters.items():
                if field == 'id__in':
                    eligible = {str(item) for item in value if item is not None}
                    rows = [row for row in rows if str(row.id) in eligible]
                else:
                    rows = [row for row in rows if str(getattr(row, field)) == str(value)]
            return Rows(rows)
        def exclude(self, **filters):
            if filters != {'awb': ''}:
                raise ValueError('Unexpected source exclusion.')
            return Rows([row for row in self.rows if not row.awb_empty])
        def values_list(self, field, flat=False):
            if not flat:
                raise ValueError('Unexpected source projection.')
            return Values([getattr(row, field) for row in sorted(self.rows, key=lambda row: int(getattr(row, 'id', 0)))])
        def first(self):
            rows = sorted(self.rows, key=lambda row: int(getattr(row, 'id', 0)))
            return rows[0] if rows else None
    class Cursor:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def execute(self, query, values):
            if 'FROM orders o' not in query or str(values[0]) != str(case['order_id']):
                raise ValueError('Unexpected source address request.')
        def fetchone(self):
            return case['address']
    def model(rows, quantity=False):
        values = [SimpleNamespace(**row) for row in rows]
        if quantity:
            for row in values:
                row.qty = int(row.qty)
                row.awb_empty = bool(int(row.awb_empty))
        return SimpleNamespace(objects=Rows(values))
    scope = {
        'Order': model(case['orders']),
        'Store': model(case['stores']),
        'ExpressLineItem': model(case['lines']),
        'HasProduct': model(case['products'], quantity=True),
        'connections': {'default': SimpleNamespace(cursor=lambda: Cursor())},
        'HttpResponse': lambda message, status: {'error': message, 'status': status},
        'render': lambda request, template, context: context,
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=[definition], type_ignores=[])), '<pinned-shipping-context>', 'exec'), scope)
    result = scope['PinnedLabel']().get(SimpleNamespace(GET={'store_id': case['store_id']}), case['order_id'])
    if 'total_qty' in result:
        # Python integers are converted explicitly so JSON decoding cannot round them.
        result['total_qty'] = str(result['total_qty'])
        result['awb'] = str(result['awb'])
        result['order_id'] = str(result['order_id'])
    results.append(result)
json.dump(results, sys.stdout, ensure_ascii=True)
