"""Pinned CSV float tender and literal price/discount calculation oracle.

Only synthetic eligibility/configuration/catalog inputs are supplied. Source
functions execute without importing Django, the source app or network clients.
"""
import ast
import copy
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

HERE=Path(__file__).resolve().parent
BACKEND=HERE.parents[3]
API=Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT',str(HERE.parents[5]/'backend-tss-api_v2')))
WEB=HERE.parents[5]/'backend-pos-web'
sys.path.insert(0,str(HERE.parents[1]/'offline-cash-pricing'))
from source_calculator import PlainCashCart,ItemTypes,SilentLogger,load_calculator

PINS={
 'api:libs/OrderHelper.py':'a3ec2d593ddfb990b6462fe4f71a8c70f5aa7b95a6704ffb4a0566b14e515e46',
 'api:controllers/cart/wrappers/CouponWrapper.py':'9aed9f8d0f853cad5364a1a6336f709a6fd3b7245cf1da24b4b2f7a9bbed94c1',
 'api:controllers/cart/validators/CouponValidation.py':'e2d45aabb1a0b51215ce62f8e87532829d01708b97ab2ae3ac1ffc20dadda303',
 'api:controllers/cart/initializers/MetaInitializers.py':'e631cbac8c1f2f50e9692fdc128c15d0d1eefac64a21556201068a81e75d4e9f',
 'web:helpers/helpers.py':'7a5010baca25487e2020950ea0e129c2a72e0ab664dc6cf3207c7d6bb12f88c0',
 'web:helpers/task_helpers.py':'ee9053da7d0a90b145bdeb0c669e846014d7e664cae8939d76aa2db051351d60',
 'web:report/day_close_queries.py':'a7dcde4a8cf145e22fba677ffbdd0e8b499b64d2f326974eb18d735bfdf1a545',
 'web:report/report_queries.py':'6ef32f5c50ca710f32aefeb5f0ecd92462e10a0687f78ad71da1d90e5220cd20',
 'web:report/cash_balance_services.py':'575473b36880b26631c6c28a1438747c74bd932efb99fecc04ccb0329fbf67e2',
 'web:report/day_close_services.py':'8d9c26d205561cc6600aa3cdf37b53851509565135cf5131acb753933bce444f',
}

VECTORS=[
 {'id':'integer','lines':[('100.00',1)],'gst':0},
 {'id':'fraction-two','lines':[('25.49',2)],'gst':0},
 {'id':'float-drift','lines':[('0.10',10)],'gst':0},
 {'id':'mixed-drift','lines':[('33.33',3),('0.01',1)],'gst':0},
 {'id':'inclusive-gst','lines':[('249.50',3)],'gst':5},
 {'id':'app-percent','lines':[('100.00',1)],'gst':0,'appPercent':5},
 {'id':'birthday-percent','lines':[('100.00',1)],'gst':0,'couponPercent':10},
 {'id':'birthday-fraction','lines':[('25.49',2)],'gst':5,'couponPercent':10},
 {'id':'birthday-full','lines':[('100.00',1)],'gst':0,'couponPercent':100},
 {'id':'app-gst','lines':[('100.01',3),('0.99',1)],'gst':5,'appPercent':5},
]


def checked(name):
    kind,path=name.split(':',1);raw=((API if kind=='api' else WEB)/path).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=PINS[name]:raise RuntimeError('Pinned tender source changed.')
    return ast.parse(raw),str((API if kind=='api' else WEB)/path)


def functions(name,names,namespace):
    tree,path=checked(name)
    nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
    if len(nodes)!=len(names):raise RuntimeError('Pinned tender source methods changed.')
    exec(compile(ast.Module(body=nodes,type_ignores=[]),path,'exec'),namespace)


def settings(vector,line_items=False):
    return {'IS_LINE_ITEM_ENABLED':int(line_items),'IS_DYNAMIC_GST_ENABLED':0,'DYNAMIC_GST_THRESHOLD':2500,
        'DYNAMIC_GST_VALUE_ABOVE_THRESHOLD':18,'DYNAMIC_GST_VALUE_BELOW_THRESHOLD':5,
        'EXCLUDE_CATEGORY_FOR_DYNAMIC_GST':[],'EXCLUSIVE_PRODUCT':{},'EXCLUSIVE_UPGRADE_PRODUCT':{},
        'EXCLUSIVE_PRICELISTS':[1],'SHIPPING_FREE_PRODUCTS':[],'APP_DISCOUNT_PERCENT':vector.get('appPercent',0),
        'CASHBACK_PERCENT':0,'TSS_POINT_DISCOUNT_AMOUNT':10}


class TenderCart(PlainCashCart):
    def get_c(self,name):return self.products if name=='products' else []
    def re_init(self):return self
    def persist(self):return self


