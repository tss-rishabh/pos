"""Run pinned GET/helper with fixture metadata and clock; no DB/provider calls."""
import ast
import datetime
import json
import pathlib
import subprocess
import sys
root = pathlib.Path(sys.argv[1])
assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
helpers = ast.parse((root / 'helpers/helpers.py').read_text())
views = ast.parse((root / 'report/views.py').read_text())
helper = next(n for cls in helpers.body if isinstance(cls, ast.ClassDef) and cls.name == 'Helpers' for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'get_days_before_after_datetime')
view = next(n for n in views.body if isinstance(n, ast.ClassDef) and n.name == 'DailyStoreReportView')
class Rows:
    def using(self, *_): return self
    def filter(self, **_): return self
    def __len__(self): return 1
    def __getitem__(self, _): return type('StoreRow', (), {'id': 1})()
class Model:
    objects = Rows()
results = []
for stamp in ['2026-11-18T12:00:00', '2026-11-18T23:58:59', '2026-11-18T23:59:00', '2026-12-31T23:59:59', '2026-03-01T00:00:00']:
    now = datetime.datetime.fromisoformat(stamp)
    class Clock(datetime.datetime):
        @classmethod
        def now(cls): return now
    namespace = {'method_decorator': lambda *_args, **_kwargs: lambda cls: cls, 'day_close_enabled_required': object(), 'datetime': type('DateModule', (), {'datetime': Clock, 'timedelta': datetime.timedelta}), 'Store': Model, 'UserStore': Model, 'READ_DB_ALIAS': 'fixture', 'LoginRequiredMixin': type('Login', (), {}), 'View': type('View', (), {}), 'render': lambda _request, _name, context: context}
    helper_class = ast.ClassDef(name='Helpers', bases=[], keywords=[], body=[helper], decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[helper_class, view], type_ignores=[])), '<pinned-daily-get>', 'exec'), namespace)
    instance = namespace['DailyStoreReportView']()
    instance.request = type('Request', (), {'user': type('User', (), {'role': 1})()})()
    context = instance.get(instance.request)
    results.append({'at': stamp + '+05:30', 'range': context['order_date_range'].strip(), 'selected': context['selected_stores']})
print(json.dumps(results))
