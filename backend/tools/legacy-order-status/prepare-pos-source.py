"""Commit only the pinned callback/helper/task fragments for portable source tests."""
import ast
import hashlib
import json
import os
import pathlib
import subprocess

pin = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
root = pathlib.Path(os.environ.get('WHOLE_ORDER_STATUS_SOURCE_ROOT', '../../backend-pos-web'))
selection = {'order/views.py': ['AjaxUpdateStatusVincView'],
             'helpers/helpers.py': ['call_status_api'], 'core/tasks.py': ['push_vinc_order_for_all']}
fragments, hashes = {}, {}
for path, names in selection.items():
    original = subprocess.check_output(['git', '-C', str(root), 'show', pin + ':' + path], stderr=subprocess.DEVNULL)
    source = original.decode()
    tree = ast.parse(source)
    fragments[path] = {}
    hashes[path] = hashlib.sha256(original).hexdigest()
    for name in names:
        node = next(node for node in ast.walk(tree) if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name == name)
        start = min([node.lineno] + [decorator.lineno for decorator in node.decorator_list])
        fragments[path][name] = '\n'.join(source.splitlines()[start - 1:node.end_lineno]) + '\n'
destination = pathlib.Path('compatibility/upstream/whole-order-status/pos-source.json')
destination.write_text(json.dumps({'pin': pin, 'sourceSha256': hashes, 'fragments': fragments}, indent=2) + '\n')
print(json.dumps({'resource': 'whole-order-status-pos-source', 'prepared': True, 'fragments': 3}))
