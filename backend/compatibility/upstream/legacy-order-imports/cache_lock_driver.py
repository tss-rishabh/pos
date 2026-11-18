"""Disposable actual cache-consumer locks, Go replay race and retained effects."""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
import threading
import time
from urllib.parse import urlparse
from sqlalchemy import create_engine,event,text
from sqlalchemy.orm import sessionmaker
from protocol import ImportReview
import membership_cache as cache

url=urlparse(os.environ['MEMBERSHIP_NATIVE_URL'])
if url.scheme!='mysql+pymysql' or url.hostname!='127.0.0.1' or url.path!='/pos_checkout_contract_test' or not url.port or url.password or url.query:
    raise RuntimeError('Disposable cache lock fixture required')
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'pending-cancellation'))
from native_membership_account import read_membership_account
admin_engine=create_engine(os.environ['MEMBERSHIP_NATIVE_URL'],pool_size=4,max_overflow=0,echo=False,hide_parameters=True)
application_url,native_environment=read_membership_account(os.environ['MEMBERSHIP_NATIVE_URL'])
os.environ.update(native_environment)
engine=create_engine(application_url,pool_size=24,max_overflow=0,echo=False,hide_parameters=True)
Session=sessionmaker(bind=engine)
OP='5a5d1efb-727e-45ea-b214-9136be787031';KEY=os.environ['POS_LEGACY_IMPORT_PROOF_KEY']

def execute(statement,params=None):
    with admin_engine.begin() as connection:return connection.execute(text(statement),params or {})

def scalar(statement,params=None):
    with admin_engine.connect() as connection:return connection.execute(text(statement),params or {}).scalar_one()

def reset():execute("DELETE FROM pos_rewrite_import_financial_source_receipts WHERE kind='member-cache'")

def assert_blocked(statement,params=None):
    with engine.connect() as connection,connection.begin():
        try:connection.execute(text(statement),params or {}).all()
        except Exception as error:
            assert getattr(getattr(error,'orig',None),'args',(None,))[0]==3572,'Expected native NOWAIT scope lock'
        else:raise AssertionError('Required early native lock was absent')

