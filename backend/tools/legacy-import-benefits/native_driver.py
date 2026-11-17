"""Disposable localhost native proof; original constructors/grants/refunds run.
No live URLs, source application bootstrap, provider, AWS or network history.
"""
import ast
import copy
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from sqlalchemy import create_engine, text, event, Table
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

HERE=Path(__file__).resolve().parent
BACKEND=HERE.parents[1]
PROFILE=BACKEND/'compatibility/upstream/legacy-order-imports/benefit-profile'
sys.path.insert(0,str(PROFILE));sys.path.insert(0,str(PROFILE.parent))
from benefit_source import strict_pos_grants, checked, source_coupon_deduction, BenefitReview, compile_coupon, compile_class
from benefit_codec import install_complementary_codec
from benefit_claims import SqlBirthdayCache, legacy_guard_observation, GUARD_CONTRACT
from benefit_history import seal, canonical
from benefit_profile import CouponCandidate
from benefit_receipts import coupon_users, coupon_receipt, complementary_receipt, coupon_consumption_receipt, store_descriptor, current_coupon_control
from source_oracle import source_line_products, coupon_row, Cache, history, source_coupon, SourceClock, ROOT, POINT, KEY
from source_template import source_models
from source_refunds import refund_tree
from transaction import normalize_source_sentinels, LegacyResult
from native import HEADER, LINE
from protocol import SOURCE_CONTRACT
from source_calculator import ItemTypes, SilentLogger
from model_compat import install_model_codec

class Proxy:
    def __init__(self,session): self.session=session
    def execute(self,query,params=None,**kwargs):
        # Fixture isolation: the source hardcodes its operational schema tss
        # for ONE current coupon SELECT. Bind the same table in this random
        # schema; never create/drop a shared tss database or change source SQL.
        raw=str(query)
        if raw.startswith('select no_times_allowed as num from tss.coupons where id='):
            query=raw.replace('from tss.coupons ', 'from coupons ', 1)
        return LegacyResult(self.session.execute(text(query) if isinstance(query,str) else query,params or kwargs.get('params') or {}))
    def add(self,value): return self.session.add(value)
    def add_all(self,values): return self.session.add_all(values)
    def commit(self): self.session.flush()


def source_receipt(session,state,plan,line_items):
    header=session.execute(text('SELECT '+HEADER+' AS hash,CAST(CAST(pay_amt AS DECIMAL(12,2)) AS CHAR) AS payable FROM orders WHERE id=5001 FOR UPDATE')).mappings().one()
    rows=session.execute(text('SELECT id,prod_id,qty,'+LINE+' AS hash FROM has_products WHERE order_id=5001 ORDER BY id FOR UPDATE')).mappings().all()
    lines=[{'id':str(row['id']),'productId':str(row['prod_id']),'quantity':row['qty'],'inputHash':row['hash']} for row in rows]
    digest=hashlib.sha256('\n'.join(f"{row['id']}:{row['productId']}:{row['quantity']}:{row['inputHash']}" for row in lines).encode()).hexdigest()
    return {'contract':SOURCE_CONTRACT,'operationId':state['scope']['operationId'],'requestHash':state['requestHash'],'namespace':state['namespace'],
        'customerId':'77','storeId':'1','counterId':'3','createdAt':plan['createdAt'],'orderId':'5001',
        'headerHash':header['hash'],'lineHash':digest,'method':14 if plan['kind']=='offline' else 15,'payable':header['payable'],
        'refundAllocationContract':'pos-refund-per-hp-v1','refundSourcePatchHash':'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
        'sourceCommit':'2960acbea10c4eaf16b6d99e15ff6e03ef7724c5','sourceControllerHash':'d8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18',
        'lineItemsEnabled':line_items,'lines':lines,'effectsHash':'a'*64}


