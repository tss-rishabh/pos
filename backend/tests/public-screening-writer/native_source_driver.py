"""Disposable native public-origin frame executing literal pinned PosOrder.

Only fixture catalog/validation I/O is synthetic. Authority, RC locks, original
constructors/HP/markers/refund writes, reservation and receipt are real MySQL.
"""
import importlib.util
import ast
import hashlib
import re
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
sys.path.insert(0,str(ROOT/'compatibility/upstream/screening-origins'))
sys.path.insert(0,str(ROOT/'compatibility/upstream/offline-cash-pricing'))
sys.path.insert(0,str(ROOT/'compatibility/upstream/public-screening-writer'))
from source_frame import NodePosWriterMiddleware,FRAME,after_validate
from writer_protocol import HEADER,ScreeningWriterError
from creation import read_creation
from transaction import normalize_source_sentinels,guard_private_statement,guard_private_commit,CURRENT
from protocol import ImportReview
from screening_profile import screened_base_profile,CONTRACT,SCHEMA,WRITERS
from screening_counter import public_scope,CounterReadRefused,_named
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
    event.listen(engine,'commit',guard_private_commit)
    event.listen(engine,'before_cursor_execute',guard_private_statement)
    sessions=sessionmaker(bind=engine,expire_on_commit=False)
    if value.get('action')=='counter-privileges':
        import os
        from screening_counter import _runtime_privileges,_definition
        try:
            with sessions() as session:
                with session.begin():_runtime_privileges(session,_definition(),os.environ['POS_SCREENING_COUNTER_TRIGGER_DEFINER'])
            return {'qualified':True}
        finally:engine.dispose()
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
        {'node':'pos-node-screening-writer-v1','profile':CONTRACT,'schema':SCHEMA,'writers':WRITERS},namespace,source.tasks,value['unitMode'],lambda:value['now'],counter_scope=public_scope,counter_refused=CounterReadRefused)
    req=SimpleNamespace(context={},method='POST',path='/api/v2/pos/order',params={},get_header=lambda name:value['header'] if name==HEADER else None)
    resp=SimpleNamespace(status='200 OK',body='',text='',set_header=lambda *_args:None)
    owner.process_request(req,resp)
    frame=FRAME.get()
    if frame is None:raise RuntimeError('Missing native frame')
    provenance=frame.session.info.get('screening_counter_creation_context')
    if value.get('gate'):
        gate=Path(value['gate']).resolve()
        if not gate.name=='release' or not gate.parent.name.startswith('pos-public-screening-'):raise RuntimeError('Invalid fixture gate')
    if value.get('probe'):
        from screening_counter import ReplaySession,_CURRENT_ORDER_SELECT,one as counter_one,writer_entry
        original_execute=ReplaySession.execute
        probed=False
        def probe_execute(replay,statement,parameters=None,**kwargs):
            nonlocal probed
            compact=' '.join(str(statement).split()).strip()
            mode=value['probe']
            address=compact.startswith('UPDATE orders SET has_address_id = ')
            point=compact==_CURRENT_ORDER_SELECT
            if not probed and (address and mode=='wrong-address' or point and mode!='wrong-address'):
                probed=True;native=replay.snapshot.session
                if mode=='wrong-address':
                    return original_execute(replay,text(compact.replace("= '88'","= '89'")),parameters,**kwargs)
                order=str(parameters['order_id'])
                if mode in ('old-order','other-customer-order'):
                    name=_named(native,'o','987')
                    counter_one(native,'SELECT GET_LOCK(:name,0) AS acquired',{'name':name})
                    native.connection().info.setdefault('screening_counter_owned_names',set()).add(name)
                    return original_execute(replay,statement,{**parameters,'order_id':987},**kwargs)
                if mode in ('created-order-without-authority','created-lines-without-authority'):
                    target='orders' if mode=='created-order-without-authority' else 'has_products'
                    column='id' if target=='orders' else 'order_id'
                    return original_execute(replay,text("UPDATE "+target+" SET created_at = '2026-06-15 12:00:00' WHERE "+column+" = "+order),{})
                if mode=='changed-header':
                    native.execute(text('UPDATE orders SET user_id=88 WHERE id=:id'),{'id':order})
                elif mode=='translated-bind':native.connection().execution_options(schema_translate_map={None:'unqualified_fixture_namespace'})
                elif mode=='other-attempt':
                    frame.counter_context.__exit__(None,None,None)
                    with writer_entry(native,replay.snapshot.customer):
                        return original_execute(replay,statement,parameters,**kwargs)
                elif mode=='other-transaction':
                    frame.counter_context.__exit__(None,None,None);native.rollback();native.begin()
                elif mode=='rollback-savepoint':frame.savepoint.rollback()
                elif mode=='old-line-in-new-order':
                    native.execute(text('UPDATE has_products SET order_id=:id WHERE id=10001'),{'id':order})
                    return original_execute(replay,text('select id, hp_tss_points_used, status, prod_id, price, gst, disc, wallet_disc, voucher_disc,store_disc_pg from has_products where order_id = '+order),{})
                elif mode=='old-line-update':
                    return original_execute(replay,text('UPDATE has_products SET amount_to_be_refunded = 1.0, fraction_value = 0 WHERE order_id = '+order+' and prod_id = 390238 AND id = 10001'),{})
                elif mode=='or-predicate':return original_execute(replay,text(compact+' OR 1=1'),parameters,**kwargs)
                elif mode=='union':return original_execute(replay,text(compact+' UNION SELECT * FROM orders'),parameters,**kwargs)
                elif mode=='aggregate':return original_execute(replay,text('SELECT COUNT(*) FROM orders WHERE user_id=:user_id'),{'user_id':77})
            return original_execute(replay,statement,parameters,**kwargs)
        ReplaySession.execute=probe_execute
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
            from source_products import checked_tree,ORDER_HELPER_SHA256
            _,helper_tree=checked_tree(Path(root),'libs/OrderHelper.py',ORDER_HELPER_SHA256)
            current_order=next(item for item in helper_tree.body if isinstance(item,ast.FunctionDef) and item.name=='fetch_order')
            exec(compile(ast.Module(body=[current_order],type_ignores=[]),'<pinned-current-order-fetch>','exec'),namespace)
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
        if value.get('escapeCommit'):frame.session.connection().commit()
        if value.get('lateFailure'):raise ScreeningWriterError('SCREENING_WRITER_FIXTURE_LATE_FAILURE')
        if value.get('gate'):
            print('PUBLIC_BODY_READY',flush=True)
            deadline=time.monotonic()+10
            while not gate.is_file():
                if time.monotonic()>deadline:raise RuntimeError('Fixture gate timeout')
                time.sleep(.01)
    except BaseException as error:
        failure=error
    if 'finishNow' in value:value['now']=value['finishNow']
    try:frame.finish(req,resp,failure is None)
    except ScreeningWriterError as error:
        if failure is None:failure=error
    finally:
        pool_locks_released=True
        try:
            if value.get('probe') or value.get('poolCheck'):
                # Reuse the live pool before dispose; disconnect cannot mask a
                # leaked advisory lock from this real native attempt.
                with engine.connect() as check:
                    identities=[('u',frame.cap['customerId'])]
                    if provenance:
                        identities += [('o',identity) for identity in provenance['orders']]
                        identities += [('p',identity) for identity in provenance['lines']]
                    identities += [('o','987')]
                    for kind,identity in identities:
                        held=check.execute(text('SELECT IS_USED_LOCK(:name) AS held'),{'name':_named(check,kind,identity)}).mappings().one()['held']
                        if held is not None:pool_locks_released=False
        finally:engine.dispose()
    if failure is not None:
        code=failure.code if isinstance(failure,(ScreeningWriterError,ImportReview)) else 'PUBLIC_SCREENING_FIXTURE_FAILED'
        import traceback
        contexts=[];cursor=failure
        for _ in range(4):
            if cursor is None:break
            native=getattr(cursor,'orig',None)
            denied=re.search(r"for table '([A-Za-z0-9_]+)'",str(getattr(native,'args',('', ''))[-1]))
            contexts.append({'type':type(cursor).__name__,'nativeCode':getattr(native,'args',(None,))[0], 'signal':next((str(v) for v in getattr(native,'args',()) if isinstance(v,str) and v.startswith('Screening counter')),None),'deniedTable':denied.group(1) if denied else None,'frames':[Path(frame.filename).name+':'+str(frame.lineno) for frame in traceback.extract_tb(cursor.__traceback__)]})
            cursor=cursor.__context__
        return {'code':code,'fixtureErrors':contexts,**({'fixturePoolLocksReleased':pool_locks_released} if value.get('probe') or value.get('poolCheck') else {})}
    return {'result':json.loads(resp.body),**({'fixturePoolLocksReleased':pool_locks_released} if value.get('poolCheck') else {})}


if __name__=='__main__':
    try:print(json.dumps(run(json.loads(sys.stdin.read())),separators=(',',':')))
    except (ScreeningWriterError,ImportReview) as error:print(json.dumps({'code':error.code}))
    except BaseException as error:
        import traceback
        native=getattr(error,'orig',None)
        denied=re.search(r"for table '([A-Za-z0-9_]+)'",str(getattr(native,'args',('', ''))[-1]))
        print(json.dumps({'code':'PUBLIC_SCREENING_FIXTURE_FAILED','fixtureErrors':[{'type':type(error).__name__,'deniedTable':denied.group(1) if denied else None,'frames':[Path(frame.filename).name+':'+str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)]}]}))
        sys.exit(1)
