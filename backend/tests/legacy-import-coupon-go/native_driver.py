"""Reuse pinned benefit constructors/refund oracle; NEVER run its deduction.

The actual confirmation/deduction is the Go bridge. This fixture is deliberately
not a complete private Receiver/profile-composition acceptance certificate.
"""
import importlib.util
import json
from pathlib import Path
import sys
from sqlalchemy import create_engine,event,text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/legacy-import-benefits'))
spec=importlib.util.spec_from_file_location('benefit_native_fixture',ROOT/'tools/legacy-import-benefits/native_driver.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
# The reusable fixture's serializer hardcodes its counter3. This new fixture
# uses the real current import counter and reads its native mapping BEFORE any
# scope/descriptor/HMAC is constructed. No production helper is replaced.
original_receipt=fixture.source_receipt
def scoped_receipt(session,state,plan,line_items):
    receipt=original_receipt(session,state,plan,line_items)
    mapping=session.execute(text('SELECT store_id,counter_id FROM order_stores WHERE order_id=5001 FOR SHARE')).mappings().one()
    receipt['storeId']=str(mapping['store_id']);receipt['counterId']=str(mapping['counter_id'])
    return receipt
fixture.source_receipt=scoped_receipt
value=json.load(sys.stdin)
url=make_url(value['url'])
if url.host not in ('127.0.0.1','localhost') or not url.database.startswith('pos_rewrite_import_runtime_') or len(url.database)!=len('pos_rewrite_import_runtime_')+12 or url.query:
    raise RuntimeError('Isolated coupon fixture required')
if value.get('consume') or value.get('mode'):raise RuntimeError('No Python coupon deduction or alternate fixture modes')
engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
event.listen(Session,'before_flush',fixture.normalize_source_sentinels)
try:
    with Session(engine) as session,session.begin():
        session.execute(text('SET timestamp=1781505000'))
        result=fixture.stage(session,value)
    print(json.dumps({'ok':True,'result':result},separators=(',',':'),allow_nan=False))
except Exception as error:
    import traceback
    native=getattr(error,'orig',None);args=getattr(native,'args',())
    print(json.dumps({'ok':False,'code':getattr(error,'code','COUPON_FIXTURE_FAILED'),
        'nativeCode':args[0] if args and type(args[0]) is int else None,'class':type(error).__name__,
        'frames':[Path(frame.filename).name+':'+str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)][-6:]},separators=(',',':')))
finally:engine.dispose()
