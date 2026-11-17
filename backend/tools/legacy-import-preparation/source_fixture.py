"""Pinned cart/eligibility/validation/ProcessingOrder, synthetic catalog/cache.

Only disposable fixtures import this module. It does not bootstrap source main,
settings, providers or engines. Price wrapper I/O is deliberately synthetic;
this is a control-flow oracle, not production pricing certification.
"""
import ast
from contextlib import contextmanager
from datetime import datetime,timedelta
from enum import IntEnum
import hashlib
from functools import lru_cache
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace

from source_runtime import SourceRuntime,SilentLogger,PINS,checked_source
from membership_profile import compile_free_membership,CONTEXT,PINS as MEMBER_PINS
from membership_handoff import CURRENT_HISTORY
from effects import Tasks
from cart_preparation import automatic_membership

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'compatibility/upstream/offline-cash-pricing'))
from source_calculator import load_calculator,CALCULATOR_SHA256,HELPER_SHA256
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'compatibility/upstream/legacy-order-imports/tender-profile'))
import source_tender


@lru_cache(maxsize=32)
def literal_code(root,path,name):
    # Test-only compiled-code reuse. Each invocation still gets fresh globals
    # and instances; pinned bytes are checked before code enters this cache.
    tree=ast.parse(checked_source(root,path))
    target=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name==name)
    for method in target.body:
        if isinstance(method,ast.FunctionDef):method.decorator_list=[]
    return compile(ast.Module(body=[target],type_ignores=[]),'<pinned-preview-'+name+'>','exec')


def compile_class(root,path,name,namespace):
    exec(literal_code(str(root),path,name),namespace)
    return namespace[name]


@contextmanager
def pinned_source(repository):
    """Test-only read from immutable Git blobs if a clean sibling advanced."""
    paths={name:PINS[name] for name in ('controllers/CartController.py','controllers/OrderController.py','controllers/CheckoutController.py')}
    paths['controllers/cart/Cart.py']=MEMBER_PINS['controllers/cart/Cart.py']
    paths['constants/StatusEnum.py']='42cb694ff628c61ef8a5ec169a4b319a8c1491ef2a698f93665348e6b22d0a06'
    paths['controllers/cart/wrappers/CalculationsWrapper.py']=CALCULATOR_SHA256
    paths['libs/helper.py']=HELPER_SHA256
    for path,sha in source_tender.PINS.items():
        if path.startswith('api:'):paths[path[4:]]=sha
    repository=Path(repository)
    if all((repository/name).exists() and hashlib.sha256((repository/name).read_bytes()).hexdigest()==sha for name,sha in paths.items()):
        yield repository
        return
    with tempfile.TemporaryDirectory(prefix='pos-preview-source-pin-') as temporary:
        destination=Path(temporary)
        for name,sha in paths.items():
            raw=subprocess.check_output(['git','-C',str(repository),'show','2960acbea10c4eaf16b6d99e15ff6e03ef7724c5:'+name],stderr=subprocess.DEVNULL,timeout=5)
            if hashlib.sha256(raw).hexdigest()!=sha:raise AssertionError('Pinned preview source unavailable')
            target=destination/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        yield destination


class K(IntEnum):
    PRODUCTS=1;META=2;GIFT_VOUCHERS=3;COMPLEMENTARY_PRODUCTS=4;SELECTED_PRODUCTS=5


