"""Actual source membership block in the private outer transaction; local only."""
import ast
from concurrent.futures import ThreadPoolExecutor
import datetime
import enum
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from urllib.parse import urlparse
import sqlalchemy
from sqlalchemy import Column,Integer,String,Enum,text
from sqlalchemy.orm import declarative_base,sessionmaker

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE));sys.path.insert(0,str(HERE.parent/'pending-cancellation'))
from membership_profile import MembershipProfile,compile_writers,compile_free_membership,receipt,CONTEXT,membership_order_tree
from prepare_membership_producers import source
from transaction import private_session
from receiver import record
from protocol import digest,ImportReview
from effects import CAPTURE
from membership_cache import invalidate

raw=os.environ['MEMBERSHIP_NATIVE_URL'];url=urlparse(raw)
if url.scheme!='mysql+pymysql' or url.hostname!='127.0.0.1' or url.path!='/pos_checkout_contract_test' or not url.port or url.password or url.query:
    raise RuntimeError('Disposable native import membership fixture required')
engine=sqlalchemy.create_engine(raw,pool_size=24,max_overflow=0,echo=False,hide_parameters=True)
Session=sessionmaker(bind=engine)
Base=declarative_base();namespace={'Base':Base,'Column':Column,'Integer':Integer,'String':String,'Enum':Enum,'enum':enum,'datetime':datetime}
for node in ast.parse(source('models/User.py')).body:
    if isinstance(node,ast.ClassDef) and node.name in ('Attributes','UserEAV'):
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<pinned-member-model>','exec'),namespace)
    elif isinstance(node,ast.ClassDef) and node.name=='User':
        projected=ast.ClassDef(name='User',bases=node.bases,keywords=[],decorator_list=[],body=[item for item in node.body if isinstance(item,ast.Assign) and any(isinstance(key,ast.Name) and key.id in ('__tablename__','id','email') for key in item.targets)])
        exec(compile(ast.fix_missing_locations(ast.Module(body=[projected],type_ignores=[])),'<pinned-used-member-user>','exec'),namespace)
