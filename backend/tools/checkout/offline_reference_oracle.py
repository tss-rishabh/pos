"""Execute the pinned pure MOBILE reference generator with deterministic draws."""
import ast
import hashlib
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get('SOURCE_TSS_API_ROOT', ROOT.parent.parent / 'backend-tss-api_v2')) / 'libs/OrderRef.py'
data = SOURCE.read_bytes()
if hashlib.sha256(data).hexdigest() != 'c7b5c0caecce15b8ffae43bd35ed76a43b3541515895d378ad80e3f52ee7c066':
    raise RuntimeError('Pinned source order reference changed.')
selected = [node for node in ast.parse(data).body if isinstance(node, ast.ClassDef) and node.name == 'UniqueOrderRefNo']
results = []
for vector in json.load(sys.stdin):
    draws = iter([vector['prefix'], vector['last']])
    namespace = {'random': SimpleNamespace(randint=lambda _a, _b: next(draws)), 'logger': SimpleNamespace(error=lambda *_args: None)}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), namespace)
    results.append(namespace['UniqueOrderRefNo'].generateOrderRefNo('MOBILE', vector['orderId']))
json.dump(results, sys.stdout)