class FixtureCart:
    def __init__(self,price,calculator,invoice_gst=0):
        self.price=price;self.calculator=calculator;self.is_modified=True
        self.invoice_gst=invoice_gst
        self.is_express=self.is_split_order=self.is_hyperlocal=False
        self.contents={'products':SimpleNamespace(items=[]),'meta':SimpleNamespace(items=[
            {'name':'site_config','free_membership_removed':False},
            {'name':'payment_details','payment_method':'cash','id':14},
            {'name':'calculations','main_sub_total':0,'total_savings':0,'total':0}])}
        self.contents['products'].get_key=lambda item:str(item['prod_id'])
        self.context={}
    @property
    def products(self):return self.contents['products'].items
    @property
    def meta(self):return {row['name']:row for row in self.contents['meta'].items}
    def get(self,kind):
        if isinstance(getattr(kind,'value',None),dict):
            name=kind.value['name']
            kind=K.PRODUCTS if name=='products' else K.META if name=='meta' else None
        if kind==K.PRODUCTS:return self.contents['products'].items
        if kind==K.META:return self.contents['meta'].items
        return []
    def get_item(self,kind,query):
        return next((row for row in self.get(kind) if row.get('name')==query.get('name')),None)
    def get_c(self,name):return self.products if name=='products' else []
    def reset(self,_kind):return None
    def update(self,payload):
        item=dict(payload['data'])
        if payload['type']=='meta':
            previous=self.get_item(K.META,{'name':item['name']})
            if previous:previous.update(item)
            else:self.contents['meta'].items.append(item)
        else:
            sku=int(item['prod_id']);existing=next((row for row in self.get(K.PRODUCTS) if row['prod_id']==sku),None)
            if existing:existing['quantity']=item.get('quantity',1)
            else:
                unit=0 if sku==12 else self.price.get(str(sku),100)
                self.get(K.PRODUCTS).append({'prod_id':sku,'parent_prod_id':0,'quantity':item.get('quantity',1),
                    'price':unit,'stock':999,'jit_value':'REGULAR','images':[], 'categories':[],
                    'prod_type':1,'is_mystery_product':False,'main_sub_total':unit,'coupon_discount':0,
                    'spl_price':0,'sub_total':unit*item.get('quantity',1),
                    'gst':0 if sku==12 else self.invoice_gst/100,'invoice_gst':0 if sku==12 else self.invoice_gst,
                    'is_app':'app','gender_type':0,'image':'','cashback_earned':0,'exclusive_savings':0})
            self.apply_wrappers()
        return self
    def delete(self,payload):
        if payload['type']=='meta':
            self.contents['meta'].items[:]=[row for row in self.get(K.META) if row.get('name')!=payload['data'].get('name')]
        else:
            self.contents['products'].items[:]=[row for row in self.get(K.PRODUCTS) if row['prod_id']!=payload['data']['prod_id']]
            self.apply_wrappers()
        return self
    def re_init(self):return self
    def persist(self,*_args,**_kwargs):return self
    def apply_wrappers(self):
        if self.products:
            if getattr(self,'pending_coupon',None):
                percent=self.pending_coupon;self.pending_coupon=None
                self.calculator.apply.__globals__['calculate_coupon_discount']=source_tender.birthday(self,percent)
                self.update({'type':'meta','data':{'name':'exclusive_user','active':True,'cart':False,'store_exclusive':0}})
            # Synthetic current-catalog hydration corresponds to the preceding
            # ProductWrapper; do not compound an already-applied percentage.
            for row in self.products:
                row['price']=self.price.get(str(row['prod_id']),0)
                row['spl_price']=0
                row['sub_total']=row['price']*row['quantity']
            self.calculator.apply(self,platform='web',is_pos=True,custom_data={'price':self.price})
        return self
    def json(self,*_args,**_kwargs):
        return json.dumps({'products':{'items':self.get(K.PRODUCTS)},'meta':{'items':self.get(K.META)}})


