"""Source-pinned, side-effect-free cancellation wallet intent candidate.

Only an in-memory recorder can be supplied. This is not a deployed writer and
does not enable benefit cancellation. Native-lock/input-hash validation and a
typed atomic executor remain required before activation.
"""
import ast
import copy
from datetime import date, datetime, timedelta, timezone
import hashlib
import math
from pathlib import Path
import subprocess
from types import SimpleNamespace
from typing import Optional

SOURCE = Path(__file__).resolve().parents[5] / 'backend-tss-api_v2'
COMMIT = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'


class Rejected(ValueError):
    pass


class FrozenDate(date):
    @classmethod
    def today(cls):
        return cls(2026, 11, 17)


class FrozenTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 17, 12, 0, 0, tzinfo=tz)


def method(kind, corrected):
    path = 'controllers/TssMoneyHistoryController.py' if kind == 'money' else 'controllers/TssPointHistoryController.py'
    name = 'orderCancelTssMoneyProduct' if kind == 'money' else 'orderCancelTssPoint'
    original = subprocess.check_output(['git', 'show', COMMIT + ':' + path], cwd=SOURCE, text=True)
    tree = ast.parse(original)
    selected = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == name)
    class Correction(ast.NodeTransformer):
        def visit_Constant(self, node):
            if isinstance(node.value, str) and 'UPDATE users SET cashback = tss_money +' in node.value:
                first, rest = node.value.split(', tss_money = ', 1)
                return ast.copy_location(ast.Constant(value='UPDATE users SET tss_money = ' + rest), node)
            return node
        def visit_Expr(self, node):
            if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == 'add' and len(node.value.args) == 1 and isinstance(node.value.args[0], ast.Name) and node.value.args[0].id == 'rewardpointhistory':
                return None
            return self.generic_visit(node)
    if corrected:
        selected = Correction().visit(selected)
    selected = ast.fix_missing_locations(ast.Module(body=[selected], type_ignores=[]))
    return compile(selected, '<pinned-cancellation-wallet>', 'exec'), name, hashlib.sha256(original.encode()).hexdigest()


