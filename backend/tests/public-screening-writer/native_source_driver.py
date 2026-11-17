"""Disposable native public-origin frame executing literal pinned PosOrder.

Only fixture catalog/validation I/O is synthetic. Authority, RC locks, original
constructors/HP/markers/refund writes, reservation and receipt are real MySQL.
"""
import importlib.util
import ast
import hashlib
import json
import sys
import time
from pathlib import Path
from types import ModuleType,SimpleNamespace
from sqlalchemy import create_engine,event,text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker,Session

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports'))
sys.path.insert(0,str(ROOT/'compatibility/upstream/offline-cash-pricing'))
sys.path.insert(0,str(ROOT/'compatibility/upstream/public-screening-writer'))
from source_frame import NodePosWriterMiddleware,FRAME,after_validate
from writer_protocol import HEADER,ScreeningWriterError
from creation import read_creation
from transaction import normalize_source_sentinels,guard_private_statement,guard_private_commit,CURRENT
from protocol import ImportReview
from screening_profile import screened_base_profile,CONTRACT,SCHEMA,WRITERS
from native_source_driver import Cart,K,NativePipeline
import native_source_driver as original_driver

spec=importlib.util.spec_from_file_location('pinned_screening_fixture',ROOT/'tests/legacy-import-screening/native_source_driver.py')
screening=importlib.util.module_from_spec(spec);spec.loader.exec_module(screening)
module=ModuleType('controllers.cart.Cart');module.ItemTypes=K
sys.modules['controllers.cart.Cart']=module


def cart_json(cart,**_kwargs):
    return json.dumps({'products':{'items':cart.products},'giftvouchers':{'items':[]},'complementary_products':{'items':[]},
                       'meta':{'items':[{**item,'name':name} for name,item in cart.meta.items() if item is not None]}})


Cart.json=cart_json


