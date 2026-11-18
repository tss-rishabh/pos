"""Pinned Cart/middleware/auth with synthetic current catalog and local MySQL.

This is a source control-flow fixture, not a catalog/tax or deployed BQ claim.
Historical documents are generated fixture inputs. Every native connection is
localhost/disposable, every source file is pin checked and providers are absent.
"""
import ast
import copy
import enum
import hashlib
import importlib
import json
import os
import sys
import time
from collections import defaultdict
from contextlib import ExitStack,contextmanager
from datetime import datetime,timedelta
from pathlib import Path
from types import ModuleType,SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from sqlalchemy import create_engine,event,text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

ROOT=Path(__file__).resolve().parents[2]
for folder in ('legacy-order-imports','offline-cash-pricing','public-screening-writer','screening-origins','legacy-order-imports/benefit-profile'):
    sys.path.insert(0,str(ROOT/'compatibility/upstream'/folder))
sys.path.insert(0,str(ROOT/'tools/legacy-import-preparation'))
from origin_contracts import digest,fail
from origin_frame import OriginRuntime,LegacySession
from transaction import CURRENT,guard_private_commit,guard_private_statement
from source_runtime import SilentLogger
import origin_preview

SOURCE=Path(os.environ['POS_LEGACY_IMPORT_SOURCE_ROOT'])
KEY='isolated-origin-preview-native-key-'*3
CUSTOMER_KEY='isolated-genuine-source-customer-jwt-'*3
PINS={
 'controllers/cart/Cart.py':'1f9eff0f1a4ea66f3cac8903d3c1cb9a5b39e2a3babd6dd6c8dcf192de7defd3',
 'middleware/CartMiddleware.py':'e7db74af2d1e2c3582fd0d56b6eac0e95cd4f78e7987950a9fd91c10162aa6ed',
 'middleware/ActiveCartMiddleware.py':'4140090797ec213b98fbe8954112102913a1446fc9c9f9798277b4ee921f4406',
 'controllers/cart/cart_serializer.py':'512faab344a8d4fdb82476845bdec85b2cce4daa7d6f0814ec06c8a3d34fb429',
 'database/mysqlCart.py':'d8649e9e50b79812cb9fa6f997e6141fa0b5a3e337b79f24d21310b16cd8211d',
 'utils/auth.py':'06fae2d0997fe6f0ae6eddf9ddfe1b8548d1afb510eabe394eee09db7b9c01dc',
 'utils/hooks.py':'fab95a7ed510274de700190a73ceedddc21dad5e70f8559200917bf07c35696e',
 'libs/query.py':'9949ab5d059f465873d94d651e9a5b03bedae7e7ff54e2d118fb95ded3d7c6be',
 'constants/StatusEnum.py':'42cb694ff628c61ef8a5ec169a4b319a8c1491ef2a698f93665348e6b22d0a06',
}


def nodes(path,names):
    raw=(SOURCE/path).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=PINS[path]:raise AssertionError('Pinned source fixture changed: '+path)
    return [node for node in ast.parse(raw).body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in names]


def module(name,values):
    for index in range(1,len(name.split('.'))):
        parent='.'.join(name.split('.')[:index])
        if parent not in sys.modules:
            package=ModuleType(parent);package.__path__=[];sys.modules[parent]=package
    result=ModuleType(name);result.__dict__.update(values);sys.modules[name]=result
    if '.' in name:setattr(sys.modules[name.rsplit('.',1)[0]],name.rsplit('.',1)[1],result)
    return result


def classes(path,names,values):
    exec(compile(ast.Module(body=nodes(path,names),type_ignores=[]),'<pinned-'+path+'>','exec'),values)
    return values


class Response:
    def __init__(self):self.status='200 OK';self.text=None;self.headers={};self.complete=False
    @property
    def body(self):return self.text
    @body.setter
    def body(self,value):self.text=value
    def set_header(self,name,value):self.headers[name]=value


