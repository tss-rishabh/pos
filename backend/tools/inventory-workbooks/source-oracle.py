"""Execute pinned workbook tasks with real source openpyxl and isolated I/O.

Only source function/constant ASTs are compiled. Django/Celery/storage/SQL are
in-memory adapters. Literal source filenames are relocated by I/O wrappers, not
by editing function bodies. No source application import or network occurs.
"""
import ast
import base64
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from types import SimpleNamespace

import openpyxl
from openpyxl import Workbook, load_workbook

ROOT = Path(__file__).resolve().parents[4] / 'backend-pos-web'
PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
HASHES = {'report/tasks.py': '2503b163ade622807202b04e91af50233b3d018c648e9aa00779fa6aef84c98a',
          'report/report_queries.py': '6ef32f5c50ca710f32aefeb5f0ecd92462e10a0687f78ad71da1d90e5220cd20',
          'requirements.txt': 'a4c6a9c5fbfa3a65cae9e3426fdd96e1b7f3a291997cb2d45f8389d4e37c572a'}
FIELDS = ['id', 'store_name', 'parent_id', 'child_id', 'product', 'erp_product', 'category', 'variant', 'inventory', 'gtin']
FUNCTIONS = {'process_export_master', 'generate_store_excel_chunk', 'merge_store_chunks', 'merge_all_stores_and_upload', 'debug_print_result', 'get_total_rows_for_store'}


def source(path):
    raw = subprocess.check_output(['git', 'show', PIN + ':' + path], cwd=ROOT)
    if hashlib.sha256(raw).hexdigest() != HASHES[path]:
        raise ValueError('Pinned workbook source changed')
    return raw.decode()


def inspect(data, sample_indices=()):
    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=False)
    result = []
    for sheet in workbook.worksheets:
        rows, samples, last, count, formulas = [], {}, None, 0, 0
        for index, cells in enumerate(sheet.iter_rows()):
            formulas += sum(cell.data_type == 'f' for cell in cells)
            values = [cell.value for cell in cells]
            while len(values) < 9:
                values.append(None)
            values = values[:9]
            for position in (1, 2, 8):
                if values[position] is not None and not isinstance(values[position], str):
                    values[position] = str(values[position])
            if count < 1000:
                rows.append(values)
            if index in sample_indices:
                samples[str(index)] = values
            last, count = values, count + 1
        result.append({'name': sheet.title, 'rows': rows if count <= 1000 else [], 'rowCount': count,
                       'firstRows': rows[:3], 'lastRow': last, 'samples': samples, 'formulaCount': formulas})
    workbook.close()
    return result


