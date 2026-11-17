"""Disposable source prelude/witness races, no source app or external I/O."""
import json
from pathlib import Path
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from sqlalchemy import create_engine,event,text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
from protocol import verify_capability,ImportReview
from native import lock_command,fresh_authority
from screening_transaction import owned,mark_customer,current
from transaction import private_session

value=json.loads(sys.stdin.read());url=make_url(value['url'])
if (url.host not in ('127.0.0.1','localhost') or not url.database.startswith('pos_rewrite_import_runtime_') or len(url.database)!=len('pos_rewrite_import_runtime_')+12 or url.query):
    raise RuntimeError('Disposable source transaction fixture required')
cap=verify_capability(value['key'],value['cap'],value['cap']['operationId'],'order',value['plan'],value['now'])
engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True,pool_size=4,max_overflow=0)
Session=sessionmaker(bind=engine,expire_on_commit=False)
passed=[]
try:
    with Session() as session:
        session.execute(text('SELECT id FROM users WHERE id=:id'),{'id':cap['authority']['customerId']})
        try:
            with owned(session,cap):raise AssertionError('Primed transaction admitted')
        except ImportReview as error:assert error.code=='ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED'
        session.rollback();passed.append('primed-rejected')
    for forbidden in ('SELECT id FROM users WHERE id=:id','SELECT id FROM orders WHERE id=:id FOR UPDATE','UPDATE orders SET order_status=order_status WHERE id=:id'):
        with Session() as session:
            before=session.execute(text('SELECT namespace FROM pos_rewrite_import_financial_operations WHERE id=:id'),{'id':cap['operationId']}).scalar_one();session.rollback()
            try:
                with owned(session,cap):
                    session.execute(text("UPDATE pos_rewrite_import_financial_operations SET namespace='fixture-uncommitted-canary' WHERE id=:id"),{'id':cap['operationId']})
                    try:session.execute(text(forbidden),{'id':cap['authority']['customerId']})
                    except ImportReview:pass
            except ImportReview as error:assert error.code=='ORDER_IMPORT_SCREENING_LOCK_ORDER'
            else:raise AssertionError('Swallowed pre-customer violation committed')
            assert session.execute(text('SELECT namespace FROM pos_rewrite_import_financial_operations WHERE id=:id'),{'id':cap['operationId']}).scalar_one()==before
        passed.append('sticky-order-or-snapshot-rejected')
    with Session() as session,owned(session,cap):
        lock_command(session,cap,'order');user=fresh_authority(session,cap)
        try:current(session,cap);raise AssertionError('Unmarked customer admitted')
        except ImportReview:pass
        mark_customer(session,cap,str(user['id']))
        with private_session(session) as private:
            assert current(private,cap) is current(session,cap)
        session.execute(text('SELECT id FROM users WHERE id=:id'),{'id':cap['authority']['customerId']}).one()
        assert current(session,cap).customer_id==cap['authority']['customerId']
    passed.append('owned-current-and-private-wrapper')
    # An immutable service receipt still needs its original locks, not a live
    # actor. The fresh-authority path separately rejects new work after archive.
    with engine.begin() as connection:connection.execute(text('UPDATE pos_user SET is_active=0 WHERE id=:id'),{'id':cap['scope']['actorId']})
    with Session() as session,owned(session,cap):lock_command(session,cap,'order')
    with engine.begin() as connection:connection.execute(text('UPDATE pos_user SET is_active=1 WHERE id=:id'),{'id':cap['scope']['actorId']})
    passed.append('retained-archived-prefix')
    # Same customer, different stores. The hint is deliberately taken BEFORE
    # the other store's committed count-affecting status change.
    with engine.connect() as connection:
        hint=connection.execute(text('SELECT order_status FROM orders WHERE id=:id'),{'id':value['historicalOrderId']}).scalar_one()
    attempted=threading.Event();reader_id=[None]
    def notice(_c,_cursor,statement,_parameters,_context,_many):
        if (threading.get_ident()==reader_id[0] and 'FROM users WHERE id=' in statement and 'FOR UPDATE' in statement):attempted.set()
    event.listen(engine,'before_cursor_execute',notice)
    def read_after_wait():
        reader_id[0]=threading.get_ident()
        with Session() as session,owned(session,cap):
            lock_command(session,cap,'order');user=fresh_authority(session,cap)
            mark_customer(session,cap,str(user['id']));current(session,cap)
            return session.execute(text('SELECT order_status FROM orders WHERE id=:id'),{'id':value['historicalOrderId']}).scalar_one()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with engine.begin() as writer:
            writer.execute(text('SELECT id FROM stores WHERE id=2 FOR UPDATE')).one()
            writer.execute(text('SELECT id FROM users WHERE id=:id FOR UPDATE'),{'id':cap['authority']['customerId']}).one()
            writer.execute(text('UPDATE orders SET order_status=1 WHERE id=:id'),{'id':value['historicalOrderId']})
            future=pool.submit(read_after_wait)
            assert attempted.wait(5),'Source reader did not reach global customer wait'
        fresh=future.result(timeout=5)
    event.remove(engine,'before_cursor_execute',notice)
    assert hint==0 and fresh==1,'A stale pre-customer RR snapshot escaped the source witness'
    passed.append('cross-store-stale-hint-fresh-view')
    print(json.dumps({'passed':passed,'hint':hint,'current':fresh}))
finally:engine.dispose()
