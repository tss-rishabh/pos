"""Execute the pinned source AjaxCartView POST through its exact barcode dispatch only.
The model boundary is a recording sentinel: no database, Redis or provider is called.
"""
import ast
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
pin = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == pin
path = root / 'order/views.py'
raw = path.read_bytes()
assert raw == subprocess.check_output(['git', '-C', str(root), 'show', pin + ':order/views.py'])
module = ast.parse(raw)
view = next(item for item in module.body if isinstance(item, ast.ClassDef) and item.name == 'AjaxCartView')
post = next(item for item in view.body if isinstance(item, ast.FunctionDef) and item.name == 'post')
class BoundaryReached(Exception):
    pass
class Recorder:
    query = None
    def filter(self, **query):
        self.query = query
        raise BoundaryReached()
recorder = Recorder()
class ProductBarcode:
    objects = recorder
namespace = {'ProductBarcode': ProductBarcode}
exec(compile(ast.Module(body=[post], type_ignores=[]), str(path), 'exec'), namespace)
cases = [('000222', 0, {'gtin': 222}), ('00_9007199254740993_', 0, {'gtin': 9007199254740993}), ('0', 0, {'product': 0}), ('0000', 0, {'product': 0}), (None, 15, {'product': 15})]
for barcode, product_id, expected in cases:
    request = type('Request', (), {'POST': {'product_id': str(product_id), 'store_id': '2', 'tab_id': '3', 'end_user': '0', 'opr': 'add', 'barcode': barcode}})()
    if barcode is None:
        del request.POST['barcode']
    try:
        namespace['post'](None, request)
        raise AssertionError('Source lookup boundary was not reached')
    except BoundaryReached:
        assert recorder.query == expected
print(json.dumps({'sourceCommit': pin, 'dispatchCasesPassed': len(cases), 'boundary': 'actual-source-post-to-recorded-model-filter', 'databaseUsed': False}))
