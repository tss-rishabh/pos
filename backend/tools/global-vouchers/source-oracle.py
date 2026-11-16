"""Execute pinned voucher source in memory; no application imports or external I/O.

SQL intent recording deliberately does not pretend to be a MySQL executor. The
separate native fixture proves actual physical rounding/default/ENUM behavior.
"""
import ast
import datetime
import enum
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
API = ROOT / 'backend-tss-api_v2'
POS = ROOT / 'backend-pos-web'
REMOVED = '51107a870c56928cad88f181dd6806a1f5539a31'
PARENT = '02bfa5902f06faa5e648c4d5ad64c2e72646853e'
API_PIN = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
POS_PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
SOURCE_HASH = 'c885119baa3a3af684babb8949abae7ac8e907cb57f831556eebb09238ed8b6e'


def source(repo, pin, path):
    return subprocess.check_output(['git', 'show', f'{pin}:{path}'], cwd=repo)


def selected(raw, name):
    node = next(node for node in ast.parse(raw).body if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name == name)
    return compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<pinned-voucher-source>', 'exec')


class BadRequest(Exception):
    pass


class Kind(enum.Enum):
    GIFT_VOUCHER = 'GIFT_VOUCHER'
    GIFT_CARD = 'GIFT_CARD'


class Platform(enum.Enum):
    online = 'online'
    both = 'both'
    offline = 'offline'


class Predicate:
    def __eq__(self, _value):
        return True


class Query:
    def __init__(self, voucher):
        self.voucher = voucher

    def filter(self, *_args):
        return self

    def first(self):
        return self.voucher


class Model:
    def __init__(self, name):
        self.name = name

    def __call__(self, **fields):
        return {'model': self.name, **fields}


class Session:
    def __init__(self, voucher):
        self.voucher = voucher
        self.money = 100
        self.rows = []
        self.commits = 0

    def begin_nested(self):
        pass

    def query(self, *_args):
        return Query(self.voucher)

    def execute(self, query, *_args, **_kwargs):
        if query.startswith('UPDATE gift_vouchers SET status'):
            self.voucher.status, self.voucher.voucher_value = 0, 0
        elif query.startswith('UPDATE gift_vouchers SET voucher'):
            self.voucher.voucher_value = 0
        elif query.startswith('UPDATE users SET tss_money'):
            self.money += float(re.search(r'tss_money \+ ([^ ]+)', query).group(1))

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def add(self, row):
        self.rows.append(row)


def convert(raw, kind, requires_pin=False, pin_enabled=True, amount=25.5):
    voucher = SimpleNamespace(id=1, voucher_code='SYNTHETIC', platform=Platform.both,
                              gv_type=kind, voucher_value=amount, status=1,
                              to_id='fixture@example.test', is_gcpin=requires_pin,
                              start_date='0000-00-00 00:00:00', end_date='0000-00-00 00:00:00')
    session = Session(voucher)
    scope = {'falcon': SimpleNamespace(before=lambda _f: lambda method: method, HTTPBadRequest=BadRequest),
             'auth_required': lambda *_args: None, 'GV_TYPE': Kind, 'GV_PLATFORM': Platform,
             'GiftVoucherModal': SimpleNamespace(voucher_code=Predicate()), 'IS_GIFT_CARD': True,
             'GC_PIN_STATUS': pin_enabled, 'check_valid_voucher_dates': lambda *_args: True,
             'validate_gc_pin': lambda *_args: (True, 'Valid', False),
             'fetchOne': lambda *_args, **_kwargs: {'cashback': 7, 'tss_money': session.money},
             'GiftVoucherHistory': Model('gift'), 'TssMoneyHistory': Model('money'),
             'RewardPointHistory': Model('reward'),
             'PlatformTypes': SimpleNamespace(MISC_COMPENSATION='MISC_COMPENSATION'),
             'copt': SimpleNamespace(CASHBACK_EARNED='CASHBACK_EARNED'),
             'logger': SimpleNamespace(info=lambda *_args: None, error=lambda *_args: None),
             'datetime': datetime.datetime,
             'pytz': SimpleNamespace(timezone=lambda _value: datetime.timezone.utc),
             'tss_money_point_expiry': lambda expiry, *_args, **_kwargs: expiry,
             'json': json, 'dateConvertor': str}
    exec(selected(raw, 'GiftVoucherToTSSMoney'), scope)
    instance = scope['GiftVoucherToTSSMoney']()
    request = SimpleNamespace(context={'session': session, 'data': {'gift_voucher_code': 'SYNTHETIC', 'gc_pin': '123456'},
                                       'user': {'user_id': '7', 'email': 'fixture@example.test'}})
    outcomes = []
    for _ in range(2):
        try:
            response = SimpleNamespace()
            instance.on_post(request, response)
            outcomes.append(json.loads(response.body)['status'])
        except BadRequest as error:
            outcomes.append(str(error))
    return {'kind': kind.value, 'requiresPin': requires_pin, 'pinEnabled': pin_enabled,
            'amount': amount, 'outcomes': outcomes, 'voucherBalance': voucher.voucher_value,
            'voucherStatus': voucher.status, 'money': session.money, 'commits': session.commits,
            'histories': [{'kind': row['model'], 'added': row['added_amt'],
                           'before': row.get('amt_before_update'), 'after': row.get('amt_after_update'),
                           'platform': row['platform']} for row in session.rows]}


def main():
    raw = source(API, PARENT, 'controllers/GiftVoucherController.py')
    if hashlib.sha256(raw).hexdigest() != SOURCE_HASH:
        raise ValueError('Historical conversion source hash changed')
    parent = subprocess.check_output(['git', 'rev-parse', REMOVED + '^'], cwd=API, text=True).strip()
    if parent != PARENT:
        raise ValueError('Historical conversion parent changed')
    subprocess.run(['git', 'merge-base', '--is-ancestor', REMOVED, API_PIN], cwd=API, check=True)
    current_routes = source(API, API_PIN, 'main.py').decode()
    old_routes = source(API, PARENT, 'main.py').decode()
    pos = source(POS, POS_PIN, 'core/views.py').decode()
    if 'GiftVoucherToTSSMoney()' in current_routes or 'GiftVoucherToTSSMoney()' not in old_routes:
        raise ValueError('Source route lineage changed')
    output = {'parentCommit': PARENT, 'removalCommit': REMOVED, 'sourceSha256': SOURCE_HASH,
              'currentApiPin': API_PIN, 'currentRoutePresent': False,
              'posIssuerSha256': hashlib.sha256(pos.encode()).hexdigest(),
              'cases': [convert(raw, Kind.GIFT_VOUCHER), convert(raw, Kind.GIFT_CARD),
                        convert(raw, Kind.GIFT_CARD, True), convert(raw, Kind.GIFT_CARD, True, False),
                        convert(raw, Kind.GIFT_VOUCHER, amount=25.555)]}
    json.dump(output, sys.stdout, allow_nan=False)


if __name__ == '__main__':
    main()
