"""Network-free execution of pinned original coupon, POS selection and refund code.

Synthetic catalog/control inputs are explicit. Historical queries must be
answered by a sealed BQ replay; FakeCurrent refuses every history SELECT.
"""
import ast
import copy
from datetime import datetime, date
from decimal import Decimal, ROUND_HALF_UP
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

BACKEND = Path(__file__).resolve().parents[2]
PROFILE = BACKEND/'compatibility/upstream/legacy-order-imports/benefit-profile'
sys.path.insert(0, str(PROFILE))
sys.path.insert(0, str(PROFILE.parent))
sys.path.insert(0, str(PROFILE.parent.parent/'offline-cash-pricing'))
from benefit_source import checked, compile_functions, compile_coupon, source_pos_selection, source_pos_wrappers, strict_pos_grants, BenefitReview
from benefit_history import CouponHistoryReplay, Row, Rows, qualify, seal
from source_calculator import PlainCashCart, ItemTypes, SilentLogger, load_calculator
from source_refunds import RefundProjection, refund_tree
ROOT = Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT', str(BACKEND.parents[1]/'backend-tss-api_v2')))
POINT = datetime(2026,6,15,12)
KEY = 'isolated-benefit-history-key-0123456789'


def coupon_row(**changes):
    value = {'coupon_id':222, 'id':222, 'type':'1', 'min_quantity':0, 'min_amount':0,
        'voucher_code':'SYNTHETIC_BIRTHDAY', 'discount':10, 'valid_for':1, 'platform':'offline',
        'voucher_percentage_max_val':0, 'for_new_user':0, 'user_specific':0, 'buyable_quantity':0,
        'free_quantity':0, 'is_applicable_on_discounted_products':1, 'voucher_mxn_type':'0',
        'no_times_allowed':1000, 'coupon_lot_no':'', 'message':'birthday'}
    return {**value, **changes}


def history(**changes):
    value = {'scope': {'contract':'pos-csv-coupon-history-v1','operationId':'11111111-1111-4111-8111-111111111111',
        'requestHash':'a'*64,'planHash':'b'*64,'customerId':'77','couponId':'222','configurationHash':'c'*64,
        'asOf':'2026-06-15 12:00:00','sourceTimeZone':'Asia/Kolkata'}, 'reader':'bigquery','generationId':'d'*64,
        'complete':True,'fetchedAt':1781505000000,'publication':{'sourceCaptureHash':'e'*64,'controlHeadHash':'f'*64,
        'queryContract':'pos-source-coupon-selects-2960-v1','seal':'0'*64},'globalUsage':'0','birthdayTodayUsage':'0',
        'customerOrderCount':'0','monthlyJoinedUsage':'0','lotCounts':[]}
    value.update(changes)
    return {**value,'signature':seal('coupon-history',value,KEY)}


class Cache:
    def __init__(self, present=False, active=True):
        self.data = {'auto_apply_coupon':{'status':1 if active else 0,'value':'birthday_coupon'},
                     'birthday_coupon':{'status':1,'value':{'coupon_id':222,'coupon_name':'SYNTHETIC_BIRTHDAY'}}}
        if present: self.data['birthday_coupon_77'] = {'is_applied':True}
        self.sets = []
    def exists(self, name): return name in self.data
    def get(self, name): return json.dumps(self.data[name]).encode()
    def set(self, name, value, ex=None): self.data[name] = json.loads(value);self.sets.append((name,ex));return True


class Current:
    def __init__(self, coupon, birth=date(1990,6,10), countries=None, user_type=2):
        self.coupon, self.birth, self.countries, self.user_type = coupon, birth, countries or [], user_type
        self.reads = []
    def execute(self, query, params=None):
        q = ' '.join(str(query).lower().split());self.reads.append(q)
        if 'from orders' in q or 'order_coupon_log' in q: raise AssertionError('Historical MySQL fallback attempted')
        if q.startswith('select birthdate, email from users'): return Rows([{'birthdate':self.birth,'email':'synthetic@example.test'}])
        if q.startswith('select no_times_allowed'): return Rows([{'num':self.coupon['no_times_allowed']}])
        if q.startswith('select id as coupon_id'): return Rows([self.coupon])
        if q.startswith(('select user_type, default_country_id','select user_type,default_country_id')): return Rows([{'user_type':self.user_type,'default_country_id':99}])
        if q.startswith('select country_id from coupon_countries'): return Rows([{'country_id':n} for n in self.countries])
        if q.startswith('select cat_id from has_coupons'): return Rows([{'cat_id':n} for n in (1,2)])
        if q.startswith('select prod_id from coupons_products'): return Rows([{'prod_id':9007199254740993}])
        if 'buyable_coupon_' in q or 'free_coupon_' in q: return Rows([{'id':1}])
        raise AssertionError('Unexpected synthetic current query')