def claim_scope(value):
    return {'contract':'pos-csv-coupon-history-v1','operationId':value['state']['scope']['operationId'],
        'requestHash':value['state']['requestHash'],'planHash':value['state']['planHash'],'customerId':'77','couponId':'222',
        'configurationHash':'c'*64,'asOf':'2026-06-15 12:00:00','sourceTimeZone':'Asia/Kolkata'}


def claim(session,value,scope=None):
    scoped=scope or claim_scope(value)
    observation=legacy_guard_observation(SimpleNamespace(exists=lambda _key:value.get('legacyPresent',False)),scoped,value['guardKey'],value['now'])
    if value.get('tamperObservation'):observation['present']=not observation['present']
    cache=SqlBirthdayCache(Proxy(session),scoped,{},value['key'],value['guardKey'],observation,value['now'],GUARD_CONTRACT)
    if not cache.exists('birthday_coupon_77'): cache.set('birthday_coupon_77',json.dumps({'is_applied':True}),ex=600)
    return cache.claim


def original_history_comparison(session,value):
    """Fixture ONLY: original SELECTs in disposable MySQL versus BQ replay.
    Application/source runtime never calls this tool or its historical reads.
    """
    proxy=Proxy(session)
    def fetch_one(_session,query,params=None,to_dict=False):
        row=proxy.execute(query,params).mappings().first();return dict(row) if row else None
    def fetch(_session,query,params=None,to_dict=False):return [dict(row) for row in proxy.execute(query,params).mappings().all()]
    ns=compile_coupon(ROOT,{'json':json,'text':text,'date':SimpleNamespace(today=lambda:POINT.date()),'datetime':SourceClock,
        'redis_object':Cache(),'Session':proxy,'SessionR':proxy,'fetchOne':fetch_one,'fetch':fetch,'logger':SilentLogger(),
        'ValidationException':ValueError,'BIRTHDAY_MESSAGE':'birthday','EMPLOYEE_COUPON_DOMAIN_MAP':{},
        'REDIS_COUPON_EXPIRY_IN_SEC':600,'settings':SimpleNamespace(EXCLUSIVE_PRODUCT={})})
    user={'user_id':77,'email':'fixture@example.test','is_exclusive':True}
    def validate(namespace,db):
        try:namespace['get_valid_coupon'](db,'SYNTHETIC_BIRTHDAY',None,user,is_pos=True);return None
        except ValueError as error:return str(error)
    original=validate(ns,proxy)
    row=coupon_row(user_specific=1,coupon_lot_no='fixture' if value.get('lot') else '')
    facts=history(globalUsage='2',birthdayTodayUsage='1',customerOrderCount='3',monthlyJoinedUsage='9',
        lotCounts=[{'couponId':'222','sameCode':True,'noTimesAllowed':'1000','uniqueNoTimesAllowed':'1','usedCount':'9'}] if value.get('lot') else [])
    replay,reader,_cache,_user=source_coupon(row,facts,users=[{'coupon_used_count':0,'coupon_allowed_count':5,
        'coupon_month_allowed_count':0 if value.get('lot') else 5}])
    return {'today':ns['orders_count_using_birthday_coupon'](proxy,77,222),
        'allowed':ns['allowed_coupon_usage'](proxy,222),'originalError':original,'replayError':validate(replay,reader),'queries':reader.calls}


