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
from sqlalchemy.pool import Pool
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
_CONTROL_READ = """SELECT kind,scope_id AS scopeId,CAST(revision AS CHAR) AS revision,
 last_owner_nonce AS owner,CAST(owner_start_revision AS CHAR) AS start
 FROM pos_rewrite_coupon_history_heads
 WHERE (kind='controls' AND scope_id='0') OR (kind='coupon' AND scope_id=:coupon)
 ORDER BY kind,scope_id LIMIT 3"""


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


def _heads(session, scope, *, lock=False, controls_only=False):
    # The transaction already owns X locks for heads its triggers changed.
    # Shared late locks fence foreign changes without serializing unrelated
    # coupon transactions through the unchanged global controls head.
    parameters = {'coupon': scope['couponId']}
    expected = [('controls', '0'), ('coupon', scope['couponId'])]
    if not controls_only:
        parameters['customer'] = scope['customerId']
        expected.append(('customer', scope['customerId']))
    values = _rows(session, (_CONTROL_READ if controls_only else _READ) + (' FOR SHARE' if lock else ''),
                   parameters, len(expected))
    if len(values) != len(expected): _reject()
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
        self.commit_guard = lambda connection: _before_commit(self, connection)


def _before_commit(frame, connection):
    session = frame.session
    # A caller cannot validate early and mutate another watched table later.
    # This is the physical root commit event, AFTER SQLAlchemy's automatic
    # flush. Session.before_commit also fires when a legitimate source freebie
    # SAVEPOINT is released; skipping it based on an open savepoint would let
    # an outer Session.commit bypass the fence before cascading that savepoint.
    try:
        if (connection is not frame.connection or CURRENT.get() is not None
                or not frame.cleaned or frame.validated is None
                or frame.transaction is not session.get_transaction()
                or session.new or session.dirty or session.deleted):
            _reject()
        if _heads(connection, frame.scope, lock=True) != frame.validated:
            _reject()
    except Exception:
        # An exception from a commit event can deactivate SQLAlchemy's root
        # transaction before its normal rollback. Drop the physical connection
        # so no uncommitted native change can survive a later pool checkout.
        _discard(frame)
        raise


def _discard(frame):
    if not frame.connection.closed and not frame.connection.invalidated:
        frame.connection.invalidate()


def _pool_return(_dbapi_connection, record):
    frame = record.info.pop(_INFO, None)
    if isinstance(frame, _Frame) and not frame.cleaned:
        # This callback runs before a returned connection becomes available.
        # It also handles an unexpected close inside the owned source scope.
        record.invalidate()


def _after_transaction(session, transaction):
    frame = session.info.get(_INFO)
    if isinstance(frame, _Frame) and frame.transaction is transaction:
        session.info.pop(_INFO, None)
        event.remove(frame.connection, 'commit', frame.commit_guard)
        if not frame.cleaned:
            # Never return a connection carrying an owner variable to the pool.
            _discard(frame)


# Registration performs no SQL or external I/O. Unselected sessions only take
# the dictionary lookup; they never acquire a head or read any source table.
event.listen(Session, 'after_transaction_end', _after_transaction)
event.listen(Pool, 'checkin', _pool_return)


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

    def _identity(self, session):
        manifest = self.assert_ready()
        if not isinstance(session, Session) or not session.in_transaction(): _reject()
        # Open each watched table without reading history. MDL prevents trigger
        # replacement between metadata qualification and the enclosing commit.
        for table in ('orders', 'order_coupon_log', 'coupons', 'users'):
            result = session.execute(text('SELECT id FROM ' + table + ' LIMIT 0'))
            result.close()
        from origin_history_privileges import qualified_head_metadata
        actual = qualified_head_metadata(session)['couponTriggers']
        if len(actual) != 10 or len({row['name'] for row in actual}) != 10: _reject()
        for expected in manifest['definitions']:
            matches=[row for row in actual if row['name']==expected['name']]
            if (len(matches)!=1 or matches[0]['tableName']!=expected['table']
                    or matches[0]['event']!=expected['event'] or matches[0]['timing']!=expected['timing']
                    or matches[0]['hash']!=hashlib.sha256(expected['statement'].encode()).hexdigest()):
                _reject('ORDER_IMPORT_COUPON_HEADS_UNAVAILABLE')
        identities = _rows(session, 'SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema', maximum=1)
        if len(identities) != 1: _reject()
        identity = identities[0]
        _uuid(identity['serverUuid'])
        if not isinstance(identity['sourceSchema'], str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', identity['sourceSchema']):
            _reject()
        return {'writersContract': _CONTRACT, 'writersDefinitionHash': manifest['definitionHash'], **identity}

    def capture(self, session, supplied):
        scope = _scope(supplied)
        return {**self._identity(session), 'heads': _public_heads(_heads(session, scope))}

    def capture_controls(self, session, coupon_id):
        """Global publisher metadata without inventing a financial operation."""
        if (not isinstance(coupon_id, str) or not re.fullmatch(r'[1-9][0-9]{0,9}', coupon_id)
                or int(coupon_id) > 2147483647):
            _reject()
        return {**self._identity(session),
                'heads': _public_heads(_heads(session, {'couponId': coupon_id}, controls_only=True))}

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
        connection.info[_INFO] = frame
        event.listen(connection, 'commit', frame.commit_guard)
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
                _discard(frame)
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
