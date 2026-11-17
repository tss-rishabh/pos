"""Operation-independent coupon controls for an independent BQ publisher.

    No customer, cart, operation, claim, order, history count or source mutation
    is required. Literal source cache traversal stops before its first history
    query; only opaque control hashes and actual writer metadata leave here.
"""
import copy
import json
import re
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo
from sqlalchemy import event, text
from benefit_source import BenefitReview, compile_coupon
from benefit_history import Rows, seal
from benefit_controls import CurrentConfigurationCache
from benefit_receipts import COUPON_CONTROL
from configuration_cache_snapshot import source_configuration_snapshot
from membership_handoff import source_instant
from transaction import CURRENT

CONTRACT = 'pos-csv-coupon-generation-controls-v1'


def reject():
    raise BenefitReview('ORDER_IMPORT_COUPON_CONTROLS_UNAVAILABLE') from None


class _HistoricalBoundary(BaseException):
    pass


class _CurrentReader:
    def __init__(self, session):
        self.session, self.coupon_id, self.input_hash = session, None, None

    def execute(self, query, parameters=None):
        statement = ' '.join(str(query).split()).lower()
        allowance = re.fullmatch(r"select no_times_allowed as num from tss\.coupons where id='([1-9][0-9]{0,9})';", statement)
        if allowance:
            identity = allowance[1]
            if int(identity) > 2147483647: reject()
            result = self.session.execute(text('SELECT no_times_allowed,' + COUPON_CONTROL +
                ' AS native_hash FROM coupons WHERE id=:coupon LIMIT 2'), {'coupon': identity})
            values = result.mappings().fetchmany(2)
            result.close()
            if len(values) != 1: reject()
            self.coupon_id, self.input_hash = identity, values[0]['native_hash']
            return Rows([{'num': values[0]['no_times_allowed']}])
        if statement in (
            "select status, value from tss_settings where platform='auto_apply_coupon'",
            "select status from tss_settings where platform='birthday_coupon'",
            "select * from coupons join tss_settings on coupons.id = tss_settings.value where tss_settings.platform='birthday_coupon';",
        ):
            if parameters: reject()
            result = self.session.execute(text(str(query).strip().rstrip(';') + ' LIMIT 2'))
            values = result.mappings().fetchmany(2)
            result.close()
            if len(values) != 1: reject()
            return Rows([dict(values[0])])
        reject()

    def fetch_one(self, session, query, params=None, to_dict=False):
        if session is not self or params: reject()
        expected = ('select count(1) as usage_count from orders o where o.order_status not in '
                    '(0,4,7,15,17,22,31,33) and o.coupon_used = ' + str(self.coupon_id))
        if self.coupon_id is None or ' '.join(str(query).split()).lower() != expected: reject()
        raise _HistoricalBoundary()

    def fetch(self, session, query, params=None, to_dict=False):
        if session is not self: reject()
        values = self.execute(query, params).fetchall()
        return [dict(row) for row in values] if to_dict else values


@contextmanager
def _read_only(session):
    if session.in_transaction() or CURRENT.get() is not None: reject()
    connection = session.connection(execution_options={'isolation_level': 'REPEATABLE READ'})
    selected = [False]
    def observe(_connection, _cursor, statement, _parameters, _context, _many):
        value = ' '.join(statement.split()).upper()
        if not selected[0] and value == 'SET TRANSACTION READ ONLY':
            selected[0] = True
            return
        if not selected[0] or not value.startswith('SELECT '): reject()
    event.listen(connection, 'before_cursor_execute', observe)
    try:
        session.execute(text('SET TRANSACTION READ ONLY'))
        with session.no_autoflush:
            yield
    finally:
        event.remove(connection, 'before_cursor_execute', observe)
        session.rollback()


class CouponGenerationControls:
    def __init__(self, sessions, source_key, benefits, *, cache_snapshot=None, clock=None):
        if not isinstance(source_key, str) or not re.fullmatch(r'[!-~]{32,4096}', source_key): reject()
        self.sessions, self.source_key, self.benefits = sessions, source_key, benefits
        self.cache_snapshot = cache_snapshot or source_configuration_snapshot
        self.clock = clock or (lambda: int(time.time() * 1000))

    def read(self):
        if CURRENT.get() is not None: reject()
        # Only trusted source configuration is read, before opening native SQL.
        snapshot = self.cache_snapshot(self.benefits.source_cache)
        cache = CurrentConfigurationCache(snapshot)
        settings = copy.deepcopy(self.benefits.coupon_settings)
        with self.sessions() as session, _read_only(session):
            current = _CurrentReader(session)
            namespace = compile_coupon(self.benefits.root, {
                'json': json, 'text': text, 'redis_object': cache,
                'fetch': current.fetch, 'fetchOne': current.fetch_one,
                'logger': SimpleNamespace(debug=lambda *_args: None),
            })
            auto = namespace['get_auto_apply_coupon'](current)
            if not isinstance(auto, dict) or int(auto.get('status', 0)) != 1 or auto.get('value') != 'birthday_coupon': reject()
            coupon_id, coupon_name, status = namespace['get_birthday_coupon_details'](current)
            if not coupon_id or not coupon_name or int(status) != 1: reject()
            try:
                namespace['allowed_coupon_usage'](current, coupon_id)
            except _HistoricalBoundary:
                pass
            else:
                reject()
            if current.coupon_id != str(coupon_id) or not re.fullmatch(r'[a-f0-9]{64}', current.input_hash or ''): reject()
            witness = self.benefits.heads.capture_controls(session, current.coupon_id)
            point = self.benefits.point_factory()
            if not isinstance(point, datetime) or point.tzinfo is not None: reject()
            point = point.replace(microsecond=0)
            observed = self.clock()
            if type(observed) is not int or not 0 < observed <= 9007199254740991: reject()
            zone = ZoneInfo(self.benefits.zone)
            source_as_of = point.strftime('%Y-%m-%d %H:%M:%S')
            _value, instant = source_instant(source_as_of, zone)
            if not 0 <= observed - instant < 1000: reject()
            day_end = datetime.combine(point.date() + timedelta(days=1), datetime.min.time())
            _value, end_ms = source_instant(day_end.strftime('%Y-%m-%d %H:%M:%S'), zone)
            data = {
                'contract': CONTRACT, 'couponId': current.coupon_id,
                'configurationHash': seal('coupon-configuration', {'cache': cache.values,
                    'settings': settings, 'couponInputHash': current.input_hash}, self.source_key),
                'couponInputHash': current.input_hash, 'sourceTimeZone': self.benefits.zone,
                'sourceDay': point.strftime('%Y-%m-%d'), 'sourceAsOf': source_as_of,
                **witness, 'observedAt': observed, 'expiresAt': min(observed + 60000, end_ms),
            }
            if len(json.dumps(data).encode()) > 8192: reject()
            return {'data': data, 'proofHash': seal('coupon-generation-config', data, self.source_key)}