def birthday(cart,percent):
    user={'user_id':77,'email':'synthetic@example.test','is_exclusive':True,'cart_exclusive_user':True}
    cache=SimpleNamespace(exists=lambda _key:False,set=lambda *_args,**_kwargs:None)
    ns={'json':json,'redis_object':cache,'REDIS_COUPON_EXPIRY_IN_SEC':600,
        'check_birthday_month':lambda *_args:True,'get_birthday_coupon_details':lambda *_args:(222,'FIXTURE_BIRTHDAY',1),
        'allowed_coupon_usage':lambda *_args:True,'orders_count_using_birthday_coupon':lambda *_args:0}
    functions('api:libs/OrderHelper.py',{'auto_apply_birthday_coupon'},ns)
    ns['auto_apply_birthday_coupon'](None,user,cart,'web')
    supplied=cart.meta.get('coupon')
    if not supplied:raise RuntimeError('Original automatic birthday branch was not exercised.')
    row={'coupon_id':222,'id':222,'type':'1','min_quantity':0,'min_amount':0,'discount':percent,'valid_for':1,
        'voucher_code':'FIXTURE_BIRTHDAY','voucher_percentage_max_val':0,'for_new_user':0,'user_specific':0,
        'buyable_quantity':0,'free_quantity':0,'is_applicable_on_discounted_products':1,'voucher_mxn_type':'0',
        'no_times_allowed':1000,'coupon_lot_no':'','message':'birthday','platform':'offline'}
    ns.update(validate_birthday_coupon=lambda *_args:True,validate_employee_coupon=lambda *_args:True,
        fallback_for_redis_key=lambda *_args:{'status':1},logger=SilentLogger())
    functions('api:controllers/cart/initializers/MetaInitializers.py',{'get_valid_coupon','validate_coupon_count','set_attributes_for_coupon'},ns)
    coupon=ns['get_valid_coupon'](None,row,'web',user,db_fetch=False,is_pos=True)
    ns['set_attributes_for_coupon'](supplied,coupon)
    validation={'settings':SimpleNamespace(EXCLUSIVE_PRODUCT={}), 'Session':None,'logger':SilentLogger(),
        'fetchOne':lambda *_args,**_kwargs:{'user_type':2,'default_country_id':99},'fetch':lambda *_args,**_kwargs:[],
        'redis_object':cache,'ValidationException':RuntimeError}
    functions('api:controllers/cart/validators/CouponValidation.py',
        {'cat_validator','single_cat_validator','multi_cat_validator','product_validator','default_validator','validation_factory','apply_coupon','check_country_eligibility'},validation)
    validation['apply_coupon'](cart,supplied)
    calculate={'ItemTypes':ItemTypes,'logger':SilentLogger()}
    functions('api:controllers/cart/wrappers/CouponWrapper.py',{'calculate_coupon_discount'},calculate)
    return calculate['calculate_coupon_discount']


def calculated(vector,line_items=False):
    products=[]
    for index,(price,quantity) in enumerate(vector['lines']):
        product_id=9007199254740993+index
        products.append({'prod_id':product_id,'parent_prod_id':product_id,'quantity':quantity,'price':float(price),'spl_price':0,
            'sub_total':float(price)*quantity,'categories':[],'gst':vector['gst']/100,'invoice_gst':vector['gst'],
            'is_app':'app','prod_type':1,'jit_value':'REGULAR','gender_type':0,'image':'','images_new':'',
            'is_mystery_product':0,'cashback_earned':0,'exclusive_savings':0})
    cart=TenderCart(products,None)
    cart.meta['payment_details']['id']=14
    calculator=load_calculator(API,settings(vector,line_items),lambda *_args:{})
    if vector.get('couponPercent'):
        calculator.apply.__globals__['calculate_coupon_discount']=birthday(cart,vector['couponPercent'])
        cart.meta['exclusive_user']={'name':'exclusive_user','active':True,'cart':False,'store_exclusive':0}
    calculator.apply(cart,platform='web',is_pos=True,custom_data={'price':{str(row['prod_id']):row['price'] for row in products}})
    return cart


def csv_calls(vector,payment='cash'):
    spec=importlib.util.spec_from_file_location('original_csv_create',BACKEND/'tools/legacy-order-imports/source_order.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    group={'order_details':[{'store_id':'1','email':'synthetic@example.test','order_date':'2026-06-15 12:00:00',
            'order_placed_sms':'0','order_message':'Synthetic tender evidence','payment_mode':payment}],
        'line_item':[{'product_id':str(vector.get('productIds',list(range(9007199254740993,9007199254740993+len(vector['lines']))))[i]),'product_qty':str(quantity),'product_price':price}
                     for i,(price,quantity) in enumerate(vector['lines'])]}
    value=module.run('offline',group)
    if value['failureCount']:raise RuntimeError('Original CSV method rejected its synthetic input.')
    complete=next(row for row in value['calls'] if row['event']=='complete')
    return {'cash':complete['args'][3],'cashReceived':complete['args'][4],'manualOther':complete['args'][5],
        'rawTender':str(complete['args'][3]+complete['args'][5]),
        'date':complete['kwargs']['custom_date'],'others':complete['kwargs'].get('others',False)}


def describe(vector,payment='cash'):
    cart=calculated(vector)
    calc=cart.meta['calculations'];tender=csv_calls(vector,payment)
    return {'id':vector['id'],'payment':payment,'originalCsv':tender,
        'calculations':{key:calc[key] for key in ('total','rounding_off','main_sub_total','sub_total','gst_total','coupon_discount','app_discount','app_discount_status')},
        'products':[{key:str(row['prod_id']) if key=='prod_id' else row.get(key,0) for key in ('prod_id','quantity','price','sub_total','pre_gst_amt','coupon_discount','final_payable')} for row in cart.products]}


if __name__=='__main__':
    print(json.dumps([describe(row) for row in VECTORS],separators=(',',':'),allow_nan=False))