def run(kind, snapshot, corrected=False):
    """Preserve source float arithmetic; reject undefined/lossy branches first."""
    value = copy.deepcopy(snapshot)
    rows, histories, requested = value['mappings'], value['histories'], value['requested']
    returned_key, history_key = ('tss_money_return', 'tss_money_id') if kind == 'money' else ('tss_point_return', 'tss_point_id')
    if corrected:
        if not rows:
            raise Rejected('CANCELLATION_MISSING_EARNING_MAPPING')
        if len(rows) > 1000 or len({row['id'] for row in rows}) != len(rows):
            raise Rejected('CANCELLATION_MAPPING_AMBIGUOUS')
        expiries, remaining = set(), 0.0
        for row in rows:
            history = histories.get(row[history_key])
            if not history or history['is_expired'] != 0 or (history['expiry'] and history['expiry'].date() < FrozenDate.today()):
                raise Rejected('CANCELLATION_EXPIRED_EARNING_POLICY_REQUIRED')
            available = row['used_amount'] - row[returned_key]
            if not math.isfinite(available) or available < 0:
                raise Rejected('CANCELLATION_MAPPING_INVALID')
            if available > 0:
                remaining += available
                expiries.add(str(history['expiry']))
        if not math.isfinite(requested) or requested <= 0 or remaining < requested:
            raise Rejected('CANCELLATION_EARNING_TRACE_INCOMPLETE')
        if kind == 'points' and len(expiries) != 1:
            raise Rejected('CANCELLATION_POINTS_EXPIRY_POLICY_REQUIRED')
        # Explicit deterministic order, not an assumed database enumeration order.
        rows.sort(key=lambda row: row['id'])
    effects, ledger, commits = [], [], []
    user = value['user']

    class Session:
        def add(self, record):
            ledger.append(record)
        def commit(self):
            commits.append(True)
        def execute(self, statement, params):
            query = str(statement)
            if 'UPDATE order_tss_' in query:
                row = next(item for item in rows if item['id'] == params['id'])
                amount = params.get('amount_to_be_added', params.get('amount'))
                before = row[returned_key]
                row[returned_key] = before + amount if ' + :' in query else amount
                effects.append({'kind': 'mapping', 'id': str(row['id']), 'before': before, 'after': row[returned_key]})
            elif 'UPDATE users SET' in query:
                amount = params.get('amt', params.get('product_tss_money_used', params.get('amount')))
                field = 'tss_money' if kind == 'money' else 'tss_points'
                if 'cashback =' in query:
                    user['cashback'] = user['tss_money'] + amount
                user[field] += amount
                effects.append({'kind': 'balance', 'money': user['tss_money'], 'points': user['tss_points'], 'cashback': user['cashback']})
            else:
                raise RuntimeError('Unexpected pinned wallet intent')

    def fetch(_session, _query, **_kwargs):
        return copy.deepcopy(rows)

    def fetch_one(_session, query, **kwargs):
        if 'FIRST_ORDER_RETURN_BONUS' in query:
            return None
        params = kwargs.get('params', {})
        if 'from tss_money_history' in query or 'from tss_point_history' in query:
            return copy.deepcopy(histories[params[history_key]])
        if 'from users' in query:
            return copy.deepcopy(user)
        raise RuntimeError('Unexpected pinned wallet reader')

    def constructor(label):
        return lambda **kwargs: {'ledger': label, **kwargs}

    enums = SimpleNamespace(ORDER_REFUND='ORDER_REFUND', ORDER_CANCELLED='ORDER_CANCELLED', FIRST_ORDER_RETURN_BONUS='FIRST_ORDER_RETURN_BONUS', TSS_MONEY_EXPIRED='TSS_MONEY_EXPIRED', CASHBACK_EXPIRED='CASHBACK_EXPIRED', TSS_POINTS_EXPIRED='TSS_POINTS_EXPIRED')
    scope = {'Optional': Optional, 'json': __import__('json'), 'date': FrozenDate, 'datetime': FrozenTime, 'timedelta': timedelta,
             'pytz': SimpleNamespace(timezone=lambda _: timezone(timedelta(hours=5, minutes=30))), 'text': lambda query: query,
             'fetch': fetch, 'fetchOne': fetch_one, 'TssMoneyHistory': constructor('money'), 'RewardPointHistory': constructor('reward'), 'TssPointHistory': constructor('points'),
             'PlatformTypes': enums, 'TssPointPlatformTypes': enums, 'pt': enums, 'Comments': {'ORDER_CANCELLED': 'TSS Points Reverted For Order Cancellation'},
             'tss_money_point_expiry': lambda expiry, _platform, is_date=False: expiry if is_date else FrozenTime.now() + timedelta(days=expiry),
             'TSS_MONEY_EXPIRY_IN_DAYS': 365, 'TSS_POINTS_EXPIRE_AFTER': 365,
             'getUserTssPoint': lambda *_: user.copy(), 'falcon': SimpleNamespace(HTTPBadRequest=Rejected), 'logger': SimpleNamespace(error=lambda *_: None)}
    code, name, source_hash = method(kind, corrected)
    exec(code, scope)
    order = {'platform': 'ORDER_CANCELLED', 'product_tss_money_used': requested, 'product_tss_point_used': requested}
    arguments = {'has_product_id': 9007199254740995, 'commit': not corrected}
    if kind == 'money':
        arguments['prodId'] = 10
    else:
        arguments.update(game_category_id=0, platform='ORDER_CANCELLED', prod_id=10)
    scope[name](Session(), {'user_id': 777}, order, 9007199254740993, **arguments)
    return {'user': user, 'effects': effects, 'ledger': ledger, 'sourceCommits': len(commits), 'sourceHash': source_hash}