try:
    seal=scalar("SELECT proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind='membership'",{'op':OP})
    calls=[]
    if sys.argv[1]=='race':
        marker=Path(sys.argv[2])
        if not marker.parent.name.startswith('pos-csv-cache.') or marker.name!='customer-ready':raise RuntimeError('Owned ephemeral marker required')
        seen=[False]
        def before_order(_connection,_cursor,statement,_params,_context,_many):
            if seen[0] or 'FROM orders WHERE id=' not in statement or not statement.rstrip().endswith('FOR UPDATE'):return
            seen[0]=True
            # At the exact boundary BEFORE its Order lock, all preceding locks
            # must exist. No observer/witness is forged by this fixture.
            assert_blocked('SELECT id FROM stores WHERE id=1 FOR UPDATE NOWAIT')
            assert_blocked('SELECT id FROM pos_rewrite_import_financial_operations WHERE id=:id FOR UPDATE NOWAIT',{'id':OP})
            assert_blocked('SELECT id FROM users WHERE id=77 FOR UPDATE NOWAIT')
            with engine.connect() as probe,probe.begin():probe.execute(text('SELECT id FROM orders WHERE id=5001 FOR UPDATE NOWAIT')).all()
            marker.write_text('ready\n')
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                waiting=scalar("SELECT COUNT(*) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks d ON d.ENGINE=w.ENGINE AND d.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE d.OBJECT_SCHEMA=DATABASE() AND d.OBJECT_NAME='stores'")
                if waiting:return
                time.sleep(.01)
            raise AssertionError('Original Go replay did not reach its Store wait')
        event.listen(engine,'before_cursor_execute',before_order)
        cache.invalidate(Session,KEY,OP,seal,lambda *_args:calls.append(1))
        event.remove(engine,'before_cursor_execute',before_order)
        cache.invalidate(Session,KEY,OP,seal,lambda *_args:calls.append(1))
        assert seen==[True] and calls==[1]
        print('actual cache consumer: actor/Store/operation/customer before Order; concurrent original Go replay; one retained invalidation')
    elif sys.argv[1]=='guards':
        reset()
        original_hint=cache.retained_hint
        for change,restore in (
            ("UPDATE pos_rewrite_import_financial_operations SET plan_hash=REPEAT('e',64)","UPDATE pos_rewrite_import_financial_operations SET plan_hash=REPEAT('b',64)"),
            ("UPDATE pos_rewrite_import_financial_operations SET store_id='2'","UPDATE pos_rewrite_import_financial_operations SET store_id='1'"),
            ("UPDATE orders SET user_id=78 WHERE id=5001","UPDATE orders SET user_id=77 WHERE id=5001"),
        ):
            def changed(*args):
                result=original_hint(*args);execute(change);return result
            cache.retained_hint=changed
            try:
                try:cache.invalidate(Session,KEY,OP,seal,lambda *_args:calls.append(1));raise AssertionError('Changed immutable hint admitted')
                except ImportReview as error:assert error.code=='ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED'
                assert not calls and scalar("SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts WHERE kind='member-cache'")==0
            finally:cache.retained_hint=original_hint;execute(restore)
        print('actual cache consumer: changed plan/store/customer hint refused without a claim or Redis call')
        execute("CREATE TRIGGER csv_cache_claim_failure BEFORE INSERT ON pos_rewrite_import_financial_source_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='private cache SQL canary'")
        try:
            try:cache.invalidate(Session,KEY,OP,seal,lambda *_args:calls.append(1))
            except Exception:pass
            else:raise AssertionError('Late native claim failure expected')
            assert not calls and scalar("SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts WHERE kind='member-cache'")==0
        finally:execute('DROP TRIGGER csv_cache_claim_failure')
        print('actual cache consumer: late claim SQL failure rolled back before Redis')
        execute('UPDATE pos_user SET is_active=0 WHERE id=44');execute('UPDATE stores SET is_active=0 WHERE id=1')
        cache.invalidate(Session,KEY,OP,seal,lambda *_args:calls.append(1));cache.invalidate(Session,KEY,OP,seal,lambda *_args:calls.append(1))
        assert calls==[1]
        execute('UPDATE pos_user SET is_active=1 WHERE id=44');execute('UPDATE stores SET is_active=1 WHERE id=1')
        print('actual cache consumer: archived original actor/store retained one proved invalidation and immutable replay')
        reset();calls.clear();arrived=threading.Event();release=threading.Event()
        def pending(*_args):calls.append(1);arrived.set();assert release.wait(10)
        def contender(_):
            try:cache.invalidate(Session,KEY,OP,seal,pending)
            except ImportReview as error:assert error.code=='ORDER_IMPORT_MEMBERSHIP_CACHE_UNCERTAIN'
        with ThreadPoolExecutor(max_workers=20) as pool:
            futures=[pool.submit(contender,index) for index in range(20)]
            assert arrived.wait(5)
            deadline=time.monotonic()+5
            while sum(future.done() for future in futures)<19 and time.monotonic()<deadline:time.sleep(.01)
            assert sum(future.done() for future in futures)==19 and calls==[1]
            release.set()
            for future in futures:future.result(timeout=5)
        cache.invalidate(Session,KEY,OP,seal,lambda *_args:calls.append(1));assert calls==[1]
        print('actual cache consumer:20 contenders, one post-commit callback, original processing/unknown never resends')
        reset();calls.clear()
        def unknown(*_args):calls.append(1);raise RuntimeError('private Redis outcome canary')
        for _ in range(2):
            try:cache.invalidate(Session,KEY,OP,seal,unknown);raise AssertionError('Unknown cache outcome expected')
            except ImportReview as error:assert error.code=='ORDER_IMPORT_MEMBERSHIP_CACHE_UNCERTAIN'
        assert calls==[1]
        print('actual cache consumer: unknown outcome is durable and never automatically replays')
    else:raise RuntimeError('Unknown owned fixture action')
finally:engine.dispose();admin_engine.dispose()