class Fixture:
    def __init__(self,url):
        parsed=make_url(url)
        if (parsed.drivername not in ('mysql','mysql+pymysql') or parsed.host not in ('localhost','127.0.0.1')
                or parsed.database!='pos_rewrite_origin_preview_test' or parsed.query):raise AssertionError('Explicit isolated origin preview URL required')
        self.schema='pos_rewrite_origin_preview_'+uuid4().hex[:12]
        admin=create_engine(parsed.set(drivername='mysql+pymysql',database='mysql'),hide_parameters=True)
        with admin.begin() as connection:connection.execute(text('CREATE DATABASE `'+self.schema+'`'))
        admin.dispose()
        self.engine=create_engine(parsed.set(drivername='mysql+pymysql',database=self.schema),hide_parameters=True,pool_size=4,max_overflow=0)
        self.sessions=sessionmaker(bind=self.engine,expire_on_commit=False)
        self.leased=set();self.sql=[];self.meta_callback=None
        event.listen(self.engine,'checkout',lambda _db,record,_proxy:self.leased.add(id(record)))
        event.listen(self.engine,'checkin',lambda _db,record:self.leased.discard(id(record)))
        event.listen(self.engine,'commit',guard_private_commit)
        event.listen(self.engine,'before_cursor_execute',guard_private_statement)
        def capture(_connection,_cursor,statement,parameters,_context,_many):
            self.sql.append(statement)
            return statement.replace('tss.products','`'+self.schema+'`.products'),parameters
        event.listen(self.engine,'before_cursor_execute',capture,retval=True)
        statements=[
         '''CREATE TABLE users(id BIGINT PRIMARY KEY,firstname VARCHAR(40),lastname VARCHAR(40),email VARCHAR(255) COLLATE utf8mb3_general_ci,telephone VARCHAR(40),status INT,is_block INT,is_disabled INT,is_two_fa INT,tss_money DOUBLE,tss_points DOUBLE,cashback DOUBLE,is_cod_enable INT,fb_id VARCHAR(40),gender VARCHAR(16),birthdate DATE,referal_code VARCHAR(40),loyalty_group INT,user_type INT)''',
         '''CREATE TABLE user_eav(id BIGINT AUTO_INCREMENT PRIMARY KEY,entity VARCHAR(255),attribute VARCHAR(80),value TEXT,is_active INT,created_at DATETIME NULL,updated_at DATETIME NULL)''',
         '''CREATE TABLE products(id BIGINT PRIMARY KEY,price DOUBLE,is_avail INT,is_del INT)''',
         '''CREATE TABLE cart_items(cart_id VARCHAR(255) COLLATE utf8mb3_bin,prod_id BIGINT,user_id BIGINT,option_id VARCHAR(100),combo_parent_id BIGINT,combo_price_fraction DOUBLE,`select` INT,quantity INT,print_name VARCHAR(255),status VARCHAR(16),added_at DATETIME,UNIQUE KEY cart_product(cart_id,prod_id))''',
         '''CREATE TABLE cart_meta(cart_id VARCHAR(255) COLLATE utf8mb3_bin,name VARCHAR(100),value LONGTEXT,updated_at DATETIME,PRIMARY KEY(cart_id,name))''',
         '''CREATE TABLE fixture_counter(customer_id BIGINT PRIMARY KEY,n INT,revision BIGINT)''',
         '''CREATE TABLE fixture_member_head(customer_id BIGINT PRIMARY KEY,revision BIGINT)''',
        ]
        with self.engine.begin() as connection:
            for statement in statements:connection.execute(text(statement))
            for filename in ('migration.sql','preview-migration.sql','effects-migration.sql'):
                ddl='\n'.join(line for line in (ROOT/'compatibility/upstream/screening-origins'/filename).read_text().splitlines() if not line.lstrip().startswith('--'))
                for statement in ddl.split(';'):
                    if statement.strip():connection.execute(text(statement))
            connection.execute(text("INSERT INTO users VALUES(77,'Fixture','Customer','fixture@example.test','9999999999',1,0,0,0,0,0,0,1,'','',NULL,'',0,0)"))
            connection.execute(text('INSERT INTO products VALUES(390238,25,1,0),(12,0,1,0),(10,100,1,0)'))
            connection.execute(text('INSERT INTO fixture_counter VALUES(77,0,0)'))
            connection.execute(text('INSERT INTO fixture_member_head VALUES(77,0)'))
            connection.execute(text("INSERT INTO cart_items(cart_id,prod_id,user_id,`select`,quantity,print_name,status,added_at) VALUES('cart_77',390238,77,1,1,'','active','2026-06-15 12:00:00')"))
        self.patches=ExitStack();self._modules()
        self.owner=OriginRuntime(self.sessions,KEY,'different-source-only-proof-key-'*3,False,self.now)
        from origin_membership import OriginMembership,install
        self.owner.membership=OriginMembership(self.settings,KEY,self.now,datetime.now,'Asia/Kolkata')
        install(SOURCE)
        self.patches.enter_context(patch('screening_counter.read_current',self.counter))
        self.patches.enter_context(patch('origin_ledger.all_pending',self.pending))
        self.patches.enter_context(patch('membership_history_heads.capture',self.head))
        self.patches.enter_context(patch('membership_history_heads.validate',lambda session,customer,expected:self.assert_head(session,customer,expected)))
        self.owner.membership_history_provider=SimpleNamespace(preview=self.history)
        origin_preview.install_middleware(self.owner)
        self.principal_changes=None;self.provider_calls=0;self.member_selection=None
    def now(self):return int(time.time()*1000)
    def counter(self,session,customer):
        from native import one
        row=one(session,'SELECT n FROM fixture_counter WHERE customer_id=:id FOR SHARE',{'id':customer})
        def guard():
            if not session.in_transaction():raise AssertionError('Counter escaped its transaction')
        return SimpleNamespace(customer=customer,count=row['n'],guard=guard)
    def pending(self,session,customer,*_keys):
        from native import rows
        if rows(session,"SELECT id FROM pos_rewrite_screening_origin_commands WHERE customer_id=:id AND phase NOT IN ('PREPARED','REJECTED') LIMIT 1",{'id':customer},1):raise AssertionError('Fixture pending port has no reserved facts')
        return 0
    def head(self,session,customer,lock=False):
        from native import one
        row=one(session,'SELECT revision FROM fixture_member_head WHERE customer_id=:id'+(' FOR SHARE' if lock else ''),{'id':customer})
        return {'contract':'pos-membership-history-head-v1','origin':{'schema':self.schema,'serverUuid':'11111111-1111-4111-8111-111111111111'},'revision':str(row['revision']),'writersHash':'a'*64}
    def assert_head(self,session,customer,expected):
        if self.head(session,customer)!=expected:fail('SCREENING_ORIGIN_MEMBERSHIP_CHANGED')
    def history(self,preview,scope,head):
        if self.leased or CURRENT.get() is not None:raise AssertionError('History I/O retained a native connection')
        self.provider_calls+=1
        if self.principal_changes:self.principal_changes()
        now=self.now()
        body={'contract':'pos-screening-origin-membership-preview-v1','scope':scope,'head':head,'generationId':'1'*64,
              'sourceCaptureHash':'2'*64,'publicationHash':'3'*64,'reader':'bigquery','complete':True,'fetchedAt':now,
              'expiresAt':min(now+30000,preview['expiresAt']),'selection':{'lastDeliveredOrder':None,'recentDeliveredOrders':[]}}
        return {**body,'signature':digest(KEY,'membership-preview',body)}
    def command_member_history(self,value,scope,head):
        if self.leased or CURRENT.get() is not None:raise AssertionError('Final member history retained SQL')
        self.provider_calls+=1
        if self.principal_changes:self.principal_changes()
        now=self.now()
        body={'contract':'pos-screening-origin-membership-history-v1','scope':scope,'head':head,'generationId':'1'*64,
              'sourceCaptureHash':'2'*64,'publicationHash':'3'*64,'reader':'bigquery','complete':True,'fetchedAt':now,
              'expiresAt':min(now+30000,value['expiresAt']),'selection':self.member_selection(scope) if self.member_selection else {'lastDeliveredOrder':None,'recentDeliveredOrders':[]}}
        return {**body,'signature':digest(KEY,'membership-history',body)}
    def _modules(self):
        import jwt
        self.settings=SimpleNamespace(SECRET_KEY=CUSTOMER_KEY,SECRET_KEY_512=CUSTOMER_KEY+'512',TXN_LOCK_ENABLE=False,
            CART_REQUIRED_ENDPOINTS=['/api/v2/cart','/api/v2/order'],EXCLUSIVE_PRODUCT={'10':{}},EXCLUSIVE_UPGRADE_PRODUCT={},
            MEMBERSHIP_PROD_ID=('10','12'),FREE_EXCLUSIVE_PRODUCT='12')
        class Unauthorized(Exception):pass
        auth=classes('utils/auth.py',{'decodeJwt','decodeJwt512'},{'jwt':jwt,'settings':self.settings,'falcon':SimpleNamespace(HTTPUnauthorized=Unauthorized)})
        module('utils.auth',auth)
        query=ast.parse((SOURCE/'libs/query.py').read_bytes())
        user_query=next(ast.literal_eval(node.value) for node in query.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='USER_WITH_ID_Q' for t in node.targets))
        def fetch_one(session,statement,to_dict=False):return dict(session.execute(text(statement)).mappings().one())
        hooks=classes('utils/hooks.py',{'auth_required'},{'falcon':SimpleNamespace(HTTPUnauthorized=Unauthorized),'USER_WITH_ID_Q':user_query,'fetchOne':fetch_one})
        module('utils.hooks',hooks)
        fixture=self
        class Initializer:
            def initialize(self,context,item):return copy.deepcopy(item)
            def batch_initialize(self,context,items):return [self.initialize(context,item) for item in items]
        class ProductInitializer(Initializer):
            def initialize(self,context,item):
                result=context['session'].execute('SELECT id,price FROM products WHERE id=:id',{'id':item['prod_id']}).fetchone()
                return {**copy.deepcopy(item),'prod_id':int(result['id']),'price':float(result['price']),'spl_price':0,'stock':100,
                    'categories':[],'images':[],'prod_type':1,'is_mystery_product':False,'parent_prod_id':0,'is_printable':False}
        class MetaInitializer(Initializer):
            def initialize(self,context,item):
                if fixture.meta_callback:fixture.meta_callback(context,item)
                return super().initialize(context,item)
        class Validator:
            def validate(self,*_args):return None
        class Calculations:
            def apply(self,cart,**_kwargs):
                value=sum(item['price']*item.get('quantity',1) for item in cart.get(cart.types.PRODUCTS))
                cart.update({'type':'meta','data':{'name':'calculations','main_sub_total':value,'total_savings':0,'total':value}})
                cart.update({'type':'meta','data':{'name':'site_config','free_membership_removed':False}})
        payment=classes('constants/StatusEnum.py',{'PaymentMethod'},{'_IntEnum':enum.IntEnum})['PaymentMethod']
        values={'enum':enum,'json':json,'copy':copy,'time':time,'datetime':datetime,'timedelta':timedelta,'defaultdict':defaultdict,
            'ProductInitializer':ProductInitializer,'GiftVoucherInitializer':Initializer,'MetaInitializer':MetaInitializer,
            'CouponValidator':Validator,'ProductValidator':Validator,'GiftVoucherValidator':Validator,'WidgetValidator':Validator,
            'logger':SilentLogger(),'SessionR':None,'FREE_EXCLUSIVE_PRODUCT':'12','BAMBOO_TOOTHBRUSH_EM':'99',
            'EXCLUSIVE_PRODUCT':{'10':{}},'MEMBERSHIP_PROD_ID':('10','12'),'PaymentMethod':payment,
            'AddBambooToothbrush':lambda *_a:SimpleNamespace(remove_bamboo_toothbrush=lambda:None)}
        classes('controllers/cart/Cart.py',{'gift_voucher_indexer','ItemTypes','EmptyItemException','IndexException','IndexedItemStore','Cart','AddFreeMembership'},values)
        self.cart_module=module('controllers.cart.Cart',values)
        serializer=classes('controllers/cart/cart_serializer.py',{'CartSerializer'},{'copy':copy,'json':json,'ProductInitializer':ProductInitializer,'logger':SilentLogger()})
        module('controllers.cart.cart_serializer',serializer)
        mysql=classes('database/mysqlCart.py',{'MySQLCart'},{'json':json,'time':time,'CartSerializer':serializer['CartSerializer'],'logger':SilentLogger()})
        module('database.mysqlCart',mysql)
        manager=type('PricelistManager',(),{'__init__':lambda self,context:None,'set_strict_pricelist':lambda self,value:None})
        module('controllers.priceList.PricelistManager',{'PricelistManager':manager})
        shared={**values,'settings':self.settings,'default_wrappers':[Calculations()],'MySQLCart':mysql['MySQLCart'],
            'CartSerializer':serializer['CartSerializer'],'PricelistManager':manager,'get_exclusive_token':lambda *_a:False,'is_polo_item_in_cart':lambda *_a:False}
        factories=classes('middleware/CartMiddleware.py',{'CartFactory','PosCartFactory','CartMiddleware'},dict(shared))
        active=classes('middleware/ActiveCartMiddleware.py',{'CartFactory','ActiveCartMiddleware'},dict(shared))
        self.middleware=module('middleware.CartMiddleware',factories);self.active=module('middleware.ActiveCartMiddleware',active)
    def request(self,payload=None):
        import jwt
        token=jwt.encode({'sub':'77','exp':int(time.time())+600},CUSTOMER_KEY,algorithm='HS256')
        if isinstance(token,bytes):token=token.decode()
        session=self.sessions()
        headers={}
        req=SimpleNamespace(auth=token,context={'user':{'user_id':77},'data':payload or {'payload':{'operation':'get'}},'session':session,'session_r':session},
            params={},method='POST',path='/api/v2/cart',get_header=lambda name:headers.get(name),headers=headers,access_route=['127.0.0.1'],referer=None,uri='https://fixture.invalid/api/v2/cart')
        return req,Response()
    def execute(self,req,resp,callback):return self.owner.cart(req,resp,callback)
    def original_order(self,kind,boundary):
        """Run full pinned responder until its real ValidateCheckout call.

        The boundary deliberately stops before financial creation. Tax/payment
        and provider acceptance are not claimed by this control-flow fixture.
        """
        from source_fixture import compile_class
        from source_runtime import checked_source
        class BadRequest(Exception):pass
        self.original_counter_calls=[]
        def fetch_one(session,statement,params=None,to_dict=False):
            from screening_counter import _SHAPE
            if ' '.join(str(statement).split()).strip()!=_SHAPE:raise AssertionError('Unexpected original source counter SQL')
            self.original_counter_calls.append(params)
            row=session.execute(statement,params=params).fetchone()
            if row is None:raise AssertionError('Qualified current projection did not return a count')
            return dict(row) if to_dict else row
        namespace={'json':json,'copy':copy,'datetime':datetime,'time':time,'text':text,'fetchOne':fetch_one,
            'logger':SilentLogger(),'settings':self.settings,'ItemTypes':self.cart_module.ItemTypes,
            'UniqueOrderRefNo':SimpleNamespace(orderIdentifier={'WEB':'W'}),
            'falcon':SimpleNamespace(HTTPBadRequest=BadRequest),'SCREENING_TICKET_SKU':390238,'SCREENING_MAX_TICKETS':2,
            'ValidateCheckout':lambda:SimpleNamespace(on_post=boundary)}
        helpers=[node for node in ast.parse(checked_source(SOURCE,'libs/OrderHelper.py')).body
            if isinstance(node,ast.FunctionDef) and node.name in ('get_screening_tickets_bought','enforce_screening_ticket_limit')]
        helpers.extend(node for node in ast.parse(checked_source(SOURCE,'controllers/CartController.py')).body
            if isinstance(node,ast.FunctionDef) and node.name in ('clone_cart','apply_active_cart','delete_product_from_cart'))
        exec(compile(ast.Module(body=helpers,type_ignores=[]),'<pinned-final-cart-helpers>','exec'),namespace)
        source=compile_class(SOURCE,'controllers/OrderController.py','PosOrder' if kind=='pos' else 'Order',namespace)()
        if kind=='pos':source.get_platform=lambda _store:'WEB'
        return source
    def final_request(self,kind='customer'):
        """Real native command/principal; fixture-only qualified head/counter ports."""
        from origin_auth import source_origin,staff_identity,authority_hash
        from origin_frame import namespace,request_hash,cart_native_hash
        from origin_contracts import PROOF,canonical,fingerprint
        from origin_ledger import insert
        import origin_history
        self.system() # Installs bounded history fixture ports and additive tables.
        req,resp=self.request({'payment_method':'prepaid','order_platform':'WEB'})
        if kind=='pos':
            with self.engine.begin() as connection:
                connection.execute(text('CREATE TABLE pos_user(id BIGINT PRIMARY KEY,password VARCHAR(255),role INT,user_type INT,is_active INT)'))
                connection.execute(text('CREATE TABLE pos_rewrite_operator_auth_epochs(operator_id BIGINT PRIMARY KEY,epoch BIGINT UNSIGNED)'))
                connection.execute(text('CREATE TABLE stores(id BIGINT PRIMARY KEY,is_active INT,type VARCHAR(40),category VARCHAR(40))'))
                connection.execute(text('CREATE TABLE store_counters(id BIGINT PRIMARY KEY,store_id BIGINT,is_active INT)'))
                connection.execute(text('ALTER TABLE users ADD pos_admin_id BIGINT NULL'))
                connection.execute(text("INSERT INTO pos_user VALUES(31,'synthetic-native-password-hash',1,1,1)"))
                connection.execute(text("INSERT INTO stores VALUES(31,1,'STORE','TSS')"))
                connection.execute(text('INSERT INTO store_counters VALUES(41,31,1)'))
                connection.execute(text('INSERT INTO users(id,status,is_block,is_disabled,is_two_fa,pos_admin_id) VALUES(88,1,0,0,0,31)'))
                connection.execute(text("UPDATE cart_items SET cart_id='cart_77_31' WHERE cart_id='cart_77'"))
                connection.execute(text("UPDATE cart_meta SET cart_id='cart_77_31' WHERE cart_id='cart_77'"))
            req.context['data'].update(is_pos=True,store_id=31,counter_id=41,admin_user_id=88)
            req.headers['X-TSS-Screening-Origin']='legacy-django'
            now=self.now();grant_id,session_id=str(uuid4()),str(uuid4());session_hash='d'*64
            with self.sessions() as session,session.begin():
                _actor,identity=staff_identity(session,'31',KEY)
                saved={'contract':'pos-screening-legacy-session-v1','id':session_id,'origin':'legacy-django',
                    'actorId':'31','identityHash':identity,'sessionHash':session_hash,'issuedAt':now,'expiresAt':now+600000}
                session.execute(text('INSERT INTO pos_rewrite_screening_origin_sessions VALUES(:id,:origin,31,:hash,:data,:proof,0)'),
                    {'id':session_id,'origin':'legacy-django','hash':session_hash,'data':canonical(saved),'proof':digest(KEY,'legacy-session',saved)})
                grant={'contract':'pos-screening-origin-staff-grant-v1','id':grant_id,'origin':'legacy-django','actorId':'31',
                    'customerId':'77','storeId':'31','counterId':'41','sessionHash':session_hash,'identityHash':identity,
                    'credentialHash':digest(KEY,'customer-credential',req.auth),'requestHash':request_hash(req),
                    'cartHash':cart_native_hash(session,'cart_77_31'),'issuedAt':now,'expiresAt':now+60000}
                session.execute(text('INSERT INTO pos_rewrite_screening_origin_staff_grants VALUES(:id,31,:hash,:data,:proof,0)'),
                    {'id':grant_id,'hash':session_hash,'data':canonical(grant),'proof':digest(KEY,'staff-grant',grant)})
            req.headers['X-TSS-Screening-Staff-Grant']=grant_id
        req.path='/api/v2/pos/order' if kind=='pos' else '/api/v2/order'
        req.headers['X-TSS-Screening-Command']=str(uuid4())
        with self.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _native,principal,_grant=source_origin(req,session,KEY,self.now(),req.headers.get('X-TSS-Screening-Origin','customer'))
            name=namespace(principal,req);now=self.now()
            value={'contract':PROOF,'id':req.headers['X-TSS-Screening-Command'],'origin':principal['origin'],'customerId':'77',
                **{field:principal[field] for field in ('actorId','storeId','counterId')},'namespaceHash':fingerprint(KEY,'namespace',name),
                'requestHash':request_hash(req),'cartHash':cart_native_hash(session,name),'referenceHash':'a'*64,
                'authorityHash':authority_hash(KEY,principal),'quantity':1,'markerRows':1,'lineItemsEnabled':False,
                'phase':'PREPARED','orderId':None,'lines':[],'markers':[],'creationHash':None,'closureHash':None,
                'version':1,'createdAt':now,'updatedAt':now,'expiresAt':now+600000}
            insert(session,value,KEY);head=origin_history.head(session,'77')
        document=self.owner.history_provider.read(value,head)
        with self.sessions() as session,session.begin():origin_history.save(session,value,document,KEY,self.now())
        self.owner.membership_history_provider=SimpleNamespace(read=self.command_member_history)
        self.patches.enter_context(patch('origin_frame.read_current',self.counter))
        @contextmanager
        def entry(session,customer):
            self.counter(session,customer).guard();yield
        self.patches.enter_context(patch('origin_frame.writer_entry',entry))
        return req,resp,value
    def system(self):
        from origin_system import SystemOrders,SOURCE_HASH,UTILS_HASH,service_record
        from origin_contracts import canonical
        from native import one
        with self.engine.begin() as connection:
            for filename in ('system-migration.sql','system-preparation-migration.sql','system-successor-migration.sql','assets-migration.sql','history-versions-migration.sql'):
                ddl='\n'.join(line for line in (ROOT/'compatibility/upstream/screening-origins'/filename).read_text().splitlines() if not line.lstrip().startswith('--'))
                for statement in ddl.split(';'):
                    if statement.strip():connection.execute(text(statement))
            connection.execute(text('CREATE TABLE pos_rewrite_screening_origin_payment_attempts(command_id VARCHAR(36) PRIMARY KEY)'))
        raw=(SOURCE/'controllers/external/external_api_utils.py').read_bytes()
        if hashlib.sha256(raw).hexdigest()!=UTILS_HASH:raise AssertionError('Pinned CSK auth changed')
        details={'key':'synthetic-genuine-csk-api-key','name':'fixture-csk'}
        class SourceHttpError(Exception):pass
        utilities={'api_details':details,'falcon':SimpleNamespace(HTTPForbidden=SourceHttpError)}
        auth=next(node for node in ast.parse(raw).body if isinstance(node,ast.FunctionDef) and node.name=='validate_api_key')
        exec(compile(ast.Module(body=[auth],type_ignores=[]),'<pinned-CSK-api-key>','exec'),utilities)
        utilities['validate_payload']=lambda *_args:None
        module('controllers.external.external_api_utils',utilities)
        self.settings.CSK_API_DETAILS=details;self.settings.CSK_PRICELIST=31
        self.prefix_calls=[];self.final_calls=[]
        fixture=self
        def customer(session,_data):
            self.prefix_calls.append('user')
            native=one(session,'SELECT * FROM users WHERE id=77 FOR UPDATE')
            return {**native,'user_id':77}
        def address(_session,_value,**_kwargs):self.prefix_calls.append('address');return {'name':'shipping_address','id':88}
        class BeforeOriginalOrder:
            def on_post(self,req,_resp):
                fixture.final_calls.append(req.context['cart'].get_snapshot())
                fail('SCREENING_ORIGIN_FIXTURE_BEFORE_ORIGINAL_ORDER')
        namespace={'settings':self.settings,'json':json,'get_or_create_user':customer,'make_or_update_address':address,'Order':BeforeOriginalOrder}
        self.system_owner=SystemOrders(self.owner,namespace,SOURCE/'controllers/external/OrderPlacement.py',SOURCE_HASH,'https://fixture.invalid/api/v2/payment/orders')
        record=service_record(details,'1',KEY)
        with self.engine.begin() as connection:connection.execute(text("INSERT INTO pos_rewrite_screening_origin_services(id,data,proof_hash,revoked) VALUES('csk',:data,:proof,0)"),{'data':canonical(record['data']),'proof':record['proofHash']})
        import datetime as datetime_module
        converter=next(node for node in ast.parse((SOURCE/'libs/db.py').read_bytes()).body if isinstance(node,ast.FunctionDef) and node.name=='dateConvertor')
        converters={'datetime':datetime_module}
        exec(compile(ast.Module(body=[converter],type_ignores=[]),'<pinned-source-json-date>','exec'),converters)
        module('libs.db',converters)
        def history_head(session,customer,lock=False):
            native=self.head(session,customer,lock)
            return {'contract':'pos-screening-origin-history-head-v1','sourceSchema':self.schema,'sourceServerUuid':native['origin']['serverUuid'],'revision':native['revision'],'writersHash':native['writersHash']}
        self.patches.enter_context(patch('origin_history.head',history_head))
        def history(command,head):
            if self.leased or CURRENT.get() is not None:raise AssertionError('CSK history retained SQL')
            self.provider_calls+=1;now=self.now()
            body={'contract':'pos-screening-origin-history-v1','commandId':command['id'],'customerId':command['customerId'],
                'requestHash':command['requestHash'],'cartHash':command['cartHash'],'witness':head,'generationId':'1'*64,'sourceCompleteThrough':now,
                'reader':'bigquery','complete':True,'welcomeCount':'0','appCashbackCount':'0','webCashbackCount':'0','fetchedAt':now,'expiresAt':now+30000}
            return {**body,'signature':digest(KEY,'history',body)}
        self.owner.history_provider=SimpleNamespace(read=history)
        return self.system_owner
    def close(self):
        self.patches.close();self.engine.dispose()
        admin=create_engine(self.engine.url.set(database='mysql'),hide_parameters=True)
        with admin.begin() as connection:connection.execute(text('DROP DATABASE `'+self.schema+'`'))
        admin.dispose()
