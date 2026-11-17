"""Actual owned issuer/client against disposable MySQL; external auth/HTTP ports
are fixture adapters. No source application startup or provider is invoked.
"""
import copy
import importlib
import json
import os
from pathlib import Path
import sys
import time
import types
import unittest
from contextlib import contextmanager
from unittest.mock import patch
import jwt
import pymysql
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

HERE = Path(__file__).resolve().parent
for directory in (HERE, HERE.parent/'legacy-order-imports', HERE.parent/'legacy-order-imports/benefit-profile', HERE.parent/'public-screening-writer'):
    sys.path.insert(0, str(directory))
from origin_contracts import digest, canonical, OriginReview
import origin_stage_recovery as recovery
import legacy_cart_client as cart
import legacy_staff
from native import HEADER, LINE
from origin_frame import ALLOCATION

KEY = 'fixture-origin-independent-key-0123456789'
JWT_KEY = 'fixture-original-customer-jwt-key-0123456789'
COMMAND = '11111111-1111-4111-8111-111111111111'
RECOVERY = '22222222-2222-4222-8222-222222222222'
H = 'a'*64


class NativeConnection:
    def __init__(self, configuration):
        self.connection = pymysql.connect(**configuration, autocommit=True)
        self.in_atomic_block = False
    def cursor(self): return self.connection.cursor()
    def get_autocommit(self): return self.connection.get_autocommit()
    @contextmanager
    def atomic(self, using):
        if using != 'mysql_db' or self.in_atomic_block: raise AssertionError('fixture transaction scope')
        self.connection.begin(); self.in_atomic_block = True
        try:
            yield
            self.connection.commit()
        except BaseException:
            self.connection.rollback(); raise
        finally: self.in_atomic_block = False


class Session(dict):
    session_key = 'fixture-real-django-session-key'
    def get_expiry_date(self):
        import datetime
        return datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)