class SourceClock:
    datetime = SimpleNamespace(now=lambda:POINT)
    @staticmethod
    def now(): return POINT


def source_coupon(coupon=None, facts=None, *, exclusive=True, cache_present=False, birth=date(1990,6,10), users=(), countries=None, user_type=2, active=True):
    coupon = coupon or coupon_row();facts = facts or history()
    facts = qualify(facts,facts['scope'],KEY,1781505000000)
    current = Current(coupon,birth,countries,user_type)
    replay = CouponHistoryReplay(facts,current,coupon,users)
    cache = Cache(cache_present,active)
    ns = compile_coupon(ROOT,{'json':json,'text':lambda value:value,'date':SimpleNamespace(today=lambda:POINT.date()),
        'datetime':SourceClock,'redis_object':cache,'Session':replay,'SessionR':replay,'fetchOne':replay.fetch_one,
        'fetch':replay.fetch,'logger':SilentLogger(),'ValidationException':ValueError,
        'ItemTypes':ItemTypes,'BIRTHDAY_MESSAGE':'birthday','EMPLOYEE_COUPON_DOMAIN_MAP':{'employee':'example'},
        'REDIS_COUPON_EXPIRY_IN_SEC':600,'settings':SimpleNamespace(EXCLUSIVE_PRODUCT={}),
        'check_user_in_table':lambda *_args:False})
    user = {'user_id':77,'email':'synthetic@example.test','is_exclusive':exclusive,'cart_exclusive_user':exclusive}
    return ns,replay,cache,user


def eligibility_vectors():
    result=[]
    for label,changes in [('eligible',{}),('wrong-month',{'birth':date(1990,5,10)}),('zero-birthdate',{'birth':'0000-00-00'}),
       ('cached-claim',{'cache_present':True}),('inactive-auto',{'active':False}),
       ('daily-used',{'facts':history(birthdayTodayUsage='1')}),('global-used',{'facts':history(globalUsage='1000')})]:
        ns,replay,cache,user=source_coupon(**changes)
        class Cart:
            def __init__(self): self.meta={}
            def update(self,payload): self.meta[payload['data']['name']]=payload['data']
        cart=Cart();config=ns['get_auto_apply_coupon'](replay)
        if config['value']=='birthday_coupon' and int(config['status'])==1:
            ns['auto_apply_birthday_coupon'](replay,user,cart,None)
        result.append({'label':label,'applied':'coupon' in cart.meta,'claims':len(cache.sets),'history':replay.calls})
    validation=[]
    cases=[('exclusive-required',{'exclusive':False},{}),('new-user',{'coupon':coupon_row(for_new_user=1),'facts':history(customerOrderCount='1')},{}),
       ('monthly-multiplied',{'coupon':coupon_row(user_specific=1),'facts':history(monthlyJoinedUsage='6'),
          'users':[{'coupon_used_count':0,'coupon_allowed_count':5,'coupon_month_allowed_count':5}]},{}),
       ('user-limit',{'coupon':coupon_row(user_specific=1),'users':[{'coupon_used_count':1,'coupon_allowed_count':1,'coupon_month_allowed_count':0}]},{}),
       ('wrong-platform',{'coupon':coupon_row(platform='web')},{}),('invalid-country',{'countries':[1]},{}),
       ('wrong-user-type',{'user_type':0},{}),('lot-used',{'coupon':coupon_row(coupon_lot_no='fixture'),
          'facts':history(lotCounts=[{'couponId':'222','sameCode':True,'noTimesAllowed':'5','uniqueNoTimesAllowed':'1','usedCount':'2'}])},{}),
       ('valid-control',{}, {})]
    for label,changes,_ in cases:
        ns,replay,cache,user=source_coupon(**changes)
        try:
            coupon=ns['get_valid_coupon'](replay,replay.coupon['voucher_code'],None,user,is_pos=True)
            item={'name':'coupon','coupon':coupon['voucher_code'],'user':user}
            ns['set_attributes_for_coupon'](item,coupon)
            product={'prod_id':9007199254740993,'parent_prod_id':9007199254740993,'quantity':1,'price':100,'spl_price':0,'gst':0,'categories':[1]}
            cart=SimpleNamespace(context={'session':replay},get_c=lambda _name:[product])
            ns['apply_coupon'](cart,item)
            validation.append({'label':label,'accepted':True,'message':None,'history':replay.calls})
        except ValueError as error: validation.append({'label':label,'accepted':False,'message':str(error),'history':replay.calls})
    return {'automatic':result,'validation':validation}


