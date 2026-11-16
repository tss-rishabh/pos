"""Pinned source consumers + review patches, applied only in memory/temp files."""
import ast
import enum
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
ARTIFACTS = Path(__file__).resolve().parents[2] / 'compatibility/upstream/global-vouchers'
API = ROOT / 'backend-tss-api_v2'
PIN = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'


def source(path):
    return subprocess.check_output(['git', 'show', PIN + ':' + path], cwd=API).decode()


def apply(before, patch):
    for group in re.split(r'^@@[^\n]*\n', patch, flags=re.MULTILINE)[1:]:
        old, new = [], []
        for line in group.splitlines(keepends=True):
            if line.startswith((' ', '-')):
                old.append(line[1:])
            if line.startswith((' ', '+')):
                new.append(line[1:])
        old, new = ''.join(old), ''.join(new)
        if not old or before.count(old) != 1:
            raise ValueError('Candidate context must match exactly once')
        before = before.replace(old, new, 1)
    return before


def selected(raw, name):
    node = next(node for node in ast.parse(raw).body if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name == name)
    return compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<pinned-voucher-consumer>', 'exec')


class Kind(enum.Enum):
    GIFT_VOUCHER = 'GIFT_VOUCHER'
    GIFT_CARD = 'GIFT_CARD'


class Platform(enum.Enum):
    both = 'both'
    offline = 'offline'
    online = 'online'


class Predicate:
    def __eq__(self, _value):
        return True


class Session:
    def __init__(self, voucher):
        self.voucher = voucher

    def query(self, *_args):
        return self

    def filter(self, *_args):
        return self

    def one(self):
        return self.voucher

    def first(self):
        return self.voucher

    def all(self):
        return [SimpleNamespace(id=7)]

    def begin_nested(self):
        pass


class Rejected(Exception):
    pass


def globals_for(voucher):
    return {'GV_TYPE': Kind, 'GV_PLATFORM': Platform, 'IS_GIFT_CARD': True, 'GC_PIN_STATUS': True,
            'GiftVoucherModal': SimpleNamespace(voucher_code=Predicate()), 'User': SimpleNamespace(email=Predicate()),
            'falcon': SimpleNamespace(before=lambda _fn: lambda method: method, HTTPBadRequest=Rejected),
            'auth_required': lambda *_args: None, 'ValidationException': Rejected, 'PinReqException': Rejected,
            'check_valid_voucher_dates': lambda *_args: (_ for _ in ()).throw(AssertionError('Ordinary vouchers must not consult date validity')),
            'INVALID_GIFT_VOUCHER_PAYMENT_STATUSES': [], 'fetchOne': lambda *_args: None,
            'logger': SimpleNamespace(info=lambda *_args: None), 'json': json, 'dateConvertor': str}


def voucher(value=25.49, initial=25.49):
    return SimpleNamespace(_sa_instance_state=None, id=1, voucher_code='SYNTHETIC', gv_type=Kind.GIFT_VOUCHER,
                           platform=Platform.both, to_id='fixture@example.test', theme=0, voucher_value=value,
                           voucher_initial_value=initial, status=1, is_gcpin=0, created_at='2026-06-15 12:00:00',
                           updated_at='2026-06-15 12:00:00', start_date=None, end_date=None, order_id=0)


def cart_case(raw, value, initial):
    row = voucher(value, initial)
    scope = globals_for(row)
    exec(selected(raw, 'make_gift_voucher'), scope)
    try:
        result = scope['make_gift_voucher'](Session(row), {'user_id': 7}, {'name': 'gift_voucher', 'voucher_code': 'SYNTHETIC'}, None, {'is_pos': True})
        return {'value': result['voucher_value'], 'hasDates': 'start_date' in result or 'end_date' in result}
    except Rejected as error:
        return {'error': str(error)}


def check_case(raw):
    row = voucher()
    scope = globals_for(row)
    exec(selected(raw, 'GiftVoucherCheck'), scope)
    req = SimpleNamespace(context={'session': Session(row), 'data': {'gift_voucher_code': 'SYNTHETIC'},
                                    'user': {'user_id': 7, 'email': 'fixture@example.test'}})
    response = SimpleNamespace()
    scope['GiftVoucherCheck']().on_post(req, response)
    return json.loads(response.body)