for node in ast.parse(source('libs/helper.py')).body:
    if isinstance(node,ast.FunctionDef) and node.name in ('ensure_user_email','generate_temp_email'):
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<pinned-email-helper>','exec'),namespace)
namespace.update(cache=SimpleNamespace(region_invalidate=lambda *_a,**_k:(_ for _ in ()).throw(AssertionError('precommit invalidation'))),get_exclusive_token=lambda *_a:None)
kind=os.environ['POS_CSV_MEMBERSHIP_KIND'];upgrade=kind.endswith('upgrade');free=kind.endswith('auto-free') or kind.endswith('auto-history');history=kind.endswith('auto-history');free_value=1999 if history else 2300;shopify=kind.startswith('shopify')
settings=SimpleNamespace(EXCLUSIVE_PRODUCT={} if upgrade else {'10':{'expiry_delta':90 if free else 365}},EXCLUSIVE_UPGRADE_PRODUCT={'10':{'expiry_delta':365}} if upgrade else {},FREE_EXCLUSIVE_PRODUCT=10)
profile=MembershipProfile(Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT',str(HERE.parents[4]/'backend-tss-api_v2'))),settings)
namespace=compile_writers(profile.root,namespace,profile.adapter)
block=next(node for node in ast.walk(membership_order_tree(profile.root)) if isinstance(node,ast.With) and any(isinstance(item.context_expr,ast.Call) and isinstance(item.context_expr.func,ast.Name) and item.context_expr.func.id=='membership_order_stage' for item in node.items))
code=compile(ast.Module(body=[block],type_ignores=[]),'<pinned-CSV-PosOrder-member-block>','exec')
OP='5a5d1efb-727e-45ea-b214-9136be787031';KEY=os.environ['POS_LEGACY_IMPORT_PROOF_KEY']
class K:PRODUCTS=1;META=2;GIFT_VOUCHERS=3;COMPLEMENTARY_PRODUCTS=4
class Cart:
    def __init__(self):self.products=[{'prod_id':11,'quantity':1,'price':free_value}] if free else [{'prod_id':10,'quantity':1,'price':100}]
    def get(self,kind):return self.products if kind==K.PRODUCTS else []
    def get_item(self,kind,query):return {}
    def update(self,value):
        if value['type']=='products':self.products.append({**value['data'],'price':0,'spl_price':0})
    def delete(self,value):self.products=[row for row in self.products if row['prod_id']!=value['data']['prod_id']]
plan={'kind':'shopify' if shopify else 'offline','createdAt':'2026-06-15 12:00:00','originalTenderAmount':f'{free_value}.00' if free else '100.00',
      'lines':[{'productId':'11' if free else '10','quantity':1,'unitPrice':f'{free_value}.00' if free else '100.00'}]}
cap={'operationId':OP,'requestHash':'a'*64,'planHash':'b'*64,'namespace':'pos-import-v1:'+OP,
     'authority':{'customerId':'77'},'scope':{'actorId':'44','storeId':'1','counterId':'3'}}
with Session() as original_session:
    original_state=json.loads(original_session.execute(text('SELECT state FROM pos_rewrite_import_financial_operations WHERE id=:id'),{'id':OP}).scalar_one())
    cap['authority']=original_state['authority'];cap['scope']=original_state['scope']

def stage():
    with Session() as session,session.begin():
        session.execute(text('SELECT id FROM pos_rewrite_import_financial_operations WHERE id=:id FOR UPDATE'),{'id':OP}).one()
        if session.execute(text("SELECT id FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind='membership' FOR UPDATE"),{'op':OP}).first():return
        user={'user_id':77,'email':'fixture@example.test','is_exclusive':upgrade}
        with private_session(session) as private,profile.scope(private,user,plan,cap) as captured:
            cart=Cart()
            if history:
                from membership_history import signature
                class QualifiedFixturePort:
                    def read(self,query):
                        entry={'id':'8001','paymentMethod':14,'createdAt':query['asOf'],
                               'lines':[{'lineId':'8002','productId':'11','isExclusiveOrder':1}]}
                        body={'scope':query,'reader':'bigquery','generationId':'f'*64,'complete':True,
                              'fetchedAt':int(__import__('time').time()*1000),
                              'lastDeliveredOrder':entry,'recentDeliveredOrders':[entry]}
                        return {**body,'signature':signature(body,os.environ['POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY'])}
                captured['historyReader']=QualifiedFixturePort()
            if free:
                free_cls=compile_free_membership(profile.root,{'FREE_EXCLUSIVE_PRODUCT':10,'EXCLUSIVE_PRODUCT':settings.EXCLUSIVE_PRODUCT,'BAMBOO_TOOTHBRUSH_EM':999,'ItemTypes':K,'MEMBERSHIP_PROD_ID':['10'],'datetime':datetime.datetime,'timedelta':datetime.timedelta,'PaymentMethod':SimpleNamespace(DCC=SimpleNamespace(value=10)),'logger':SimpleNamespace(debug=lambda *_a:None)})
                free_cls(private,cart,{'products':{'items':cart.products},'meta':{'items':[{'name':'calculations','main_sub_total':free_value,'total_savings':0}]}},{},user).process()
            profile.admit(cart,K,plan)
            scope={**namespace,'session':private,'order':SimpleNamespace(id=5001),'settings':settings,'user':user,
                   'membership_order_stage':profile.adapter.membership_order_stage,
                   'exclusive_user':{'cart':not upgrade,'active':False},'cart':cart,
                   'get_exclusive_product':lambda _cart:None if upgrade else {'prod_id':10},
                   'get_exclusive_upgrade_product':lambda _cart:{'prod_id':10} if upgrade else None}
            exec(code,scope)
            profile.capture(private,'5001',cart,captured)
            header=session.execute(text('SELECT '+profile.adapter.HEADER_SQL+' AS native_hash FROM orders WHERE id=5001')).mappings().one()
            lines=[{'id':str(row['id']),'productId':str(row['prod_id']),'quantity':row['qty'],'inputHash':row['hash']} for row in session.execute(text("SELECT id,prod_id,qty,LOWER(SHA2(CAST(JSON_OBJECT('has_product_id',has_products.id,'product_id',has_products.prod_id,'quantity',has_products.qty,'price',has_products.price) AS CHAR CHARACTER SET utf8mb4),256)) AS hash FROM has_products WHERE order_id=5001 ORDER BY id")).mappings()]
            proof=receipt(cart,cap,plan,'5001',header,lines,'c'*64)
            record(session,OP,'membership','a'*64,'completed',proof,KEY,1781505000000)

def snapshot():
    with engine.connect() as connection:
        return [list(connection.execute(text(query))) for query in (
            'SELECT * FROM user_eav ORDER BY attribute','SELECT * FROM pos_rewrite_membership_versions ORDER BY customer_id',
            'SELECT * FROM pos_rewrite_cancellation_membership_provenance ORDER BY order_id',
            'SELECT * FROM pos_rewrite_import_financial_source_receipts ORDER BY id')]

def execute(query):
    with engine.begin() as connection:connection.execute(text(query))

try:
    if sys.argv[1]=='stage':
        # Real literal free-membership catalog SELECT uses a separate fixture
        # view; no product/catalog behavior is guessed into financial rows.
        execute('CREATE DATABASE IF NOT EXISTS tss')
        execute('CREATE OR REPLACE VIEW tss.products AS SELECT id,1 AS is_avail,0 AS is_del FROM pos_checkout_contract_test.products')
        before=snapshot();execute("CREATE TRIGGER member_descriptor_failure BEFORE INSERT ON pos_rewrite_import_financial_source_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='private member SQL traceback canary'")
        rejected=False
        try:
            try:stage()
            except Exception:rejected=True
            assert rejected,'Late descriptor failure expected'
        finally:execute('DROP TRIGGER member_descriptor_failure')
        assert before==snapshot(),'Original source commit escaped outer rollback'
        with ThreadPoolExecutor(max_workers=20) as pool:list(pool.map(lambda _:stage(),range(20)))
        first=snapshot();stage();assert first==snapshot(),'Exact replay changed EAV/revision/source descriptor'
        with Session() as session:
            proof=json.loads(session.execute(text("SELECT proof FROM pos_rewrite_import_financial_source_receipts WHERE kind='membership'")).scalar_one())
            assert proof['kind']==('upgrade' if upgrade else 'auto-free' if free else 'new')
            assert proof['method']==(15 if shopify else 14)
            assert proof['cacheInvalidations']==1
            assert len(proof['additionalLines'])==(1 if free else 0)
            if upgrade:assert next(row['value'] for row in proof['provenance']['confirmed'] if row['attribute']=='EXCLUSIVE_EXPIRY')=='2031-01-01T00:00:00'
        print('private CSV actual source stage: late descriptor rollback,20 contenders,exact replay,original entitlement passed')
    elif sys.argv[1]=='cache':
        with Session() as session:
            seal=session.execute(text("SELECT proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE kind='membership'")).scalar_one()
        calls=[]
        invalidate(Session,KEY,OP,seal,lambda *_args:calls.append(1));invalidate(Session,KEY,OP,seal,lambda *_args:calls.append(1))
        assert calls==[1]
        print('post-commit original cache invalidation: exact one dispatch + durable replay passed')
    elif sys.argv[1]=='cache-uncertain':
        with Session() as session:
            seal=session.execute(text("SELECT proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE kind='membership'")).scalar_one()
        calls=[]
        def unknown(*_args):calls.append(1);raise RuntimeError('private Redis canary')
        for _ in range(2):
            try:invalidate(Session,KEY,OP,seal,unknown);raise AssertionError('Uncertain invalidation expected')
            except ImportReview as error:assert error.code=='ORDER_IMPORT_MEMBERSHIP_CACHE_UNCERTAIN'
        assert calls==[1]
        print('post-commit unknown cache response stayed quarantined without resend')
    else:raise RuntimeError('Unknown fixture action')
finally:engine.dispose()