class PaymentRecoveryNative(unittest.TestCase):
    def setUp(self):
        configuration = json.loads(os.environ['POS_ORIGIN_PYTHON_MYSQL'])
        if configuration.get('host') != '127.0.0.1' or configuration.get('database') != 'pos_origin_python_test' or configuration.get('user') != 'root':
            raise AssertionError('refusing non-isolated source fixture')
        url = 'mysql+pymysql://root@127.0.0.1:'+str(configuration['port'])+'/pos_origin_python_test'
        self.engine = create_engine(url)
        self.sessions = sessionmaker(self.engine)
        self.connection = NativeConnection(configuration)
        self.addCleanup(self.connection.connection.close); self.addCleanup(self.engine.dispose)
        self.now = int(time.time()*1000)
        self.token = jwt.encode({'sub': '77', 'exp': int(time.time())+3600}, JWT_KEY, algorithm='HS256')
        if isinstance(self.token, bytes): self.token = self.token.decode()
        settings = types.SimpleNamespace(SECRET_KEY=JWT_KEY, SECRET_KEY_512=JWT_KEY+'-512', MAIN_API_V2_URL='https://main.fixture.test/api/v2/', API_V2_URL='https://old.fixture.test/api/v2/')
        conf = types.ModuleType('django.conf'); conf.settings = settings
        db = types.ModuleType('django.db'); db.connections = {'mysql_db': self.connection}; db.transaction = types.SimpleNamespace(atomic=self.connection.atomic)
        helpers = types.ModuleType('helpers.helpers'); helpers.Helpers = types.SimpleNamespace(get_checkin_data=lambda actor: [2, 'fixture'] if str(actor)=='9' else None)
        auth = types.ModuleType('utils.auth')
        auth.decodeJwt = lambda token: jwt.decode(token, JWT_KEY, algorithms=['HS256'], options={'verify_aud': False})
        auth.decodeJwt512 = lambda token: jwt.decode(token[3:], JWT_KEY+'-512', algorithms=['HS512'], options={'verify_aud': False})
        hooks = types.ModuleType('utils.hooks'); hooks.auth_required = lambda req, *_args: auth.decodeJwt(req.auth)
        modules = {'django': types.ModuleType('django'), 'django.conf': conf, 'django.db': db,
                   'helpers': types.ModuleType('helpers'), 'helpers.helpers': helpers,
                   'utils': types.ModuleType('utils'), 'utils.auth': auth, 'utils.hooks': hooks}
        self.module_patch = patch.dict(sys.modules, modules); self.module_patch.start(); self.addCleanup(self.module_patch.stop)
        self.env_patch = patch.dict(os.environ, {'POS_SCREENING_ORIGIN_CONTRACT': 'pos-screening-origins-v1', 'POS_SCREENING_ORIGIN_PROOF_KEY': KEY}); self.env_patch.start(); self.addCleanup(self.env_patch.stop)
        self.req = types.SimpleNamespace(user=types.SimpleNamespace(id=9, is_authenticated=True, password='fixture-native-password', get_session_auth_hash=lambda: 'fixture-authenticated-session-hash'),
            session=Session(_auth_user_id='9', _auth_user_hash='fixture-authenticated-session-hash', _screening_original_auth_epoch='0'),
            META={}, COOKIES={}, POST={'store_id':'2', 'counter_id':'3'}, resolver_match=types.SimpleNamespace(kwargs={}), params={}, auth=self.token, context={})
        self.headers = {}
        self.req.get_header = lambda name: self.headers.get(name)
        self.owner = types.SimpleNamespace(key=KEY, sessions=self.sessions, clock=lambda: self.now)
        self.install()

    def execute(self, sql, parameters=None):
        with self.engine.begin() as connection:
            return connection.execute(text(sql), parameters or {})

    def install(self):
        tables = ['users','orders','has_products','order_stores','spiderman_screening_orders','pos_user','stores','store_counters','user_stores',
                  'pos_rewrite_operator_auth_epochs','pos_rewrite_screening_origin_sessions','pos_rewrite_screening_origin_staff_grants',
                  'cart_items','cart_meta','pos_rewrite_screening_origin_commands','pos_rewrite_screening_origin_creations',
                  'pos_rewrite_screening_origin_payment_attempts','pos_rewrite_screening_origin_stage_recoveries','pos_rewrite_screening_origin_stage_recovery_uses']
        for table in tables: self.execute('DROP TABLE IF EXISTS '+table)
        order_numbers = 'user_id payment_method pay_amt cashback_used tss_money_used tss_points_used voucher_used voucher_amt_used coupon_used coupon_amt_used currency_conv_rate shipping_amt order_amt fraction_value country_id zone_id parent_order_id original_order_id hl_parent_order_id location_id location_type is_express flag_id is_new_calc order_status'.split()
        order_strings = 'currency first_name last_name address1 address2 address3 phone_no postal_code city'.split()
        hp_numbers = 'prod_id sub_prod_id qty price gst pre_gst_amt disc wallet_disc voucher_disc hp_tss_points_used amount_to_be_refunded fraction_value'.split()
        ddls = [
            'CREATE TABLE users(id BIGINT PRIMARY KEY,firstname VARCHAR(32),lastname VARCHAR(32),email VARCHAR(96),telephone VARCHAR(32),status INT,is_block INT,is_disabled INT,is_two_fa INT,tss_money DOUBLE,tss_points DOUBLE,cashback DOUBLE,is_cod_enable INT,fb_id VARCHAR(32),gender VARCHAR(8),birthdate VARCHAR(32))',
            'CREATE TABLE orders(id BIGINT PRIMARY KEY,created_at DATETIME,'+','.join(name+(' DECIMAL(12,2) DEFAULT 0' if name in {'pay_amt','cashback_used','tss_money_used','tss_points_used','voucher_amt_used','coupon_amt_used','currency_conv_rate','shipping_amt','order_amt','fraction_value'} else ' BIGINT DEFAULT 0') for name in order_numbers)+','+','.join(name+" VARCHAR(96) DEFAULT ''" for name in order_strings)+')',
            'CREATE TABLE has_products(id BIGINT PRIMARY KEY,order_id BIGINT,'+','.join(name+(' BIGINT DEFAULT 0' if name in {'prod_id','sub_prod_id','qty'} else ' DECIMAL(12,2) DEFAULT 0') for name in hp_numbers)+')',
            'CREATE TABLE order_stores(order_id BIGINT,store_id BIGINT,counter_id BIGINT)',
            'CREATE TABLE spiderman_screening_orders(id BIGINT PRIMARY KEY,order_id BIGINT,user_id BIGINT,has_product_id BIGINT,KEY idx_order_id(order_id))',
            'CREATE TABLE pos_user(id BIGINT PRIMARY KEY,password VARCHAR(96),role INT,user_type INT,is_active INT)',
            'CREATE TABLE stores(id BIGINT PRIMARY KEY,is_active INT,type VARCHAR(32),category VARCHAR(32))',
            'CREATE TABLE store_counters(id BIGINT PRIMARY KEY,store_id BIGINT,is_active INT)',
            'CREATE TABLE user_stores(id BIGINT,django_user_id BIGINT,store_id BIGINT)',
            'CREATE TABLE pos_rewrite_operator_auth_epochs(operator_id BIGINT PRIMARY KEY,epoch BIGINT UNSIGNED)',
            'CREATE TABLE pos_rewrite_screening_origin_sessions(id VARCHAR(36) PRIMARY KEY,origin VARCHAR(32),actor_id BIGINT,session_hash VARCHAR(64),data JSON,proof_hash VARCHAR(64),revoked INT)',
            'CREATE TABLE pos_rewrite_screening_origin_staff_grants(id VARCHAR(36) PRIMARY KEY,actor_id BIGINT,session_hash VARCHAR(64),data JSON,proof_hash VARCHAR(64),revoked INT)',
            'CREATE TABLE cart_items(cart_id VARCHAR(96),status VARCHAR(16),prod_id BIGINT,option_id BIGINT,combo_parent_id BIGINT,combo_price_fraction DOUBLE,`select` INT,quantity BIGINT,print_name VARCHAR(32),added_at DATETIME)',
            'CREATE TABLE cart_meta(cart_id VARCHAR(96),name VARCHAR(32),value TEXT)',
            'CREATE TABLE pos_rewrite_screening_origin_commands(id VARCHAR(36) PRIMARY KEY,origin VARCHAR(32),customer_id BIGINT,actor_id BIGINT,store_id BIGINT,counter_id BIGINT,phase VARCHAR(16),order_id BIGINT,data JSON,proof_hash VARCHAR(64))',
            'CREATE TABLE pos_rewrite_screening_origin_creations(command_id VARCHAR(36) PRIMARY KEY,order_id BIGINT,data JSON,proof_hash VARCHAR(64))',
            'CREATE TABLE pos_rewrite_screening_origin_payment_attempts(command_id VARCHAR(36) PRIMARY KEY,order_id BIGINT,customer_id BIGINT,phase VARCHAR(16),data JSON,proof_hash VARCHAR(64))',
            'CREATE TABLE pos_rewrite_screening_origin_stage_recoveries(recovery_id VARCHAR(36) PRIMARY KEY,command_id VARCHAR(36),order_id BIGINT,data JSON,proof_hash VARCHAR(64))',
            'CREATE TABLE pos_rewrite_screening_origin_stage_recovery_uses(recovery_id VARCHAR(36) PRIMARY KEY,command_id VARCHAR(36),order_id BIGINT,data JSON,proof_hash VARCHAR(64))',
        ]
        for ddl in ddls: self.execute(ddl)
        for sql in ["INSERT INTO users VALUES(77,'Native','Fixture','fixture@example.test','9000000000',1,0,0,0,0,0,0,1,'','','')",
                    "INSERT INTO pos_user VALUES(9,'fixture-native-password',1,1,1)", "INSERT INTO stores VALUES(2,1,'STORE','IN_HOUSE')", 'INSERT INTO store_counters VALUES(3,2,1)',
                    "INSERT INTO orders(id,user_id,payment_method,pay_amt,created_at) VALUES(700,77,1,500,'2026-11-18 00:00:00')",
                    'INSERT INTO has_products(id,order_id,prod_id,qty) VALUES(701,700,390238,1)', 'INSERT INTO order_stores VALUES(700,2,3)', 'INSERT INTO spiderman_screening_orders VALUES(702,700,77,701)']:
            self.execute(sql)
        with self.engine.connect() as connection:
            header, allocation = connection.execute(text('SELECT '+HEADER+','+ALLOCATION+' FROM orders WHERE id=700')).one()
            line = connection.execute(text('SELECT '+LINE+' FROM has_products WHERE id=701')).scalar_one()
        self.command = {'contract':'pos-screening-origin-command-v1','id':COMMAND,'origin':'legacy-django','customerId':'77','actorId':'9','storeId':'2','counterId':'3',
            'namespaceHash':H,'requestHash':H,'cartHash':H,'referenceHash':H,'authorityHash':H,'quantity':1,'markerRows':1,'lineItemsEnabled':True,
            'phase':'BOUND','orderId':'700','lines':[{'id':'701','quantity':1}],'markers':[{'id':'702','lineId':'701'}],
            'creationHash':None,'closureHash':None,'version':3,'createdAt':self.now-1000,'updatedAt':self.now-500,'expiresAt':self.now+599000}
        self.creation = {'contract':'pos-screening-origin-creation-v1','commandId':COMMAND,'origin':'legacy-django','customerId':'77','actorId':'9','storeId':'2','counterId':'3',
            'requestHash':H,'cartHash':H,'referenceHash':H,'authorityHash':H,'orderId':'700','method':1,'headerHash':header,'allocationHash':allocation,
            'lines':[{'id':'701','productId':'390238','quantity':1,'inputHash':line}],'sourceCommit':'2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'}
        self.command['creationHash'] = digest(KEY,'creation',self.creation)
        self.execute('INSERT INTO pos_rewrite_screening_origin_commands VALUES(:id,:origin,77,9,2,3,\'BOUND\',700,:data,:proof)', {'id':COMMAND,'origin':'legacy-django','data':canonical(self.command),'proof':digest(KEY,'command',self.command)})
        self.execute('INSERT INTO pos_rewrite_screening_origin_creations VALUES(:id,700,:data,:proof)', {'id':COMMAND,'data':canonical(self.creation),'proof':self.command['creationHash']})
        self.stage = {'contract':'pos-screening-origin-payments-v1','commandId':COMMAND,'orderId':'700','customerId':'77','creationHash':self.command['creationHash'],
            'requestHash':H,'referenceHash':H,'paymentRequestHash':H,'phase':'PENDING','provider':'juspay','payloadHash':'c'*64,'responseHash':None,'observationHash':None,'declined':False,'createdAt':self.now-100,'updatedAt':self.now-100,'version':1}
        self.execute('INSERT INTO pos_rewrite_screening_origin_payment_attempts VALUES(:id,700,77,\'PENDING\',:data,:proof)', {'id':COMMAND,'data':canonical(self.stage),'proof':digest(KEY,'payment-attempt',self.stage)})
        trusted = cart.AuthenticatedCartRequest(self.req, '9')
        self.headers = legacy_staff.issue(trusted,self.token,{'store_id':'2','counter_id':'3'},_creation=self.creation)
        self.now = int(time.time()*1000)
        self.req.context = {'session':self.sessions(),'user':{'user_id':'77'},'data':{}}
        self.addCleanup(self.req.context['session'].close)

    def test_real_native_issuer_persists_exact_nonrenewable_receipt(self):
        issuer = recovery.StageRecoveryIssuer(self.owner)
        result = issuer.issue(self.req,COMMAND,RECOVERY,'session-renewal')
        self.assertEqual(result['status'],'AUTHORIZED')
        value = result['recovery']['data']
        self.assertEqual(value['attemptHash'],digest(KEY,'payment-attempt',self.stage))
        self.assertTrue(value['noProviderStart']); self.assertEqual(value['expiresAt'],self.now+60000)
        self.assertEqual(result['recovery']['proofHash'],digest(KEY,'payment-stage-recovery',value))
        self.assertEqual(self.req.context['screening_origin_event_actor_id'],'9')
        self.now += 1000
        prior = issuer.read(self.req,COMMAND,RECOVERY)
        self.assertEqual(prior['recovery'],result['recovery']); self.assertEqual(prior['expiresAt'],result['expiresAt'])
        self.stage['version'] += 1; self.stage['updatedAt'] += 1
        self.execute('UPDATE pos_rewrite_screening_origin_payment_attempts SET data=:data,proof_hash=:proof',{'data':canonical(self.stage),'proof':digest(KEY,'payment-attempt',self.stage)})
        stale=issuer.read(self.req,COMMAND,RECOVERY); self.assertEqual(stale['status'],'STALE_ATTEMPT'); self.assertNotIn('headers',stale)

    def test_native_structure_change_refuses_recovery_without_new_order(self):
        self.execute('UPDATE has_products SET qty=2 WHERE id=701')
        with self.assertRaises(OriginReview): recovery.StageRecoveryIssuer(self.owner).issue(self.req,COMMAND,RECOVERY,'source-reconciliation')
        with self.engine.connect() as connection:
            self.assertEqual(connection.execute(text('SELECT COUNT(*) FROM orders')).scalar_one(),1)
            self.assertEqual(connection.execute(text('SELECT COUNT(*) FROM pos_rewrite_screening_origin_stage_recoveries')).scalar_one(),0)

    def test_actual_legacy_grant_transport_hashes_exact_body_and_ends_sql(self):
        observed={}
        response=types.SimpleNamespace(status_code=200,headers={'Content-Type':'application/json'},iter_content=lambda chunk_size:iter([b'{"source":true}']),close=lambda:None)
        def send(url,**options):
            self.assertFalse(self.connection.in_atomic_block)
            observed.update(url=url,**options)
            with self.engine.connect() as connection:
                row=connection.execute(text('SELECT data,proof_hash FROM pos_rewrite_screening_origin_staff_grants WHERE id=:id'),{'id':options['headers']['X-TSS-Screening-Staff-Grant']}).one()
            grant=json.loads(row[0])
            from writer_protocol import portable_hash
            self.assertEqual(grant['requestHash'],portable_hash({'data':options['json'],'params':{}}))
            self.assertEqual(row[1],digest(KEY,'staff-grant',grant))
            return response
        body={'payload':{'operation':'get'},'is_pos':True,'store_id':2}
        with patch.object(cart.requests,'post',send):
            result=cart.post(self.req,'https://main.fixture.test/api/v2/cart',body,{'Authorization':self.token})
        self.assertIs(result,response); self.assertNotIn('counter_id',body)
        self.assertEqual(observed['json']['counter_id'],'3'); self.assertFalse(observed['allow_redirects']); self.assertEqual(observed['timeout'],(5,20))
        self.assertNotIn('X-TSS-Screening-Command',observed['headers'])
        self.assertNotIn('X-TSS-Screening-Payment-Authorization',observed['headers'])

    def test_stale_actor_or_unknown_target_never_sends(self):
        with patch.object(cart.requests,'post') as send:
            self.req.META['HTTP_X_TSS_SCREENING_ACTOR']='8'
            with self.assertRaises(OriginReview): cart.post(self.req,'https://main.fixture.test/api/v2/cart',{'is_pos':True,'store_id':2},{'Authorization':self.token})
            self.req.META.clear()
            with self.assertRaises(OriginReview): cart.post(self.req,'https://main.fixture.test/api/v2/pos/order',{'is_pos':True,'store_id':2},{'Authorization':self.token})
            send.assert_not_called()


if __name__ == '__main__': unittest.main()