def pipeline(root,plan,trace,mode='normal',pricing=None):
    payment_tree=ast.parse((root/'constants/StatusEnum.py').read_text())
    payment=next(node for node in payment_tree.body if isinstance(node,ast.ClassDef) and node.name=='PaymentMethod')
    shared={'_IntEnum':IntEnum,'datetime':datetime,'timedelta':timedelta,'MEMBERSHIP_PROD_ID':['10','12']}
    exec(compile(ast.Module(body=[payment],type_ignores=[]),'<pinned-payment>','exec'),shared)
    shared.update(FREE_EXCLUSIVE_PRODUCT='12',BAMBOO_TOOTHBRUSH_EM='99',EXCLUSIVE_PRODUCT={'10':{}},
        ItemTypes=K,logger=SilentLogger(),json=json,time=time,tasks=Tasks(),fetch_client_ip=lambda _req:None,
        fetch_user_email_and_telephone=lambda _user:{'email':'fixture@example.test','telephone':'9000000000'},
        validate_cart_products=lambda *_args,**_kwargs:None,REMOVE_UPGRADE_MEMBERSHIP=False,
        redis_object=SimpleNamespace(exists=lambda *_args:False),
        AddBambooToothbrush=lambda *_args:SimpleNamespace(process=lambda:None,remove_bamboo_toothbrush=lambda:None),
        BlockEMAutoAdd=lambda *_args:SimpleNamespace(process=lambda:False),
        get_gst_status_from_redis=lambda _session:True,apply_selected_calculations=lambda data:data,
        push_cart_event=lambda *_args:None,cap_stock_for_display=lambda stock:stock,
        cap_variant_stock_for_display=lambda value:value,
        EmptyItemException=type('EmptyItemException',(Exception,),{}),IndexException=type('IndexException',(Exception,),{}),
        HTTPBadRequest=type('HTTPBadRequest',(Exception,),{}),
        sample_department_ids=lambda _session:[],check_express_enabled=lambda:False,
        get_exclusive_product=lambda _cart:None,EXCLUSIVE_UPGRADE_PRODUCT={},FREEBIE_PRODUCT_TYPE=4,
        EXCLUDE_MIN_ORDER_AMOUNT=[],push_process_order_event=lambda *_args:None,invalidate_cached_user=lambda *_args:None)
    shared['falcon']=SimpleNamespace(HTTPBadRequest=shared['HTTPBadRequest'])
    shared['settings']=SimpleNamespace(SINGLE_PRODUCT_ALLOWED_ARTIST=[],COUPON_ONLY_ALLOWED_ARTIST=[],
        SINGLE_QTY_ALLOWED_ARTIST=[],NESTLE_PRODUCTS=[],ENABLE_RECOMMENDED_PAYMENT_METHOD=False)
    shared['AddFreeMembership']=automatic_membership(compile_free_membership(root,shared))
    cart_reader=compile_class(root,'controllers/CartController.py','Cart',dict(shared))()
    validate=compile_class(root,'controllers/CheckoutController.py','ValidateCheckout',dict(shared))()
    process=compile_class(root,'controllers/OrderController.py','ProcessingOrder',dict(shared))()
    class Scope:
        @contextmanager
        def scope(self,session,user,current_plan,cap):
            state={'profile':self,'session':session,'user':user,'plan':current_plan,'capability':cap,
                'historyReader':CURRENT_HISTORY.get(),'eligibility':'not-added','historyEvidence':None}
            token=CONTEXT.set(state)
            try:yield state
            finally:CONTEXT.reset(token)
    class Step:
        def __init__(self,name,source):self.name,self.source=name,source
        def on_post(self,req,resp):
            trace.append(self.name)
            return self.source.on_post(req,resp)
    class Catalog:
        def on_post(self,req,_resp):
            trace.append('catalog')
            if mode=='write':req.context['session'].execute('UPDATE users SET tss_money=999 WHERE id=:id',{'id':77})
            if mode=='commit':req.context['session'].session.commit()
            if mode=='http':
                from source_runtime import prohibit_source_http
                try:prohibit_source_http()
                except Exception:pass
            if mode=='history':
                from cart_preparation import HISTORY_QUERIES
                from transaction import PrivateSessionProxy
                try:PrivateSessionProxy().execute(next(query for query in HISTORY_QUERIES if 'LIMIT 1' in query),{'user_id':77})
                except Exception:pass
            sku=int(req.context['data']['barcode'])
            existing=next((row for row in req.context['cart'].get(K.PRODUCTS) if row['prod_id']==sku),None)
            req.context['cart'].update({'type':'products','data':{'prod_id':sku,'quantity':1+(existing['quantity'] if existing else 0)}})
            # Literal AddFreeMembership calls this same legacy method. It may
            # flush but cannot commit the outer owned transaction.
            req.context['session'].commit()
            # PosProductDetail:1912 calls imported Cart after every auto-add.
            # The catalog fixture supplies product I/O only; this real pinned
            # Cart invocation retains that intermediate eligibility boundary.
            req.context['data']['payload']={'operation':'get'}
            result.cart_reader.on_post(req,_resp)
    result=object.__new__(SourceRuntime)
    result.membership=Scope()
    def empty_cart(**_kwargs):
        settings={'IS_LINE_ITEM_ENABLED':0,'IS_DYNAMIC_GST_ENABLED':0,'DYNAMIC_GST_THRESHOLD':2500,
            'DYNAMIC_GST_VALUE_ABOVE_THRESHOLD':18,'DYNAMIC_GST_VALUE_BELOW_THRESHOLD':5,
            'EXCLUDE_CATEGORY_FOR_DYNAMIC_GST':[],'EXCLUSIVE_PRODUCT':{},'EXCLUSIVE_UPGRADE_PRODUCT':{},
            'EXCLUSIVE_PRICELISTS':[1],'SHIPPING_FREE_PRODUCTS':[],'APP_DISCOUNT_PERCENT':0,
            'CASHBACK_PERCENT':0,'TSS_POINT_DISCOUNT_AMOUNT':10,**(pricing or {})}
        calculator=load_calculator(root,settings,lambda *_args:{})
        calculator.apply.__globals__['check_key']=lambda *_args:False
        result.last_cart=FixtureCart({row['productId']:float(row['unitPrice']) for row in plan['lines']},calculator,(pricing or {}).get('invoiceGst',0))
        if pricing and pricing.get('couponPercent'):
            source_tender.API=root
            result.last_cart.pending_coupon=pricing['couponPercent']
        return result.last_cart
    result.cart_factory=SimpleNamespace(empty_cart=empty_cart)
    result.pricelist_manager=lambda _context:None
    result.product=Catalog()
    result.cart_reader=Step('cart',cart_reader)
    result.validate=Step('validate',validate)
    result.process=Step('calculator',process)
    result.order=SimpleNamespace(on_post=lambda *_args:(_ for _ in ()).throw(AssertionError('PosOrder called by preview')))
    result.producer=SimpleNamespace(on_post=lambda *_args:(_ for _ in ()).throw(AssertionError('Producer called by preview')))
    result.item_types=K
    return result