def source_line_products(line_items=False, free=True, percent=10, raw=False, shopify=False):
    ns,replay,cache,user=source_coupon(coupon_row(discount=percent))
    products=[{'prod_id':9007199254740993,'parent_prod_id':9007199254740993,'quantity':2,'price':25.49,'spl_price':0,
       'sub_total':50.98,'categories':[1],'gst':0,'invoice_gst':0,'is_app':'app','prod_type':1,'jit_value':'REGULAR',
       'gender_type':0,'image':'','images_new':'','is_mystery_product':0,'cashback_earned':0,'exclusive_savings':0}]
    cart=PlainCashCart(products,None);cart.context={'session':replay};cart.is_pos=True
    cart.get_c=lambda _name:cart.products
    ns['auto_apply_birthday_coupon'](replay,user,cart,None)
    coupon=ns['get_valid_coupon'](replay,replay.coupon['voucher_code'],None,user,is_pos=True)
    ns['set_attributes_for_coupon'](cart.meta['coupon'],coupon)
    ns['apply_coupon'](cart,cart.meta['coupon'])
    settings={'IS_LINE_ITEM_ENABLED':int(line_items),'IS_DYNAMIC_GST_ENABLED':0,'DYNAMIC_GST_THRESHOLD':2500,
        'DYNAMIC_GST_VALUE_ABOVE_THRESHOLD':18,'DYNAMIC_GST_VALUE_BELOW_THRESHOLD':5,'EXCLUDE_CATEGORY_FOR_DYNAMIC_GST':[],
        'EXCLUSIVE_PRODUCT':{},'EXCLUSIVE_UPGRADE_PRODUCT':{},'EXCLUSIVE_PRICELISTS':[1],'SHIPPING_FREE_PRODUCTS':[],
        'APP_DISCOUNT_PERCENT':0,'CASHBACK_PERCENT':0,'TSS_POINT_DISCOUNT_AMOUNT':10}
    calc=load_calculator(ROOT,settings,lambda *_args:{})
    calc.apply.__globals__['calculate_coupon_discount']=ns['calculate_coupon_discount']
    calc.apply(cart,is_pos=True,custom_data={'price':{str(products[0]['prod_id']):25.49}})
    constructor={'Session':None,'settings':SimpleNamespace(**settings),'logger':SilentLogger(),'HasProductModel':lambda **kwargs:kwargs,
        'fetchOne':lambda *_args,**_kwargs:{'parent_id':9007199254740993,'normal_price':25.49,'special_price':0,'exclusive_price':0,'cog':0},
        'math':__import__('math'),'Decimal':Decimal,'ROUND_DOWN':__import__('decimal').ROUND_DOWN}
    compile_functions(ROOT,'libs/helper.py',{'allocate_amount_per_unit','round_down'},constructor)
    compile_functions(ROOT,'libs/OrderHelper.py',{'build_has_products_model'},constructor)
    order=SimpleNamespace(id=5001,store_disc_pg=0,tss_points_used=0,coupon_used=222,coupon_amt_used=cart.meta['calculations']['coupon_discount'],
        cashback_used=0,voucher_used=0,voucher_amt_used=0,flag_id=18)
    if shopify:order.coupon_used=0;order.coupon_amt_used=0
    hp=constructor['build_has_products_model'](order,copy.deepcopy(cart.products[0]),True,is_pos=True,calc=cart.meta['calculations'])
    if free:
        hp+=constructor['build_has_products_model'](order,{'prod_id':9007199254740994,'quantity':3,'price':17.83,'spl_price':0,
            'invoice_gst':0,'gst':0,'image':'','cashback_earned':0,'exclusive_savings':0},True,is_free=True,calc=cart.meta['calculations'])
    header={'user_id':77,'pay_amt':cart.meta['calculations']['total'],'coupon_used':order.coupon_used,'coupon_amt_used':order.coupon_amt_used,
        'payment_method':14,'payment_status':0,'shipping_amt':0,'gifting_charges':0,'hl_charges':0,'cod_charges':0,'tss_money_used':0,
        'voucher_used':0,'voucher_amt_used':0,'tss_points_used':0,'cashback_used':0,'express_charges':0}
    projection=RefundProjection(header,[{'status':'PLACED','hp_tss_points_used':0,'price':row['price'],'prod_id':row['prod_id'],
        'gst':row['gst'],'disc':row['disc'],'wallet_disc':0,'voucher_disc':0,'store_disc_pg':0} for row in hp])
    projection.fetch_one=lambda *_args,**_kwargs:{'voucher_type':'1'}
    _,tree=refund_tree(ROOT,'pos-refund-per-hp-v1')
    refund={'Decimal':Decimal,'ROUND_HALF_UP':ROUND_HALF_UP,'fetch_order':projection.order,'fetch':projection.fetch,
        'fetchOne':projection.fetch_one,'logger':SilentLogger(),'PaymentMethod':SimpleNamespace(COD=SimpleNamespace(value=1))}
    funcs=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in {'_round2','_distribute_amount_to_be_refunded','amount_to_be_refunded_calculation'}]
    exec(compile(ast.Module(body=funcs,type_ignores=[]),'<pinned-approved-benefit-refunds>','exec'),refund)
    refund['amount_to_be_refunded_calculation'](projection,{'user_id':77},0,{'convenience_fee':0},[],is_pos=True,is_new_calculation=3)
    if raw: return hp,header,cart
    return {'lineItems':line_items,'percent':percent,'payable':header['pay_amt'],'couponDiscount':order.coupon_amt_used,
        'lines':[{'productId':str(row['prod_id']),'quantity':row['qty'],'price':row['price'],'discount':row['disc'],
                  'type':row['type'],'refundable':projection.rows[i]['amount_to_be_refunded']} for i,row in enumerate(hp)],
        'refundAudits':len(projection.logs),'coherent':all(row['amount_to_be_refunded']==projection.logs[i]['amount_to_be_refunded'] for i,row in enumerate(projection.rows))}