def source_pin_policy(raw):
    # Select only the two public defaults from the pinned settings AST. Never
    # import settings, load .env, inspect credentials or connect to Redis.
    settings = ast.parse(source('settings.py'))
    defaults = [node for node in settings.body if isinstance(node, ast.Assign) and
                any(isinstance(target, ast.Name) and target.id in ('GC_PIN_LIMIT', 'GC_PIN_LIMIT_EX') for target in node.targets)]
    scope = {'ENV': SimpleNamespace(get=lambda _key, default=None: default)}
    exec(compile(ast.fix_missing_locations(ast.Module(body=defaults, type_ignores=[])), '<source-pin-defaults>', 'exec'), scope)

    class Redis:
        now = 0

        def __init__(self):
            self.value, self.expires = None, None

        def exists(self, _key):
            if self.expires is not None and self.expires <= self.now:
                self.value, self.expires = None, None
            return self.value is not None

        def get(self, _key):
            return str(self.value).encode()

        def set(self, _key, value, ex):
            self.value, self.expires = value, self.now + ex

        def delete(self, _key):
            self.value, self.expires = None, None

    redis = Redis()
    scope.update({'redis_object': redis, 'get_gc_pin': lambda _serial: '123456'})
    exec(selected(raw, 'validate_gc_pin'), scope)
    validate = scope['validate_gc_pin']
    row = SimpleNamespace(voucher_code='SYNTHETIC', gift_card_srno=999901111)
    sliding = []
    for at in (0, 1800, 86400, 172800):
        redis.now = at
        validate('000000', row)
        sliding.append({'at': at, 'failures': redis.value, 'expiresAt': redis.expires})
    redis = Redis()
    scope['redis_object'] = redis
    for _ in range(scope['GC_PIN_LIMIT']):
        validate('000000', row)
    redis.now = 1800
    blocked = validate('123456', row)
    blocked_expiry = redis.expires
    redis.now = scope['GC_PIN_LIMIT_EX']
    accepted = validate('123456', row)
    return {'limit': scope['GC_PIN_LIMIT'], 'ttlSeconds': scope['GC_PIN_LIMIT_EX'],
            'sliding': sliding, 'blockedValidBeforeExpiry': not blocked[0] and blocked[2],
            'blockedAttemptExpiresAt': blocked_expiry, 'acceptedValidAtExpiry': accepted[0]}


def main():
    manifest = json.loads((ARTIFACTS / 'manifest.json').read_text())
    candidates = {}
    for entry in manifest['entries']:
        before = subprocess.check_output(['git', 'show', entry['sourceCommit'] + ':' + entry['sourcePath']], cwd=ROOT / entry['sourceRepo'])
        patch = (ARTIFACTS / entry['patch']).read_bytes()
        if hashlib.sha256(before).hexdigest() != entry['beforeSha256'] or hashlib.sha256(patch).hexdigest() != entry['patchSha256']:
            raise ValueError('Source/candidate pin changed')
        after = apply(before.decode(), patch.decode())
        if hashlib.sha256(after.encode()).hexdigest() != entry['afterSha256']:
            raise ValueError('Candidate output pin changed')
        with tempfile.TemporaryDirectory(prefix='pos-voucher-candidate-') as temporary:
            target = Path(temporary) / entry['sourcePath']
            target.parent.mkdir(parents=True)
            target.write_bytes(before)
            subprocess.run(['git', 'apply', '--check', str(ARTIFACTS / entry['patch'])], cwd=temporary, check=True, capture_output=True)
            subprocess.run(['git', 'apply', str(ARTIFACTS / entry['patch'])], cwd=temporary, check=True, capture_output=True)
            if target.read_text() != after:
                raise ValueError('Dry-apply output mismatch')
        candidates[entry['patch']] = after
    legacy_sql = (ARTIFACTS / manifest['legacySql']['path']).read_bytes()
    if hashlib.sha256(legacy_sql).hexdigest() != manifest['legacySql']['sha256']:
        raise ValueError('Review-only SQL pin changed')
    cart = source('controllers/cart/initializers/MetaInitializers.py')
    enum_scope = {'enum': enum}
    exec(selected(candidates['api-voucher-issuance-enum.patch'], 'GiftVoucherPlatformTypes'), enum_scope)
    json.dump({'patchesDryApplied': len(candidates), 'ordinaryDatesSkipped': True,
               'cart': [cart_case(cart, 26, 25.5), cart_case(cart, 25, 25.49), cart_case(cart, 0, .01), cart_case(cart, 25.49, 25.49), cart_case(cart, .01, .01)],
               'originalCheck': check_case(source('controllers/GiftVoucherController.py')),
               'candidateCheck': check_case(candidates['api-voucher-nonexpiry-display.patch']),
               'enumHasGvAdd': 'GV_ADD' in enum_scope['GiftVoucherPlatformTypes'].__members__,
               'genericCouponExcludesType3': 'voucher_type != 3' in cart,
               'pinPolicy': source_pin_policy(cart),
               'exactCandidateUsesInitial': '0, c.initial_val, c.initial_val,' in candidates['global-issuance-exact-value.patch']}, sys.stdout)


if __name__ == '__main__':
    main()
