"""Run selected pure legacy financial methods without Django imports or network."""
import ast
import datetime
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from types import SimpleNamespace
import sys

ROOT = Path(__file__).resolve().parents[4] / 'backend-pos-web'
PURE = {'_time', 'close_window', 'window_state', 'can_close', 'closeable_date', 'nag_target_date', 'last_expired_date', '_money', 'cash_difference', 'card_difference', 'tolerance'}
source = ROOT / 'report/day_close_services.py'
tree = ast.parse(source.read_text())
scope = {
    'datetime': datetime, 'Decimal': Decimal, 'InvalidOperation': InvalidOperation,
    'FALLBACK_TIME': datetime.time(0, 0), 'EDIT_ROLES': (1, 2, 3), '_UNFETCHED': object(),
    'StoreDayClose': SimpleNamespace(CLOSED='CLOSED'),
    'logger': SimpleNamespace(warning=lambda *a, **kw: None),
    'feature_enabled': lambda user, store: True,
}
exec(compile(ast.fix_missing_locations(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in PURE], type_ignores=[])), str(source), 'exec'), scope)


def policy(case):
    options = case['config']
    for key, value in options.items(): scope[key] = value
    now = datetime.datetime.fromisoformat(case['now'])
    day = datetime.date.fromisoformat(case['date'])
    scope['Helpers'] = SimpleNamespace(now_ist=lambda: now)
    scope['feature_enabled'] = lambda user, store: case['enabled']
    active = case.get('active')
    if active:
        active = SimpleNamespace(**active)
        active.closed_at = datetime.datetime.fromisoformat(active.closed_at)
    allowed, override, message = scope['can_close'](SimpleNamespace(role=case['role']), 1, day, now, active=active)
    target = scope['nag_target_date'](now)
    return {'permission': {'allowed': allowed, 'override': override, 'message': message}, 'state': scope['window_state'](day, now), 'defaultDate': str(scope['closeable_date'](now)), 'nagDate': str(target) if target else None,'lastExpiredDate':str(scope['last_expired_date'](now))}


value = json.load(sys.stdin)
if value['operation'] == 'policy':
    result = [policy(case) for case in value['cases']]
elif value['operation'] == 'money':
    result = []
    for case in value['cases']:
        cash = scope['cash_difference'](*[Decimal(v) for v in case['cash']])
        card = scope['card_difference'](*[Decimal(v) for v in case['card']])
        result.append({'cash': str(scope['_money'](cash)), 'card': str(scope['_money'](card))})
else: raise ValueError('Unknown oracle operation')
json.dump(result, sys.stdout)