def freebie_vectors():
    meta=source_pos_selection(ROOT,9007199254740994)
    for _ in range(2):meta=source_pos_selection(ROOT,9007199254740994,meta)
    class CurrentFreebie:
        def execute(self, query, parameters):
            assert 'ps.stock' not in str(query) and 'is_avail' not in str(query) and 'is_del' not in str(query)
            return Rows([{'prod_id':9007199254740994,'prod_type':4,'threshold_price':1000,'price':1000,'spl_price':0,
                'image':'[]','image_new':'{}','added_by':1}])
    store=SimpleNamespace(items=[])
    cart=SimpleNamespace(is_pos=True,get_store=lambda _kind:store,get_item=lambda *_args:meta)
    source_pos_wrappers(ROOT,{'SessionR':CurrentFreebie(),'Wrapper':object,
        'ItemTypes':SimpleNamespace(META=ItemTypes.META,COMPLEMENTARY_PRODUCTS='complementary'),'json':json}).apply(cart)
    # Literal Cart.apply_wrappers path proves POS does not automatically award
    # web complementary/freebie rows on a successful wrapper pass.
    tree=checked(ROOT,'controllers/cart/Cart.py')
    method=next(node for cls in tree.body if isinstance(cls,ast.ClassDef) and cls.name=='Cart' for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='apply_wrappers')
    calls=[]
    def wrapper(name):return type(name,(),{'apply':lambda self,**_kwargs:calls.append(name)})()
    wrappers=[wrapper(name) for name in ['ComplementaryProductWrapper','FreebieProductWrapper','PosFreebieWrapper']]
    scope={'time':time,'logger':SilentLogger()}
    exec(compile(ast.Module(body=[method],type_ignores=[]),'<pinned-POS-wrapper-routing>','exec'),scope)
    scope['apply_wrappers'](SimpleNamespace(is_pos=True,context={'data':{}},wrappers=wrappers))
    return {'meta':meta,'quantity':store.items[0]['quantity'],'valid':store.items[0]['is_valid'],'wrapperCalls':calls}


