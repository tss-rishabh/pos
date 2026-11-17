"""Owned localhost-only head-fence races; emits case names, never SQL/rows."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import threading
from uuid import uuid4
from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]
from benefit_history_heads import NativeCouponHistoryHeads
from protocol import ImportReview
from screening_transaction import owned, mark_customer
from transaction import private_session

value = json.loads(sys.stdin.read())
url = make_url(value['url'])
prefix = 'pos_rewrite_import_runtime_'
if (url.host not in ('localhost', '127.0.0.1') or not url.database.startswith(prefix)
        or len(url.database) != len(prefix) + 12 or url.query):
    raise RuntimeError('Disposable head fixture required')
engine = create_engine(url.set(drivername='mysql+pymysql'), echo=False, hide_parameters=True,
                       pool_size=4, max_overflow=0)
Session = sessionmaker(bind=engine, expire_on_commit=False)
port = NativeCouponHistoryHeads(value['key'])
scope = value['scope']
cap = {'nonce': str(uuid4()), 'operationId': scope['operationId'], 'requestHash': scope['requestHash'],
       'planHash': scope['planHash'], 'scope': {'actorId': '1', 'storeId': '1', 'counterId': '2'},
       'authority': {'customerId': scope['customerId']}}
case = value['case']


def enter(session):
    session.execute(text('SELECT id FROM users WHERE id=:id FOR UPDATE'), {'id': scope['customerId']}).one()
    mark_customer(session, cap, scope['customerId'])


def mutate(session):
    session.execute(text('UPDATE orders SET order_status=order_status+1 WHERE id=5001'))


def snapshot():
    with Session() as session, session.begin():
        return port.capture(session, scope)


def status(identity=5001):
    with engine.connect() as connection:
        return connection.execute(text('SELECT order_status FROM orders WHERE id=:id'), {'id': identity}).scalar_one()


def refused(action):
    try:
        action()
    except ImportReview as error:
        assert error.code in ('ORDER_IMPORT_COUPON_HEADS_CHANGED', 'ORDER_IMPORT_COUPON_HEADS_UNAVAILABLE')
        return
    raise AssertionError('Unqualified source transaction committed')


try:
    captured_sql = []
    def observe(_c, _cursor, statement, _parameters, _context, _many):
        captured_sql.append(' '.join(statement.split()).upper())
    event.listen(engine, 'before_cursor_execute', observe)
    port.assert_ready()
    assert captured_sql == [], 'Construction/assert_ready opened a native connection'
    frozen = snapshot()
    assert all(statement.startswith('SELECT ') for statement in captured_sql), 'Preview mutated native state'
    event.remove(engine, 'before_cursor_execute', observe)
    original = status()

    if case == 'own-multiple':
        with Session() as session, owned(session, cap):
            enter(session)
            with port.scope(session, cap, scope, frozen), private_session(session) as source:
                mutate(source)
                mutate(source)
                port.validate_after_native(source, scope, frozen, {})
            assert session.execute(text('SELECT @pos_rewrite_coupon_history_owner')).scalar_one() is None
        assert status() == original + 2
        after = snapshot()
        for before, head in zip(frozen['heads'], after['heads']):
            increment = 0 if before['kind'] == 'controls' else 2
            assert int(head['revision']) == int(before['revision']) + increment

    elif case.startswith('foreign-'):
        variant = case.removeprefix('foreign-')
        def writer():
            with engine.begin() as connection:
                if variant == 'order':
                    connection.execute(text('UPDATE orders SET order_status=order_status+1 WHERE id=5000'))
                elif variant == 'coupon':
                    connection.execute(text('UPDATE coupons SET no_times_allowed=no_times_allowed+1 WHERE id=222'))
                elif variant == 'log':
                    connection.execute(text('UPDATE order_coupon_log SET status=1-status WHERE id=4000'))
                else:
                    raise AssertionError('Unknown foreign mutation')
        def attempt():
            with Session() as session, owned(session, cap):
                enter(session)
                with port.scope(session, cap, scope, frozen), private_session(session) as source:
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        pool.submit(writer).result(timeout=5)
                    mutate(source)
                    port.validate_after_native(source, scope, frozen, {})
        refused(attempt)
        assert status() == original
        assert snapshot() != frozen

    elif case == 'rollback':
        class ExpectedRollback(Exception): pass
        try:
            with Session() as session, owned(session, cap):
                enter(session)
                with port.scope(session, cap, scope, frozen), private_session(session) as source:
                    mutate(source)
                    port.validate_after_native(source, scope, frozen, {})
                raise ExpectedRollback()
        except ExpectedRollback:
            pass
        assert snapshot() == frozen and status() == original

    elif case == 'stale-owner':
        with engine.connect() as connection:
            connection.execute(text('SET @pos_rewrite_coupon_history_owner=:nonce'), {'nonce': str(uuid4())})
        def attempt():
            with Session() as session, owned(session, cap):
                enter(session)
                with port.scope(session, cap, scope, frozen):
                    raise AssertionError('Stale pooled owner entered')
        refused(attempt)
        assert snapshot() == frozen and status() == original

    elif case == 'no-validation':
        def attempt():
            with Session() as session, owned(session, cap):
                enter(session)
                with port.scope(session, cap, scope, frozen), private_session(session) as source:
                    mutate(source)
        refused(attempt)
        assert snapshot() == frozen and status() == original

    elif case == 'after-validation':
        def attempt():
            with Session() as session, owned(session, cap):
                enter(session)
                with port.scope(session, cap, scope, frozen), private_session(session) as source:
                    mutate(source)
                    port.validate_after_native(source, scope, frozen, {})
                # The final commit guard must still reject this after the
                # invocation context and connection owner were already cleared.
                mutate(session)
        refused(attempt)
        assert snapshot() == frozen and status() == original

    elif case == 'later-writer-waits':
        attempted, completed = threading.Event(), threading.Event()
        def writer():
            with engine.begin() as connection:
                connection.execute(text('SET SESSION innodb_lock_wait_timeout=5'))
                attempted.set()
                connection.execute(text('UPDATE orders SET order_status=order_status+1 WHERE id=5000'))
            completed.set()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with Session() as session, owned(session, cap):
                enter(session)
                with port.scope(session, cap, scope, frozen), private_session(session) as source:
                    mutate(source)
                    port.validate_after_native(source, scope, frozen, {})
                    future = pool.submit(writer)
                    assert attempted.wait(5)
                    assert not completed.wait(0.2), 'Foreign writer escaped held late heads'
            future.result(timeout=5)
        assert completed.is_set() and status() == original + 1

    elif case == 'bad-witness':
        frozen['heads'][1]['revision'] = str(int(frozen['heads'][1]['revision']) + 1)
        def attempt():
            with Session() as session, owned(session, cap):
                enter(session)
                with port.scope(session, cap, scope, frozen):
                    raise AssertionError('Changed witness entered source')
        refused(attempt)
        assert status() == original

    elif case == 'bad-owner':
        with engine.connect() as connection:
            connection.execute(text('SET @pos_rewrite_coupon_history_owner=:nonce'), {'nonce': 'invalid'})
            try:
                connection.execute(text('UPDATE orders SET order_status=order_status+1 WHERE id=5001'))
            except Exception as error:
                assert getattr(error.orig, 'args', (None,))[0] == 1644
            else:
                raise AssertionError('Malformed owner wrote a watched source row')
            finally:
                connection.execute(text('SET @pos_rewrite_coupon_history_owner=NULL'))
                connection.rollback()
        assert snapshot() == frozen and status() == original
    else:
        raise AssertionError('Unknown fixture case')

    with engine.connect() as connection:
        assert connection.execute(text('SELECT @pos_rewrite_coupon_history_owner')).scalar_one() is None
    print(json.dumps({'passed': case, 'witness': snapshot(), 'headHash': port.head_hash(scope, snapshot())}))
finally:
    engine.dispose()