def run(value):
    plan={'kind':'offline','lines':value['lines'],'createdAt':'2026-06-15 12:00:00',
          'originalTenderAmount':format(sum(float(row['unitPrice'])*row['quantity'] for row in value['lines']),'.2f')}
    if value.get('action')=='quote':return json.loads(cart_json(Cart(plan)))
    url=make_url(value['url'])
    if (url.host not in ('localhost','127.0.0.1') or not url.database.startswith('pos_rewrite_import_runtime_') or
        len(url.database)!=len('pos_rewrite_import_runtime_')+12 or url.query):raise RuntimeError('Isolated localhost fixture required')
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
    event.listen(Session,'before_flush',normalize_source_sentinels)
    event.listen(Session,'before_commit',guard_private_commit)
    event.listen(engine,'before_cursor_execute',guard_private_statement)
    sessions=sessionmaker(bind=engine,expire_on_commit=False)
    source=NativePipeline(value['sourceRoot'],None)
    # Real Cart.re_init hydrates this metadata through make_payment_details.
    # The lightweight Cart fixture used to accept an already-hydrated id only;
    # execute the pinned initializer for the actual unchanged Node wire too.
    initializer=Path(value['sourceRoot'])/'controllers/cart/initializers/MetaInitializers.py'
    raw_initializer=initializer.read_bytes()
    if hashlib.sha256(raw_initializer).hexdigest()!='e631cbac8c1f2f50e9692fdc128c15d0d1eefac64a21556201068a81e75d4e9f':
        raise RuntimeError('Pinned payment initializer changed')
    node=next(item for item in ast.parse(raw_initializer).body if isinstance(item,ast.FunctionDef) and item.name=='make_payment_details')
    functions={};exec(compile(ast.Module(body=[node],type_ignores=[]),'<pinned-payment-initializer>','exec'),functions)
    class PaymentLookup:
        def execute(self,query,params):
            if query!='select id from payment_method WHERE value = :payment_method':raise RuntimeError('Unexpected fixture payment lookup')
            # Synthetic read-only reference I/O, matching source POC14/zero3.
            result={'id':{'coc':14,'prepaid':3}[params['payment_method']]}
            return SimpleNamespace(fetchone=lambda:result)
    def re_init(cart):
        details=cart.meta.get('payment_details')
        if details and details.get('payment_method') in ('coc','prepaid'):
            functions['make_payment_details'](PaymentLookup(),details)
        return cart
    Cart.re_init=re_init
    route=source.tasks.app.amqp.router.route
    def checked_route(*args,**kwargs):
        if CURRENT.get() is not None:raise RuntimeError('Fixture router ran under source SQL scope')
        return route(*args,**kwargs)
    source.tasks.app.amqp.router.route=checked_route
    if value.get('action')=='effects':
        from public_effects import publish
        try:
            result=publish(sessions,value['operationId'],value['proofKey'],source.tasks,lambda:value['now'])
            return {**result,'queueCalls':len(source.tasks.accepted)}
        finally:engine.dispose()
    source.settings.API_PREFIX='/api/v2'
    source.settings.POS_API_PREFIX='/api/v2/pos'
    source.settings.IS_LINE_ITEM_ENABLED=value['unitMode']
    namespace={'settings':source.settings,'json':json,'get_gst_status_from_redis':lambda _session:True,
               'cart_inclusive_gst':lambda _product:None,'get_exclusive_upgrade_product':lambda _cart:None}
    owner=NodePosWriterMiddleware(sessions,value['sourceRoot'],value['key'],value['proofKey'],
        {'node':'pos-node-screening-writer-v1','profile':CONTRACT,'schema':SCHEMA,'writers':WRITERS},namespace,source.tasks,value['unitMode'],lambda:value['now'])
    req=SimpleNamespace(context={},method='POST',path='/api/v2/pos/order',params={},get_header=lambda name:value['header'] if name==HEADER else None)
    resp=SimpleNamespace(status='200 OK',body='',text='',set_header=lambda *_args:None)
    owner.process_request(req,resp)
    frame=FRAME.get()
    if frame is None:raise RuntimeError('Missing native frame')
    if value.get('gate'):
        gate=Path(value['gate']).resolve()
        if not gate.name=='release' or not gate.parent.name.startswith('pos-public-screening-'):raise RuntimeError('Invalid fixture gate')
    original_compile=screening.compile_screening
    def controlled_compile(root,path,name,namespace):
        if name=='PosOrder':
            screening.FIXTURE_ADDRESS=88 if frame.cap['customerId']=='77' else 89
            validate=namespace['ValidateCheckout']
            class Validated:
                def on_post(self,inner,response):
                    validate().on_post(inner,response)
                    after_validate(inner)
            namespace['ValidateCheckout']=Validated
        target=original_compile(root,path,name,namespace)
        if name!='PosOrder':return target
        class Controlled:
            def on_post(self,inner,response):
                # The real resource sees the independently authenticated user,
                # while native lock_authority is the only financial scope proof.
                req.context.update(inner.context)
                req.context['data']=dict(value['payload'])
                req.context['pos_rewrite_fresh_customer']={'subject':frame.cap['customerId'],'loaded':True}
                result=target().on_post(req,response)
                resp.body,resp.text,resp.status=response.body,response.text,response.status
                return result
        return Controlled
    original_driver.compile_class=controlled_compile
    # The private CSV fixture's policy is not public POS authority. Remove only
    # its explicit ticket rejection; leave the literal actual controller intact.
    original_driver.assert_plain_profile=screened_base_profile(__import__('profiles').assert_plain_profile)
    # This fixture revision imports that global inside its function; bind the
    # module too, only in this disposable interpreter.
    __import__('profiles').assert_plain_profile=original_driver.assert_plain_profile
    user={**frame.customer,'user_id':int(frame.cap['customerId']),'is_exclusive':False,'batch':'A'}
    failure=None
    try:
        cap={'scope':{'actorId':frame.cap['actorId'],'storeId':frame.cap['storeId'],'counterId':frame.cap['counterId']}}
        source.order_pipeline(frame.source,user,plan,cap)
        if value.get('lateFailure'):raise ScreeningWriterError('SCREENING_WRITER_FIXTURE_LATE_FAILURE')
        if value.get('gate'):
            print('PUBLIC_BODY_READY',flush=True)
            deadline=time.monotonic()+10
            while not gate.is_file():
                if time.monotonic()>deadline:raise RuntimeError('Fixture gate timeout')
                time.sleep(.01)
    except Exception as error:
        failure=error
    try:frame.finish(req,resp,failure is None)
    except ScreeningWriterError as error:
        if failure is None:failure=error
    finally:engine.dispose()
    if failure is not None:
        code=failure.code if isinstance(failure,(ScreeningWriterError,ImportReview)) else 'PUBLIC_SCREENING_FIXTURE_FAILED'
        import traceback
        contexts=[];cursor=failure
        for _ in range(4):
            if cursor is None:break
            contexts.append({'type':type(cursor).__name__,'frames':[Path(frame.filename).name+':'+str(frame.lineno) for frame in traceback.extract_tb(cursor.__traceback__)]})
            cursor=cursor.__context__
        return {'code':code,'fixtureErrors':contexts}
    return {'result':json.loads(resp.body)}


if __name__=='__main__':
    try:print(json.dumps(run(json.loads(sys.stdin.read())),separators=(',',':')))
    except (ScreeningWriterError,ImportReview) as error:print(json.dumps({'code':error.code}))
    except Exception:
        print('{"code":"PUBLIC_SCREENING_FIXTURE_FAILED"}')
        sys.exit(1)