def build(request):
    task_source, query_source = source('report/tasks.py'), source('report/report_queries.py')
    source('requirements.txt')
    sql_values = {target.id: ast.literal_eval(node.value) for node in ast.parse(query_source).body if isinstance(node, ast.Assign)
                  for target in node.targets if isinstance(target, ast.Name) and target.id in ('INVENTORY_REPORT_QUERY', 'INVENTORY_ROW_COUNT_QUERY')}
    stores = {str(item['id']): item for item in request['stores']}
    order = request.get('storeOrder', [str(item['id']) for item in request['stores']])
    uploaded, status, paths, chunks = [], [], [], []
    queries = []

    class Cursor:
        description = [(field,) for field in FIELDS]
        values = []
        one = (0,)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, query, args=None):
            queries.append(query)
            if 'count(distinct' in query.lower():
                self.one = (request.get('countOverride', 987654321),)
            elif args:
                item = stores[str(args[0])]
                self.values = [(int(value),) for value in item.get('candidateIds', [row['id'] for row in item['rows']])]
                self.values.sort(key=lambda row: row[0])
            else:
                store_id = re.search(r'AND s.id = (\d+)', query).group(1)
                selected = {int(value) for value in re.search(r'AND p.id IN \(([^)]*)\)', query).group(1).split(',')}
                values = []
                for item in stores[store_id]['rows']:
                    if int(item['id']) not in selected:
                        continue
                    row = dict(item)
                    for key in ('id', 'parent_id', 'child_id', 'inventory', 'gtin'):
                        if row.get(key) is not None:
                            row[key] = int(row[key])
                    values.append(tuple(row.get(field) for field in FIELDS))
                self.values = sorted(values, key=lambda row: row[0])

        def fetchall(self):
            return self.values

        def fetchone(self):
            return self.one

    class Signature:
        def __init__(self, task, args):
            self.task, self.args = task, args

        def run(self, prefix=()):
            return self.task(*prefix, *self.args)

    class Task:
        def __init__(self, function):
            self.function = function

        def __call__(self, *args, **kwargs):
            return self.function(*args, **kwargs)

        def s(self, *args):
            if self.function.__name__ == 'generate_store_excel_chunk':
                chunks.append({'storeId': str(args[0]), 'ids': len(args[1]), 'ordinal': args[2]})
            return Signature(self, args)

    class Chord:
        def __init__(self, header, body):
            self.header, self.body = header, body

        def run(self):
            return self.body.run(([item.run() for item in self.header],))

        def apply_async(self):
            return self.run()

    with tempfile.TemporaryDirectory(prefix='pos-source-workbook-') as temporary:
        def scoped(path):
            if not isinstance(path, str) or not path.startswith('/tmp/temp_exports/'):
                raise ValueError('Source oracle refuses unexpected filesystem paths')
            return str(Path(temporary) / path.rsplit('/', 1)[-1])

        class ScopedWorkbook(Workbook):
            def save(self, filename):
                if isinstance(filename, str):
                    paths.append(filename)
                    filename = scoped(filename)
                return super().save(filename)

        def upload(key, data, content_type):
            uploaded.append({'key': key, 'bytes': data, 'contentType': content_type})

        record = SimpleNamespace(id=1, report_name='Fixture workbook', report_type='INVENTORY', message='', export_requested_by=1, export_requested_at=datetime.datetime(2026, 6, 15, 12))
        class Records:
            def exists(self):
                return True

            def __getitem__(self, _index):
                return record

        scope = {'shared_task': Task, 'group': list, 'chord': Chord, 'Workbook': ScopedWorkbook,
                 'load_workbook': lambda path, **kwargs: load_workbook(scoped(path), **kwargs),
                 'os': SimpleNamespace(makedirs=lambda _path, **_kwargs: None, remove=lambda path: os.remove(scoped(path)), path=SimpleNamespace(join=os.path.join, exists=lambda path: os.path.exists(scoped(path)))),
                 'io': io, 'SimpleNamespace': SimpleNamespace, 'READ_DB_ALIAS': 'reader',
                 'connections': {'reader': SimpleNamespace(cursor=Cursor)}, 'connection': SimpleNamespace(close=lambda: None),
                 'logger': SimpleNamespace(info=lambda *_args: None, warning=lambda *_args: None, exception=lambda *_args: None),
                 'ReportExport': SimpleNamespace(objects=SimpleNamespace(filter=lambda **_kwargs: Records())),
                 'timezone': SimpleNamespace(now=lambda: datetime.datetime(2026, 6, 15, 12)),
                 'storage': SimpleNamespace(upload=upload),
                 'Helpers': SimpleNamespace(create_update_report_export=lambda **kwargs: status.append(kwargs)), **sql_values}
        nodes = [node for node in ast.parse(task_source).body if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), '<pinned-workbook-tasks>', 'exec'), scope)
        scope['process_export_master']({'selected_store_id_list': order}, 1)
        data = uploaded[0]['bytes'] if uploaded else None
        return {'sourceCommit': PIN, 'openpyxl': openpyxl.__version__, 'sourceHashes': HASHES,
                'chunkArguments': chunks, 'paths': paths, 'queries': len(queries),
                'artifactBase64': base64.b64encode(data).decode() if data else None,
                'sheets': inspect(data, request.get('sampleIndices', [])) if data else [],
                'declaredRows': status[-1]['export_rows_count'] if status else None,
                'declaredStatus': status[-1]['export_status'] if status else None,
                'contentType': uploaded[0]['contentType'] if uploaded else None}


def main():
    if openpyxl.__version__ != '3.1.2':
        raise ValueError('Source workbook oracle requires pinned openpyxl3.1.2')
    request = json.load(sys.stdin)
    if request.get('action') == 'queries':
        values = {target.id: ast.literal_eval(node.value) for node in ast.parse(source('report/report_queries.py')).body if isinstance(node, ast.Assign) for target in node.targets if isinstance(target, ast.Name) and target.id == 'INVENTORY_REPORT_QUERY'}
        result = {'rows': values['INVENTORY_REPORT_QUERY'], 'sourceHashes': HASHES}
    elif request.get('action') == 'inspect':
        result = {'sheets': inspect(base64.b64decode(request['artifactBase64']), request.get('sampleIndices', []))}
    else:
        result = build(request)
    json.dump(result, sys.stdout, ensure_ascii=True, allow_nan=False, default=str)


if __name__ == '__main__':
    main()
