"""Execute only pinned CSV grouping/date bodies with synthetic in-memory I/O."""
import ast
import csv
import datetime
import hashlib
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[4] / 'backend-pos-web/helpers/task_helpers.py'
EXPECTED = 'ee9053da7d0a90b145bdeb0c669e846014d7e664cae8939d76aa2db051351d60'


class QuietLogger:
    def exception(self, *_args, **_kwargs):
        pass

    error = exception


def run(kind, text, store_id):
    source = SOURCE.read_bytes()
    if hashlib.sha256(source).hexdigest() != EXPECTED:
        raise ValueError('SOURCE_SNAPSHOT_CHANGED')
    name = 'OfflineOrderPunchInParseCSV' if kind == 'offline' else 'ShopifyOrderPunchInParseCSV'
    method = 'offline_order_punchin_bulk_csv_import' if kind == 'offline' else 'shopify_order_punchin_bulk_csv_import'
    tree = ast.parse(source)
    original = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)
    selected = [node for node in original.body if isinstance(node, ast.FunctionDef) and node.name in {method, 'check_date'}]
    isolated = ast.Module(body=[ast.ClassDef(name=name, bases=[], keywords=[], body=selected, decorator_list=[])], type_ignores=[])
    ast.fix_missing_locations(isolated)
    namespace = {
        'csv': csv, 'json': json, 'datetime': datetime, 'logger': QuietLogger(),
        'urllib': SimpleNamespace(request=SimpleNamespace(urlopen=lambda _url: io.BytesIO(text.encode('utf-8')))),
    }
    exec(compile(isolated, str(SOURCE), 'exec'), namespace)
    instance = object.__new__(namespace[name])
    instance.upload_obj = SimpleNamespace(filename=SimpleNamespace(url='fixture://csv'), save=lambda: None)
    instance.store_id = store_id
    instance.main_failed_records_list = []
    groups = []

    def capture(group):
        # This is the first access in each literal create_order method.
        group['order_details'][0]
        groups.append(json.loads(json.dumps(group)))

    instance.create_order = capture
    getattr(instance, method)()
    return {'groups': groups, 'failureCount': len(instance.main_failed_records_list)}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    print(json.dumps(run(request['kind'], request['csv'], request.get('storeId', '1'))))
