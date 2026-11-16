"""Run pinned original global-benefit POST methods with an in-memory SQL intent recorder.

No Django imports, network, SQL connection, live user data or source mutations occur.
Recorded SQL is ONLY for controlled isolated fixtures, never production execution.
"""
import ast
import datetime
import functools
import hashlib
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[4] / 'backend-pos-web/core/views.py'
SOURCE_SHA256 = '20f9910156aa3c427df759bdd26f4d19992a91f0a1ea1df915fa98eb3b2de349'
PATCH = Path(__file__).resolve().parents[2] / 'compatibility/upstream/global-benefits/wallet-correction.patch'
CLASSES = {'money': 'AjaxTssMoneyView', 'points': 'AjaxAjaxTssPointsView', 'voucher': 'AjaxGiftVoucherModuleView'}


def apply_candidate(source):
    patch = PATCH.read_text()
    manifest = json.loads((PATCH.parent / 'manifest.json').read_text())
    if (manifest['sourceSha256'] != SOURCE_SHA256 or
            manifest['patchSha256'] != hashlib.sha256(patch.encode()).hexdigest()):
        raise ValueError('Pinned benefit candidate manifest does not match')
    groups = re.split(r'^@@[^\n]*\n', patch, flags=re.MULTILINE)[1:]
    for group in groups:
        old, new = [], []
        for line in group.splitlines(keepends=True):
            if line.startswith((' ', '-')):
                old.append(line[1:])
            if line.startswith((' ', '+')):
                new.append(line[1:])
        before, after = ''.join(old), ''.join(new)
        if not before or source.count(before) != 1:
            raise ValueError('Pinned benefit candidate context does not match')
        source = source.replace(before, after, 1)
    if hashlib.sha256(source.encode()).hexdigest() != manifest['candidateSha256']:
        raise ValueError('Pinned benefit candidate output does not match')
    return source


@functools.lru_cache(maxsize=3)
def selected(source, class_name):
    original = next(node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == class_name)
    node = ast.ClassDef(name=class_name, bases=[], keywords=[], body=[value for value in original.body if isinstance(value, ast.FunctionDef) and value.name in ('post', 'dictfetchall')], decorator_list=[])
    return compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(SOURCE), 'exec')


def execute(case, source):
    asset = case['asset']
    now = datetime.datetime.strptime(case.get('at', '2026-11-16 10:00:00'), '%Y-%m-%d %H:%M:%S')

    class FrozenClock(datetime.datetime):
        @classmethod
        def now(cls):
            return now

    queries, activities = [], []
    histories = [dict(value) for value in case.get('histories', [])]
    history_fields = ['id', 'added_amt', 'used_amt', 'is_expired', 'created_at']

    class Cursor:
        description = None
        rows = []
        one = None

        def execute(self, query):
            queries.append(query.strip())
            normalized = ' '.join(query.split()).lower()
            if normalized.startswith('select * from tss_'):
                self.description = [(key,) for key in history_fields]
                values = [value for value in histories if value.get('is_expired', 0) == 0 and value['added_amt'] > 0]
                values.sort(key=lambda value: value.get('created_at', '2026-01-01 00:00:00'))
                self.rows = [tuple(value.get(key, 0 if key == 'is_expired' else '2026-01-01 00:00:00') for key in history_fields) for value in values]
            elif normalized.startswith('update tss_'):
                matched = re.search(r"set used_amt = '([^']+)' where id = (\d+)", query)
                if matched:
                    value, history_id = matched.groups()
                    next(item for item in histories if int(item['id']) == int(history_id))['used_amt'] = float(value)
            elif normalized.startswith('select id from tss.coupons'):
                self.one = (101,)
            elif normalized.startswith('select id from gift_vouchers'):
                self.one = (201,)

        def fetchall(self):
            return self.rows

        def fetchone(self):
            return self.one

    balances = case.get('balances', {})
    customer = SimpleNamespace(id=9007199254740993, firstname='Fixture', lastname='Customer', email='fixture@example.test', tss_money=float(balances.get('money', 100)), tss_points=float(balances.get('points', 100)), cashback=float(balances.get('cashback', 7)))
    data = {
        'opr': case.get('operation', 1), 'tss_money': case.get('amount', '1'),
        'email_m': customer.email, 'platform': case.get('platform', 'ORDER_REFUND'),
        'reason': case.get('reason', 'Other'), 'expiry': case.get('expiry', '12/31/2026'),
        'order_id': case.get('orderId', 0), 'product_id': case.get('productId', 0),
        'opr_p': case.get('operation', 1), 'tss_points': case.get('amount', '1'),
        'email_p': customer.email, 'platform_p': case.get('platform', 'ORDER_REFUND'),
        'reason_p': case.get('reason', 'Other'), 'expiry_p': case.get('expiry', '12/31/2026'),
        'order_id_p': case.get('orderId', 0), 'product_id_p': case.get('productId', 0),
        'email': customer.email, 'gift_amount': case.get('amount', '1'),
    }
    scope = {
        'json': json,
        'datetime': SimpleNamespace(datetime=FrozenClock),
        'random': SimpleNamespace(randint=lambda _start, _end: 7),
        'MUser': SimpleNamespace(objects=SimpleNamespace(filter=lambda **_kwargs: SimpleNamespace(first=lambda: customer if case.get('exists', True) else None))),
        'connections': {'mysql_db': SimpleNamespace(cursor=Cursor)},
        'HttpResponse': lambda body, **_kwargs: json.loads(body),
        'Helpers': SimpleNamespace(special_permission_activity_logger=lambda *arguments, **_kwargs: activities.append({'operatorId': arguments[0], 'platform': arguments[1]})),
    }
    class_name = CLASSES[asset]
    exec(selected(source, class_name), scope)
    instance = scope[class_name]()
    instance.request = SimpleNamespace(user=SimpleNamespace(id=44))
    response = instance.post(SimpleNamespace(POST=data))
    return {'status': response['status'], 'queries': queries, 'histories': histories, 'activities': activities}


def main():
    raw = SOURCE.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise ValueError('Pinned benefit source changed; review the source evidence')
    request = json.load(sys.stdin)
    profile = request.get('profile', 'legacy')
    if profile not in ('legacy', 'proposed-wallet-v1'):
        raise ValueError('Unknown benefit oracle profile')
    source = raw.decode()
    if profile == 'proposed-wallet-v1':
        source = apply_candidate(source)
    json.dump({'sourceSha256': SOURCE_SHA256, 'profile': profile, 'cases': [execute(case, source) for case in request['cases']]}, sys.stdout, allow_nan=False)


if __name__ == '__main__':
    main()
