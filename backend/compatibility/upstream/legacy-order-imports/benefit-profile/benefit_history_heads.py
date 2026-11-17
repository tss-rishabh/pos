"""Current writer fence for a preloaded, authenticated BigQuery history capsule.

Only native metadata and three current head rows are read here. Historical
eligibility remains the warehouse's job. Head locks are acquired AFTER the
original order writes, matching the legacy Order -> trigger/head lock order.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import hmac
import json
from pathlib import Path
import re
from uuid import UUID
from sqlalchemy import event, text
from sqlalchemy.orm import Session
from benefit_history import canonical, seal
from benefit_source import BenefitReview
from screening_transaction import current
from transaction import CURRENT

_CONTRACT = 'pos-csv-coupon-history-all-writers-v1'
_INFO = 'pos_private_coupon_history_heads'
_ACTIVE = ContextVar(_INFO, default=None)
_MAX_REVISION = 18446744073709551615
_READ = """SELECT kind,scope_id AS scopeId,CAST(revision AS CHAR) AS revision,
 last_owner_nonce AS owner,CAST(owner_start_revision AS CHAR) AS start
 FROM pos_rewrite_coupon_history_heads
 WHERE (kind='controls' AND scope_id='0') OR (kind='coupon' AND scope_id=:coupon)
 OR (kind='customer' AND scope_id=:customer) ORDER BY kind,scope_id LIMIT 4"""


def _reject(code='ORDER_IMPORT_COUPON_HEADS_CHANGED'):
    raise BenefitReview(code) from None


def _uuid(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value: _reject()
    except (TypeError, ValueError, AttributeError):
        _reject()
    return value


def _revision(value):
    if (not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}', value)
            or int(value) > _MAX_REVISION):
        _reject()
    return int(value)


def _scope(value):
    if not isinstance(value, dict) or set(value) != {
        'contract', 'operationId', 'requestHash', 'planHash', 'customerId',
        'couponId', 'configurationHash', 'asOf', 'sourceTimeZone'
    } or value['contract'] != 'pos-csv-coupon-history-v1':
        _reject()
    _uuid(value['operationId'])
    for name in ('requestHash', 'planHash', 'configurationHash'):
        if not isinstance(value[name], str) or not re.fullmatch(r'[a-f0-9]{64}', value[name]): _reject()
    for name in ('customerId', 'couponId'):
        if (not isinstance(value[name], str) or not re.fullmatch(r'[1-9][0-9]{0,18}', value[name])
                or int(value[name]) > 9223372036854775807): _reject()
    return json.loads(canonical(value))


def _rows(session, sql, parameters=None, maximum=10):
    result = session.execute(text(sql), parameters or {})
    try:
        values = result.mappings().fetchmany(maximum + 1)
        if len(values) > maximum: _reject()
        return [dict(row) for row in values]
    finally:
        result.close()


def _heads(session, scope, *, lock=False):
    # The transaction already owns X locks for heads its triggers changed.
    # Shared late locks fence foreign changes without serializing unrelated
    # coupon transactions through the unchanged global controls head.
    values = _rows(session, _READ + (' FOR SHARE' if lock else ''),
                   {'coupon': scope['couponId'], 'customer': scope['customerId']}, 3)
    expected = [('controls', '0'), ('coupon', scope['couponId']), ('customer', scope['customerId'])]
    if len(values) != 3: _reject()
    for value, (kind, identity) in zip(values, expected):
        if value['kind'] != kind or value['scopeId'] != identity: _reject()
        _revision(value['revision'])
        if value['owner'] is not None: _uuid(value['owner'])
        if value['start'] is not None: _revision(value['start'])
        if (value['owner'] is None) != (value['start'] is None): _reject()
    if int(values[0]['revision']) < 1: _reject()
    return values


def _public_heads(values):
    return [{key: value[key] for key in ('kind', 'scopeId', 'revision')} for value in values]


class _Frame:
    def __init__(self, port, session, connection, cap, scope, witness):
        self.port, self.session, self.connection = port, session, connection
        self.transaction = session.get_transaction()
        self.nonce, self.scope, self.witness = cap['nonce'], scope, witness
        self.validated = None
        self.cleaned = False


def _before_commit(session):
    frame = session.info.get(_INFO)
    if not isinstance(frame, _Frame): return
    # A caller cannot validate early and mutate another watched table later.
    # The late locks remain held, and the final native rows must be identical.
    if (not frame.cleaned or frame.validated is None
            or frame.transaction is not session.get_transaction()):
        _reject()
    session.flush()
    if _heads(session, frame.scope, lock=True) != frame.validated:
        _reject()


def _after_transaction(session, transaction):
    frame = session.info.get(_INFO)
    if isinstance(frame, _Frame) and frame.transaction is transaction:
        session.info.pop(_INFO, None)
        if not frame.cleaned:
            # Never return a connection carrying an owner variable to the pool.
            frame.connection.invalidate()


# Registration performs no SQL or external I/O. Unselected sessions only take
# the dictionary lookup; they never acquire a head or read any source table.
event.listen(Session, 'before_commit', _before_commit)
event.listen(Session, 'after_transaction_end', _after_transaction)


class NativeCouponHistoryHeads:
    def __init__(self, source_key):
        self.source_key = source_key
        self.manifest = None

    def assert_ready(self):
        if not isinstance(self.source_key, str) or not re.fullmatch(r'[!-~]{32,4096}', self.source_key):
            _reject('ORDER_IMPORT_COUPON_HEADS_UNAVAILABLE')
        if self.manifest is None:
            try:
                raw = Path(__file__).with_name('coupon-history-writers.review.json').read_bytes()
                if len(raw) > 40000: raise ValueError()
                manifest = json.loads(raw)
                if (set(manifest) != {'writersContract', 'definitionHash', 'definitions'}
                        or manifest['writersContract'] != _CONTRACT
                        or not isinstance(manifest['definitions'], list)
                        or len(manifest['definitions']) != 10): raise ValueError()
                definitions = manifest['definitions']
                for row in definitions:
                    if (set(row) != {'name', 'table', 'event', 'timing', 'statement'}
                            or row['timing'] != 'AFTER'
                            or row['statement'] != ' '.join(row['statement'].split())): raise ValueError()
                # JSON property order is intentional: it matches the TS builder.
                encoded = json.dumps(definitions, ensure_ascii=False, separators=(',', ':')).encode()
                if not hmac.compare_digest(hashlib.sha256(encoded).hexdigest(), manifest['definitionHash']):
                    raise ValueError()
                self.manifest = manifest
            except (OSError, ValueError, TypeError, KeyError):
                _reject('ORDER_IMPORT_COUPON_HEADS_UNAVAILABLE')
        return self.manifest

    def capture(self, session, supplied):
        manifest, scope = self.assert_ready(), _scope(supplied)
        if not isinstance(session, Session) or not session.in_transaction(): _reject()
        # Open each watched table without reading history. MDL prevents trigger
        # replacement between metadata qualification and the enclosing commit.
        for table in ('orders', 'order_coupon_log', 'coupons', 'users'):
            result = session.execute(text('SELECT id FROM ' + table + ' LIMIT 0'))
            result.close()
        names = [row['name'] for row in manifest['definitions']]
        parameters = {'name' + str(index): name for index, name in enumerate(names)}
        actual = _rows(session, """SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS `table`,
          EVENT_MANIPULATION AS `event`,ACTION_TIMING AS timing,ACTION_STATEMENT AS statement
          FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()
          AND EVENT_OBJECT_SCHEMA=DATABASE() AND TRIGGER_NAME IN (""" +
                       ','.join(':' + name for name in parameters) + ') LIMIT 11', parameters, 10)
        if len(actual) != 10 or len({row['name'] for row in actual}) != 10: _reject()
        for row in actual:
            row['statement'] = ' '.join(row['statement'].split())
        if sorted(actual, key=lambda row: row['name']) != sorted(manifest['definitions'], key=lambda row: row['name']):
            _reject('ORDER_IMPORT_COUPON_HEADS_UNAVAILABLE')
        identities = _rows(session, 'SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema', maximum=1)
        if len(identities) != 1: _reject()
        identity = identities[0]
        _uuid(identity['serverUuid'])
        if not isinstance(identity['sourceSchema'], str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', identity['sourceSchema']):
            _reject()
        return {'writersContract': _CONTRACT, 'writersDefinitionHash': manifest['definitionHash'],
                **identity, 'heads': _public_heads(_heads(session, scope))}

    def head_hash(self, scope, witness):
        return seal('coupon-control-head', {'scope': scope, **{
            key: witness[key] for key in ('serverUuid', 'sourceSchema', 'writersDefinitionHash', 'heads')
        }}, self.source_key)

    @contextmanager
    def scope(self, session, cap, supplied, witness):
        scope = _scope(supplied)
        owned = current(session, cap)
        session = owned.session
        if (CURRENT.get() is not None or _ACTIVE.get() is not None or _INFO in session.info
                or scope['operationId'] != cap['operationId'] or scope['requestHash'] != cap['requestHash']
                or scope['planHash'] != cap['planHash'] or scope['customerId'] != cap['authority']['customerId']):
            _reject()
        _uuid(cap['nonce'])
        connection = session.connection()
        existing = connection.execute(text('SELECT @pos_rewrite_coupon_history_owner')).scalar_one()
        if existing is not None:
            connection.invalidate()
            _reject('ORDER_IMPORT_COUPON_HEADS_UNAVAILABLE')
        # Deliberately a nonlocking current comparison: early rejection saves
        # work, while the owned-trigger start revision closes the later race.
        actual = self.capture(session, scope)
        if actual != witness: _reject()
        frame = _Frame(self, session, connection, cap, scope, json.loads(canonical(witness)))
        session.info[_INFO] = frame
        token = _ACTIVE.set(frame)
        try:
            connection.execute(text('SET @pos_rewrite_coupon_history_owner=:owner'), {'owner': cap['nonce']})
            yield frame
            if frame.validated is None: _reject()
        finally:
            _ACTIVE.reset(token)
            try:
                if CURRENT.get() is not None: _reject()
                connection.execute(text('SET @pos_rewrite_coupon_history_owner=NULL'))
                frame.cleaned = True
            except Exception:
                connection.invalidate()
                _reject('ORDER_IMPORT_COUPON_HEADS_UNAVAILABLE')

    def validate_after_native(self, session, scope, witness, _native):
        frame = _ACTIVE.get()
        if (not isinstance(frame, _Frame) or frame.port is not self
                or frame.session is not getattr(session, 'session', session)
                or frame.transaction is not frame.session.get_transaction()
                or scope != frame.scope or witness != frame.witness or frame.validated is not None):
            _reject()
        rows = _heads(frame.session, frame.scope, lock=True)
        for row, frozen in zip(rows, frame.witness['heads']):
            original, revision = _revision(frozen['revision']), _revision(row['revision'])
            if row['owner'] == frame.nonce:
                if row['start'] is None or _revision(row['start']) != original or revision <= original: _reject()
            elif revision != original:
                _reject()
        frame.validated = rows
