"""Read-only execution of the pinned Django extension date/upsert leaf."""
import ast
import datetime
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

root = Path(sys.argv[1]).resolve(strict=True)
pin = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
raw = subprocess.check_output(['git', 'show', pin + ':order/views.py'], cwd=root).decode()
node = next(item for item in ast.parse(raw).body if isinstance(item, ast.ClassDef) and item.name == 'AjaxExtendReturnView')
# Execute the literal leaf with inert Django class decorators, not a server/auth claim.
node.decorator_list = []
records = []
class Query:
    def __init__(self, matches): self.matches = matches
    def __bool__(self): return bool(self.matches)
    def first(self): return self.matches[0] if self.matches else None
    def update(self, **values):
        for row in self.matches: row.update(values)
class ActorManager:
    def filter(self, **_values): return Query([SimpleNamespace(id=88)])
class ExtensionManager:
    def filter(self, **values): return Query([row for row in records if all(row.get(key) == value for key, value in values.items())])
    def create(self, **values): records.append(values)
class LoginRequiredMixin: pass
class View: pass
namespace = {'LoginRequiredMixin': LoginRequiredMixin, 'View': View, 'datetime': datetime,
             'MUser': SimpleNamespace(objects=ActorManager()),
             'ExtendApplicabilityForReturnExchange': SimpleNamespace(objects=ExtensionManager()),
             'HttpResponse': lambda value, **_options: json.loads(value), 'json': json}
exec(compile(ast.Module(body=[node], type_ignores=[]), '<pinned-return-window-leaf>', 'exec'), namespace)
handler = namespace['AjaxExtendReturnView']()
handler.request = SimpleNamespace(user=SimpleNamespace(id=1))
def invoke(date):
    return handler.post(SimpleNamespace(POST={'order_id': '100', 'product_id': '123', 'has_product_id': '1000', 'extended_date': date}))
invoke('12/20/2026')
created = dict(records[0])
records[0]['is_active'] = 0
invoke('11/18/2026')
updated = dict(records[0])
refused_clear = False
try: invoke('')
except ValueError: refused_clear = True
for value in (created, updated): value['extended_date'] = value['extended_date'].strftime('%Y-%m-%d %H:%M:%S')
print(json.dumps({'pin': pin, 'line': node.lineno, 'created': created, 'updated': updated, 'rows': len(records), 'emptyDateRefused': refused_clear}, separators=(',', ':')))