def stage(session,value):
    line_items=value.get('lineItems',False);state,plan,key=value['state'],value['plan'],value['key']
    hp,header,cart=source_line_products(line_items=line_items,raw=True,shopify=plan['kind']=='shopify',percent=value.get('percent',10))
    # Recreate the real candidate auto branch against current MySQL control rows,
    # actual cooperative claim, and preloaded sealed BigQuery history.
    cache=Cache().data
    settings={'BIRTHDAY_MESSAGE':'birthday','EMPLOYEE_COUPON_DOMAIN_MAP':{},'REDIS_COUPON_EXPIRY_IN_SEC':600,'EXCLUSIVE_PRODUCT':{}}
    controls=current_coupon_control(Proxy(session),'222')
    expected=claim_scope(value);expected['configurationHash']=seal('coupon-configuration',{'cache':cache,'settings':settings,'couponInputHash':controls['native_hash']},key)
    facts=history(scope=expected);facts={k:v for k,v in facts.items() if k!='signature'};facts['signature']=seal('coupon-history',facts,KEY)
    observation=legacy_guard_observation(SimpleNamespace(exists=lambda _key:False),expected,value['guardKey'],value['now'])
    if value.get('changeCouponAfterPrefetch'):
        session.execute(text('UPDATE coupons SET voucher_val=11 WHERE id=222'))
    candidate=CouponCandidate(ROOT,session=Proxy(session),expected_history=expected,document=facts,history_key=KEY,source_key=key,
        guard_key=value['guardKey'],guard_observation=observation,guard_contract=GUARD_CONTRACT,now_ms=value['now'],configuration_cache=cache,
        settings=settings,item_types=ItemTypes,validation_error=ValueError)
    cart.meta.pop('coupon',None)
    candidate.automatic(candidate.replay.current,{'user_id':77,'email':'fixture@example.test','is_exclusive':True},cart,None)
    selected=candidate.get_valid_coupon(candidate.replay,'SYNTHETIC_BIRTHDAY',None,{'user_id':77,'email':'fixture@example.test','is_exclusive':True},is_pos=True)
    candidate.namespace['set_attributes_for_coupon'](cart.meta['coupon'],selected)
    cart.context['session']=candidate.replay
    cart.meta['exclusive_user']={'name':'exclusive_user','active':True}
    wrapper=compile_class(ROOT,'controllers/cart/wrappers/CouponWrapper.py','CouponWrapper',
        {'Wrapper':object,'ValidationException':ValueError,'ItemTypes':ItemTypes,'apply_coupon':candidate.apply_coupon,'logger':SilentLogger()})()
    wrapper.apply(cart)
    models=source_models(ROOT);install_model_codec(models['OrderModel'],models['OrderStoreModel'],models['HasProductModel'])
    if not value.get('unqualifiedSchema'):install_complementary_codec(session,models['HasProductModel'],'pos-csv-pos-complementary-v1')
    metadata=models['HasProductModel'].__table__.metadata
    for name in ('products','users'):
        if name not in metadata.tables:Table(name,metadata,autoload_with=session.connection())
    native=[]
    for row in hp:
        row['order_id']=5001
        model=models['HasProductModel'](**row)
        session.add(model);native.append(model)
    session.flush()
    ns={'Base':models['Base'],'datetime':SimpleNamespace(datetime=SimpleNamespace(now=lambda:POINT))}
    import sqlalchemy
    ns.update(vars(sqlalchemy))
    model_tree=checked(ROOT,'models/Order.py')
    nodes=[node for node in model_tree.body if isinstance(node,ast.ClassDef) and node.name in {'FreebieGrantLevel','FreebieGrantStatus','OrderFreebieModel'}]
    # source_models already pins the whole original model file above.
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'<pinned-native-grant-model>','exec'),ns)
    grants=strict_pos_grants(ROOT,{'OrderFreebieModel':ns['OrderFreebieModel'],'FreebieGrantLevel':ns['FreebieGrantLevel'],
        'FreebieGrantStatus':ns['FreebieGrantStatus'],'datetime':SimpleNamespace(now=lambda:POINT),'logger':SilentLogger()})
    proxy=Proxy(session)
    if value.get('failGrant'):
        def failed(_value): raise ValueError('Fixture failure')
        proxy.add=failed
    grants(proxy,5001,{9007199254740994:[model.id for model in native if model.prod_id==9007199254740994]})
    session.flush()
    _,tree=refund_tree(ROOT,'pos-refund-per-hp-v1')
    def fetch_one(_session,query,params=None,to_dict=False):
        row=proxy.execute(query,params).mappings().first();return dict(row) if row else None
    def fetch(_session,query,params=None,to_dict=False):return [dict(row) for row in proxy.execute(query,params).mappings().all()]
    refund={'Decimal':Decimal,'ROUND_HALF_UP':ROUND_HALF_UP,'logger':SilentLogger(),
        'fetch_order':lambda *_args:dict(session.execute(text('SELECT * FROM orders WHERE id=5001')).mappings().one()),
        'fetch':fetch,'fetchOne':fetch_one,'PaymentMethod':SimpleNamespace(COD=SimpleNamespace(value=1))}
    nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in {'_round2','_distribute_amount_to_be_refunded','amount_to_be_refunded_calculation'}]
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'<pinned-native-refunds>','exec'),refund)
    refund['amount_to_be_refunded_calculation'](proxy,{'user_id':77},5001,{'convenience_fee':0},[],is_pos=True,is_new_calculation=3)
    session.flush()
    order=source_receipt(session,state,plan,line_items)
    before=coupon_users(session,'77','222')
    coupon,coupon_seal=coupon_receipt(session,state,plan,order,cart,ItemTypes,facts,candidate.cache.claim,before,key)
    comp,comp_seal=complementary_receipt(session,state,plan,order,{'items':{'9007199254740994':1}},expected['asOf'],key)
    result={'order':order,'coupon':{'value':coupon,'seal':coupon_seal},'complementary':{'value':comp,'seal':comp_seal}}
    store_descriptor(session,state,'coupon-benefit',coupon,key,value['now'])
    store_descriptor(session,state,'pos-complement',comp,key,value['now'])
    if value.get('consume'):
        # Executes the literal Python equivalent of Go's existing deduction,
        # once in THIS fixture transaction, never in addition to real Go.
        consume=source_coupon_deduction(ROOT,{'logger':SilentLogger()})
        consume(proxy,SimpleNamespace(id=5001,coupon_used=222),{'user_id':77})
        activation,activation_hash=coupon_consumption_receipt(session,coupon,coupon_seal,'e'*64,key)
        result['activation']={'value':activation,'seal':activation_hash,'confirmationHash':'e'*64}
        store_descriptor(session,state,'coupon-consume',activation,key,value['now'])
    if value.get('lateFailure'):raise BenefitReview('ORDER_IMPORT_FIXTURE_LATE_FAILURE')
    return result


