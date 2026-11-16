"""Read-only literal source membership staging and cancellation vectors.

Only AST-extracted bodies execute, using transient objects. No source imports,
network, databases, initialization or generated inputs are used.
"""
import ast
import copy
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

COMMIT = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
ROOT = Path(__file__).resolve().parents[4] / 'backend-tss-api_v2'
source = subprocess.check_output(['git', 'show', COMMIT + ':controllers/user/userDal.py'], cwd=ROOT, text=True)
controller = subprocess.check_output(['git', 'show', COMMIT + ':controllers/OrderController.py'], cwd=ROOT, text=True)
names = {'set_exclusive_expiry', 'set_exclusive_upgrade_expiry', 'set_exclusive_user', 'set_exclusive_upgrade_user'}
functions = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name in names]
if len(functions) != len(names):
    raise RuntimeError('Pinned membership helper changed')
cls = next(node for node in ast.parse(controller).body if isinstance(node, ast.ClassDef) and node.name == 'CancelPosorder')
member_if = next(node for node in ast.walk(cls) if isinstance(node, ast.If) and 'EXCLUSIVE_UPGRADE_PRODUCT' in ast.unparse(node.test))
cancel = ast.FunctionDef(name='cancel_membership', args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=n) for n in ['session', 'user', 'prodId']], kwonlyargs=[], kw_defaults=[], defaults=[]), body=[member_if], decorator_list=[])
code = compile(ast.fix_missing_locations(ast.Module(body=functions+[cancel], type_ignores=[])), '<pinned-membership>', 'exec')
class Field:
    def __init__(self, name): self.name = name
    def __eq__(self, value): return (self.name, value)
    def __hash__(self): return hash(self.name)
class User:
    id = Field('id')
class Eav:
    entity, attribute, is_active, value, updated_at = [Field(n) for n in ['entity', 'attribute', 'is_active', 'value', 'updated_at']]
    def __init__(self, **values): self.__dict__.update(values)
class FixedDateTime(datetime.datetime):
    @classmethod
    def now(cls): return cls(2026, 11, 17, 12, 0, 0)
attrs = SimpleNamespace(EXCLUSIVE_MEMBER='EXCLUSIVE_MEMBER', EXCLUSIVE_EXPIRY='EXCLUSIVE_EXPIRY')
email = 'synthetic@example.test'
def run(upgrade, before, activate=False):
    rows = {row['attribute']: Eav(entity=email, **copy.deepcopy(row)) for row in before}
    state = {'commits': 0}
    class Query:
        def __init__(self, kind): self.kind, self.conditions = kind, []
        def filter(self, *conditions): self.conditions.extend(conditions); return self
        def selected(self): return [row for row in rows.values() if all(getattr(row, name, None) == value for name, value in self.conditions)]
        def first(self): return SimpleNamespace(email=email) if self.kind is User else next(iter(self.selected()), None)
        def update(self, values):
            for row in self.selected():
                for field, value in values.items(): setattr(row, field.name, value)
    class Session:
        def query(self, kind): return Query(kind)
        def add(self, row): rows[row.attribute] = row
        def commit(self): state['commits'] += 1
    namespace = {'datetime': SimpleNamespace(datetime=FixedDateTime, timedelta=datetime.timedelta), 'User': User, 'UserEAV': Eav, 'Attributes': attrs, 'ensure_user_email': lambda _session, user: user.email, 'cache': SimpleNamespace(region_invalidate=lambda *args: None), 'get_exclusive_token': object(), 'settings': SimpleNamespace(EXCLUSIVE_PRODUCT={'10': {}}, EXCLUSIVE_UPGRADE_PRODUCT={'11': {}})}
    exec(code, namespace)
    session = Session()
    namespace['set_exclusive_upgrade_user' if upgrade else 'set_exclusive_user'](session, {'user_id': 777, 'email': email}, 365)
    if activate:
        for row in rows.values(): row.is_active = 1
    def snapshot():
        return [{key: str(value) if isinstance(value, datetime.datetime) else value for key, value in vars(row).items() if key != 'entity'} for _, row in sorted(rows.items())]
    staged = snapshot()
    namespace['datetime'] = FixedDateTime
    namespace['cancel_membership'](session, {'user_id': 777}, 11 if upgrade else 10)
    return {'staged': staged, 'originalCancelled': snapshot(), **state}
initial = [{'attribute': 'EXCLUSIVE_MEMBER', 'value': '1', 'is_active': 1, 'created_at': '2025-01-01 00:00:00', 'updated_at': '2025-01-01 00:00:00'}, {'attribute': 'EXCLUSIVE_EXPIRY', 'value': '2027-01-01T00:00:00', 'is_active': 1, 'created_at': '2025-01-01 00:00:00', 'updated_at': '2025-01-01 00:00:00'}]
print(json.dumps({'sourceCommit': COMMIT, 'sourceHashes': {'userDal': hashlib.sha256(source.encode()).hexdigest(), 'controller': hashlib.sha256(controller.encode()).hexdigest()}, 'cases': [{'name': 'new-pending', 'before': [], **run(False, [])}, {'name': 'new-activated', 'before': [], **run(False, [], True)}, {'name': 'upgrade-existing', 'before': initial, **run(True, initial)}]}))