def admission_vectors():
    from benefit_profile import benefit_scope, assert_benefit_profile, CURRENT_BENEFIT_SCOPE
    from correction_profile import CalculatedImportReview
    from screening_profile import screened_base_profile
    types=SimpleNamespace(PRODUCTS='products',META='meta',GIFT_VOUCHERS='gifts',COMPLEMENTARY_PRODUCTS='complementary')
    class Cart:
        is_pos=True
        def __init__(self):
            self.products=[{'prod_id':9007199254740993,'quantity':2}]
            self.comp=[{'prod_id':9007199254740994,'prod_type':4,'is_valid':True,'quantity':1,'freebie_sale_id':0}]
            self.meta={'pos_freebies':{'items':{'9007199254740994':1}},'calculations':{'total':45,'coupon_discount':0}}
        def get(self,kind):return self.products if kind=='products' else self.comp if kind=='complementary' else []
        def get_item(self,kind,query):return self.meta.get(query['name'])
    cart=Cart();settings=SimpleNamespace(EXCLUSIVE_PRODUCT={},EXCLUSIVE_UPGRADE_PRODUCT={})
    plan={'kind':'offline','originalTenderAmount':'104.47','lines':[{'productId':'9007199254740993','quantity':2,'unitPrice':'25.49'},
        {'productId':'9007199254740994','quantity':3,'unitPrice':'17.83'}]}
    result={}
    try:
        with benefit_scope(plan,complementary='pos-csv-pos-complementary-v1'):
            assert_benefit_profile(cart,types,settings,plan,cart.meta['calculations'])
    except CalculatedImportReview as error:result['tender']={'code':error.code,'payable':error.payable}
    result['contextCleared']=CURRENT_BENEFIT_SCOPE.get() is None
    try:assert_benefit_profile(cart,types,settings,plan,cart.meta['calculations'])
    except BenefitReview as error:result['missingScope']=error.code
    plan['originalTenderAmount']='45.00'
    with benefit_scope(plan,complementary='pos-csv-pos-complementary-v1'):
        result['qualified']=assert_benefit_profile(cart,types,settings,plan,cart.meta['calculations'])['posSelections']
        cart.meta['calculations']['used_tss_money']=1
        try:assert_benefit_profile(cart,types,settings,plan,cart.meta['calculations'])
        except BenefitReview as error:result['wallet']=error.code
        cart.meta['calculations']['used_tss_money']=0
        cart.products.append({'prod_id':10,'quantity':1})
        settings.EXCLUSIVE_PRODUCT={'10':{}}
        try:assert_benefit_profile(cart,types,settings,plan,cart.meta['calculations'])
        except BenefitReview as error:result['membership']=error.code
        settings.EXCLUSIVE_PRODUCT={};cart.products.pop()
        cart.products[0]['prod_id']=390238;plan['lines'][0]['productId']='390238'
        cart.meta['calculations']['used_tss_money']=1
        try:screened_base_profile(assert_benefit_profile)(cart,types,settings,plan,cart.meta['calculations'])
        except BenefitReview as error:result['screenedWallet']=error.code
    return result


if __name__=='__main__':
    result=eligibility_vectors();result['freebie']=freebie_vectors()
    result['allocations']=[source_line_products(line_items=flag,percent=percent) for flag in (False,True) for percent in (10,100)]
    result['canonicalSeal']=seal('coupon',{'refundable':'1.00','refundInputHash':'a'*64},KEY)
    result['admission']=admission_vectors()
    print(json.dumps(result,separators=(',',':'),allow_nan=False))
