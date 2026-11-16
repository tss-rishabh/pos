"""Execute only the pinned shipping-address method with an inert DB cursor.

No Django runtime, credentials, network operation or live database is involved.
"""
import ast
import json
from pathlib import Path
import subprocess
import sys

SOURCE = Path(__file__).resolve().parents[4] / 'backend-pos-web'
BASELINE = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
text = subprocess.check_output(['git', '-C', str(SOURCE), 'show', BASELINE + ':order/views.py'], text=True)
tree = ast.parse(text)
handler = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'ShowOnlineOrderShippingView')
method = next(node for node in handler.body if isinstance(node, ast.FunctionDef) and node.name == '_get_shipping_address')
query = next(node.value for node in ast.walk(method) if isinstance(node, ast.Constant) and isinstance(node.value, str) and 'FROM orders o' in node.value)
inputs = json.load(sys.stdin)
result = []
for row in inputs:
    class Cursor:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def execute(self, statement, values):
            if statement != query or values != [1]:
                raise ValueError('Unexpected source cursor request.')
        def fetchone(self):
            return row
    class Connection:
        def cursor(self):
            return Cursor()
    class Body:
        pass
    scope = {'connections': {'default': Connection()}}
    code = ast.Module(body=[method], type_ignores=[])
    exec(compile(ast.fix_missing_locations(code), '<pinned-shipping-address>', 'exec'), scope)
    result.append(scope['_get_shipping_address'](Body(), 1))
json.dump({'query':query,'addresses':result}, sys.stdout, ensure_ascii=True)
