"""Actual coupon helpers/MetaInitializer with synthetic current native controls.

The deployed ten-trigger/ACL qualification is deliberately not mocked as a
claim: the explicitly injected fixture head port only tests replay ownership.
No old Order/log table is created, so an accidental native history query fails.
"""
import copy
import json
from datetime import datetime
from types import SimpleNamespace
from sqlalchemy import text
from preview_fixture import KEY,SOURCE,module
from origin_contracts import digest
from origin_coupon_source import SourceCoupons,install,settings_namespace,Silent
from benefit_source import compile_coupon,compile_class
from native import one
from transaction import CURRENT


def enable(fixture,*,historical=True):
    f=fixture
    with f.engine.begin() as connection:
        connection.execute(text('''CREATE TABLE coupons(
            id INT PRIMARY KEY,voucher_type VARCHAR(8),disc_apply_items INT,min_order_amt DOUBLE,
            voucher_code VARCHAR(255),voucher_val DOUBLE,voucher_valid_for INT,platform VARCHAR(16),
            voucher_percentage_max_val DOUBLE,for_new_user INT,user_specific INT,buyable_quantity INT,
            free_quantity INT,is_applicable_on_discounted_products INT,voucher_mxn_type VARCHAR(16),
            no_times_allowed INT,coupon_lot_no VARCHAR(40),unique_no_times_allowed INT,message VARCHAR(255),
            user_type INT,default_country_id INT,is_deleted INT,start_date DATETIME,end_date DATETIME)'''))
        connection.execute(text('''CREATE TABLE coupons_users(id BIGINT PRIMARY KEY,c_id INT,user_id BIGINT,
            coupon_used_count INT,coupon_allowed_count INT,coupon_month_allowed_count INT)'''))
        connection.execute(text("INSERT INTO coupons VALUES(7,'1',1,0,'FIXTURE_A',10,1,'all',100,0,0,0,0,1,'discount',1000,'',0,'',0,0,0,'2020-01-01','2099-12-31'),(8,'1',1,0,'FIXTURE_B',20,1,'all',100,0,0,0,0,1,'discount',:allowance,'',0,'',0,0,0,'2020-01-01','2099-12-31')"),{'allowance':2 if historical else 1000})
        connection.execute(text("INSERT INTO cart_meta VALUES('cart_77','meta',:value,NOW())"),
            {'value':json.dumps({'items':[{'name':'coupon','coupon':'FIXTURE_A'}]})})
    class Cache:
        def mget(self,names):
            if f.leased or CURRENT.get() is not None:raise AssertionError('Coupon snapshot retained SQL')
            values={'auto_apply_coupon':json.dumps({'status':0,'value':'birthday_coupon'}),
                'birthday_coupon':json.dumps({'status':0,'value':{}})}
            return [values.get(name) for name in names]
        def exists(self,_name):return False
    settings={'BIRTHDAY_MESSAGE':'fixture_birthday','EMPLOYEE_COUPON_DOMAIN_MAP':{},'REDIS_COUPON_EXPIRY_IN_SEC':60}
    coupons=SourceCoupons(SOURCE,KEY,'independent-native-coupon-history-key-'*3,Cache(),settings,False,'Asia/Kolkata',clock=f.now,point_factory=datetime.now)
    class Heads:
        def policy(self,_session):return {'contract':'explicit-test-projection-port-v1','metadataHash':'a'*64,'qualifierHash':'b'*64}
        def capture(self,session,customer,coupon):
            revision=one(session,'SELECT revision FROM fixture_member_head WHERE customer_id=:customer FOR SHARE',{'customer':customer})
            return {'customer':customer,'coupon':str(coupon),'revision':str(revision['revision'])}
    coupons.heads=Heads()
    class ValidationException(Exception):
        def __init__(self,title):self.title=title;super().__init__(title)
    module('controllers.cart.cartutils',{'ValidationException':ValidationException})
    # Original helper bodies are pin checked and recompiled by the production
    # source adapter for each exact coupon. The aliases here are those exports
    # the real source installation wraps; no alternative validation is used.
    def unscoped(*_args,**_kwargs):raise AssertionError('Original coupon called outside its real preview scope')
    reader=SimpleNamespace(fetch_one=unscoped,fetch=unscoped,execute=unscoped)
    ns=compile_coupon(SOURCE,settings_namespace(settings,datetime.now(),reader,None,ValidationException,f.cart_module.ItemTypes,lambda *_a:False))
    meta=module('controllers.cart.initializers.MetaInitializers',dict(ns,logger=Silent()))
    initial=compile_class(SOURCE,'controllers/cart/initializers/MetaInitializers.py','MetaInitializer',
        dict(meta.__dict__,Initializer=type('Initializer',(),{})))
    module('controllers.cart.validators.CouponValidation',{'apply_coupon':ns['apply_coupon']})
    module('controllers.cart.wrappers.CouponWrapper',{'calculate_coupon_discount':ns['calculate_coupon_discount']})
    module('libs.OrderHelper',{'auto_apply_birthday_coupon':ns['auto_apply_birthday_coupon'],'get_auto_apply_coupon':ns['get_auto_apply_coupon']})
    module('libs.helper',{'get_birthday_coupon_details':ns['get_birthday_coupon_details']})
    # compile_class used a copy of globals. Publish those same globals as the
    # authentic module so install() can replace its captured original aliases.
    actual=initial.initialize.__globals__
    meta.__dict__.update(actual)
    initial.initialize.__globals__['get_valid_coupon']=meta.get_valid_coupon
    install()
    # The real source class' globals are the module dictionary in production;
    # preserve that alias update in this isolated AST-only source loader.
    actual['get_valid_coupon']=meta.get_valid_coupon
    actual['logger']=meta.logger
    original=initial()
    f.meta_callback=lambda context,item:None
    f.native_coupon_initializer=original
    f.coupon_calls=[];f.coupon_document_mutator=None
    f.owner.coupons=coupons
    def read(request):
        if f.leased or CURRENT.get() is not None:raise AssertionError('Coupon history retained SQL')
        f.coupon_calls.append(copy.deepcopy(request));now=f.now()
        body={'contract':'pos-screening-origin-coupon-preview-v1',**copy.deepcopy(request),
            'generationId':'c'*64,'publication':{'fixture':'generated-only'},
            'facts':{'birthdayTodayUsage':'0','globalUsage':'0','customerOrderCount':'0','monthlyJoinedUsage':'0','lotCounts':[]},
            'reader':'bigquery','complete':True,'fetchedAt':now,'expiresAt':min(now+30000,request['preview']['expiresAt'])}
        document={**body,'signature':digest(KEY,'coupon-preview',body)}
        return f.coupon_document_mutator(document) if f.coupon_document_mutator else document
    f.owner.coupon_preview_provider=SimpleNamespace(read=read)
    return coupons