if __name__=='__main__':
    value=json.load(sys.stdin);url=make_url(value['url'])
    if url.host not in ('localhost','127.0.0.1') or not url.database.startswith('pos_import_benefit_') or url.query:
        raise RuntimeError('Isolated benefit schema required')
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
    event.listen(Session,'before_flush',normalize_source_sentinels)
    try:
        if value.get('mode') in ('race','race-different'):
            def run(_index):
                scoped=claim_scope(value)
                if value['mode']=='race-different':scoped['operationId']=str(uuid4())
                with Session(engine) as session,session.begin():return claim(session,value,scoped)
            with ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(run,range(20)))
            result={'claims':len([row for row in results if row]),'unique':len({row['id'] for row in results if row})}
        else:
            with Session(engine) as session,session.begin():
                session.execute(text('SET timestamp=1781505000'))
                if value.get('mode')=='claim':result=claim(session,value)
                elif value.get('mode')=='receipt-replay':
                    result=store_descriptor(session,value['state'],value['kind'],value['receipt'],value['key'],value['now'])
                elif value.get('mode')=='history-compare':result=original_history_comparison(session,value)
                else:result=stage(session,value)
        print(json.dumps({'ok':True,'result':result},separators=(',',':'),allow_nan=False))
    except Exception as error:
        import traceback
        native=getattr(error,'orig',None);args=getattr(native,'args',())
        print(json.dumps({'ok':False,'code':getattr(error,'code','NATIVE_FIXTURE_FAILURE'),
            'nativeCode':args[0] if args and type(args[0]) is int else None,'class':type(error).__name__,
            'frames':[Path(frame.filename).name+':'+str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)][-6:]},separators=(',',':')))
    finally:engine.dispose()
