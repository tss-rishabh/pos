"""Execute actual pinned POS cart/validation/order and producer functions.

This is a separate private worker, never an extension of the public cashier
cart. The source database scoped sessions are replaced before importing source
controllers. No normal MySQLCart.instantiate/save/clear path is called.
"""
import ast
import copy
import hashlib
import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace,ModuleType

from effects import CAPTURE, Tasks
from protocol import ImportReview, source_custom_data
from transaction import PrivateSessionProxy
from transaction import CURRENT
from contextvars import ContextVar
from profiles import assert_plain_profile
from membership_profile import MembershipProfile, selected as membership_selected, compile_writers, compile_order, compile_free_membership
from cart_preparation import automatic_membership,catalog_build,guard_history,read_only_preview,preview_effect

UNSAFE_HTTP=ContextVar('pos_import_unsafe_http',default=False)
SOURCE_REDIS_ALIASES=('redis_object','redis_pos_object','redis_catalogue_object','cms_redis_object',
                      'user_redis_object','blacklist_redis_object','redis_buffer_object','payment_redis_object')


def prohibit_source_http(*_args,**_kwargs):
    UNSAFE_HTTP.set(True)
    raise ImportReview('ORDER_IMPORT_HTTP_EFFECT_UNQUALIFIED')

PINS={
 'database/__init__.py':'9b066628cd3e7e28e9337f9daa883b3e8d763292be2d47b1d8b869d06cd03fe3',
 'database/database.py':'328a8519f8a7d37f2374e57ead0ea7dbe074ef6a056f981ca51befb2ba9348f0',
 'database/WriteDbConn.py':'e5da9b24e91a4eaf202d73a4c069b796b4e387eedeae1cab057497a7ca4625d1',
 'controllers/OrderController.py':'821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad',
 'middleware/CartMiddleware.py':'e7db74af2d1e2c3582fd0d56b6eac0e95cd4f78e7987950a9fd91c10162aa6ed',
 'controllers/CartController.py':'22604e22405c778f9fd756fb277f8bd0d026ccbd29d4eca84363427f48403072',
 'models/Order.py':'d9ee1cd52546e9d8dce0952e901ecba0d58fe1c1b68d95149781131e1553fca5',
 'libs/OrderHelper.py':'a3ec2d593ddfb990b6462fe4f71a8c70f5aa7b95a6704ffb4a0566b14e515e46',
 'controllers/CheckoutController.py':'f4b240f5a84683f41eeb819f52dfad4cf8f7a1a129c25708d2d26a3b849a6b40',
 'controllers/CatalogController.py':'5dcf3d5db2d1bea2001b0e1d8349b02725b11482e831a7355b6eaaf343de400e',
 'controllers/KinesisProducer.py':'18a7c4dd7ce2858b95869655122c78d2559337d490aef20809c803bd2caf6b1d',
 'main.py':'9ff6d13111aad06f29159768b631fc4757f7ad6a0a21dd229303c5afa78b9bc7',
}


class SilentLogger:
    def __getattr__(self,_name):
        return lambda *_args,**_kwargs: None


class ReadOnlyCache:
    def __init__(self,source):
        self.source=source

    def __getattr__(self,name):
        if name in {'get','exists','hget','hgetall','mget','hmget','smembers','sismember','ttl','type','lrange','zrange'}:
            return getattr(self.source,name)
        # Warming/invalidation is irrelevant to this nonpersisted private cart.
        # Never delete or overwrite a cashier/customer cache key.
        return lambda *_args,**_kwargs: False


def checked_source(root,path):
    value=(Path(root)/path).read_bytes()
    if path in PINS and hashlib.sha256(value).hexdigest()!=PINS[path]:
        raise ImportReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    return value.decode('utf-8')


class PrivateSourceEngine:
    """Original engine aliases must never create an independent connection."""
    def __getattr__(self,_name):
        raise ImportReview('ORDER_IMPORT_PRIVATE_SCOPE_REQUIRED') from None


def bind_source_sessions(root,proxy):
    """Bootstrap actual pinned database exports before controller imports.

    The source has no database.ReadDbConn module. Importing its real database
    modules first would also construct legacy engines and leave captured aliases
    behind. Only their SQL constructors are substituted; no URI expression or
    original SQLAlchemy engine/session factory is evaluated.
    """
    root=Path(root).resolve()
    definitions=(
        ('database','database/__init__.py',{'create_engine':2,'sessionmaker':2,'scoped_session':2},()),
        ('database.database','database/database.py',{'create_engine':3,'sessionmaker':4,'scoped_session':4},
         ('Session','SessionR','SessionC','SessionReadCMS')),
        ('database.WriteDbConn','database/WriteDbConn.py',{'create_engine':1,'sessionmaker':1,'scoped_session':1},('Session',)),
    )
    trees=[]
    for name,path,counts,exports in definitions:
        tree=ast.parse(checked_source(root,path))
        found={key:sum(isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id==key for node in ast.walk(tree)) for key in counts}
        class Controlled(ast.NodeTransformer):
            def visit_ImportFrom(self,node):
                if node.module=='sqlalchemy':
                    node.names=[alias for alias in node.names if alias.name!='create_engine']
                elif node.module=='sqlalchemy.orm':
                    node.names=[alias for alias in node.names if alias.name not in ('sessionmaker','scoped_session')]
                return node if node.names else None
            def visit_Call(self,node):
                if isinstance(node.func,ast.Name) and node.func.id in counts:
                    # Drop the arguments too: original credential-bearing URI
                    # formatting is not needed for the owned writer Session.
                    return ast.copy_location(ast.Call(func=ast.Name(id='_private_'+node.func.id,ctx=ast.Load()),args=[],keywords=[]),node)
                return self.generic_visit(node)
        tree=Controlled().visit(tree)
        if found!=counts:
            raise ImportReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
        existing=sys.modules.get(name)
        if existing is not None and getattr(existing,'__pos_private_source_sessions__',None)!=str(root):
            # Already-imported controller aliases cannot be made safe merely
            # by overwriting the originating module's attributes afterward.
            raise ImportReview('ORDER_IMPORT_PRIVATE_SCOPE_REQUIRED')
        trees.append((name,path,ast.fix_missing_locations(tree),exports))
    engine=PrivateSourceEngine()
    def factory(*_args,**_kwargs):return proxy.current()
    for name,path,tree,exports in trees:
        existing=sys.modules.get(name)
        if existing is not None:
            for alias in exports:setattr(existing,alias,proxy)
            continue
        module=ModuleType(name)
        module.__file__=str(root/path)
        module.__package__=name if name=='database' else 'database'
        if name=='database':module.__path__=[str(root/'database')]
        module.__pos_private_source_sessions__=str(root)
        module.__dict__.update(_private_create_engine=lambda:engine,
                               _private_sessionmaker=lambda:factory,
                               _private_scoped_session=lambda:proxy)
        # Publish safe aliases before source settings/import cycles can see
        # this module. Only the reviewed source declarations may replace them.
        for alias in exports:setattr(module,alias,proxy)
        sys.modules[name]=module
        if name!='database':setattr(sys.modules['database'],name.rsplit('.',1)[1],module)
        try:
            exec(compile(tree,str(root/path),'exec'),module.__dict__)
            if any(getattr(module,alias,None) is not proxy for alias in exports):
                raise ImportReview('ORDER_IMPORT_PRIVATE_SCOPE_REQUIRED')
        except Exception:
            sys.modules.pop(name,None)
            if name!='database' and 'database' in sys.modules:
                sys.modules['database'].__dict__.pop(name.rsplit('.',1)[1],None)
            raise ImportReview('ORDER_IMPORT_SOURCE_UNAVAILABLE') from None


def compile_class(root,path,name,namespace):
    tree=ast.parse(checked_source(root,path))
    target=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name==name)
    target=copy.deepcopy(target)
    for node in target.body:
        if isinstance(node,ast.FunctionDef):
            node.decorator_list=[]
    exec(compile(ast.Module(body=[target],type_ignores=[]),'<pinned-private-'+name+'>','exec'),namespace)
    return namespace[name]


class SourceRuntime:
    def __init__(self,source_root,runtime_root):
        self.source_root=Path(source_root)
        if self.source_root.resolve()!=Path(runtime_root).resolve():
            raise ImportReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
        for filename in PINS:
            checked_source(source_root,filename)
        sys.path.insert(0,str(Path(runtime_root)))
        # Separate private process only. All financial HTTP belongs to the
        # Node stage coordinator; a caught legacy network failure still taints
        # this transaction and cannot produce a no-effects success receipt.
        import requests
        requests.sessions.Session.request=prohibit_source_http
        proxy=PrivateSessionProxy()
        bind_source_sessions(source_root,proxy)
        modules={name:importlib.import_module(name) for name in (
            'controllers.OrderController','controllers.CheckoutController','controllers.CartController',
            'controllers.CatalogController','middleware.CartMiddleware','controllers.KinesisProducer')}
        from model_compat import install_model_codec
        models=importlib.import_module('models.Order')
        install_model_codec(models.OrderModel,models.OrderStoreModel,models.HasProductModel)
        self.tasks=importlib.import_module('tasks')
        self.settings=importlib.import_module('settings')
        self.item_types=importlib.import_module('controllers.cart.Cart').ItemTypes
        # Private worker only: imported source functions may emit legacy debug
        # logs or analytics; these cannot become request/body/customer logs.
        for name,module in tuple(sys.modules.items()):
            if module is None or not getattr(module,'__file__',None):
                continue
            try:
                inside=Path(module.__file__).resolve().is_relative_to(Path(runtime_root).resolve())
            except (OSError,ValueError):
                inside=False
            if not inside:
                continue
            if hasattr(module,'logger'):
                module.logger=SilentLogger()
            if hasattr(module,'tasks'):
                module.tasks=Tasks()
            for attr in SOURCE_REDIS_ALIASES:
                if hasattr(module,attr):
                    setattr(module,attr,ReadOnlyCache(getattr(module,attr)))
            if hasattr(module,'push_cart_event'):
                module.push_cart_event=lambda *_a,**_k: None
            for attr in ('push_process_order_event','push_after_payment_event'):
                if hasattr(module,attr):setattr(module,attr,preview_effect(getattr(module,attr)))
        order_globals=dict(vars(modules['controllers.OrderController']))
        order_globals.update(logger=SilentLogger(),tasks=Tasks())
        # Select the approved per-HP refund function from the deployed composed
        # controller; its exact two-statement patch is checked by prepare.py.
        sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'offline-cash-pricing'))
        from source_refunds import refund_tree, CORRECTED_CONTROLLER_SHA256
        refund_path,refund_ast=refund_tree(source_root,'pos-refund-per-hp-v1')
        allocation=next(node for node in refund_ast.body if isinstance(node,ast.FunctionDef) and node.name=='amount_to_be_refunded_calculation')
        exec(compile(ast.Module(body=[allocation],type_ignores=[]),str(refund_path),'exec'),order_globals)
        self.membership=MembershipProfile(source_root,self.settings) if membership_selected() else None
        if self.membership:
            dal=importlib.import_module('controllers.user.userDal')
            writers=compile_writers(source_root,dict(vars(dal)),self.membership.adapter)
            for name in ('set_exclusive_user','set_exclusive_upgrade_user'):
                order_globals[name]=writers[name]
            self.order=compile_order(source_root,order_globals,self.membership.adapter)
        else:
            self.order=compile_class(source_root,'controllers/OrderController.py','PosOrder',order_globals)()
        self.process=compile_class(source_root,'controllers/OrderController.py','ProcessingOrder',dict(order_globals))()
        self.validate=compile_class(source_root,'controllers/CheckoutController.py','ValidateCheckout',dict(vars(modules['controllers.CheckoutController'])))()
        cart_namespace=dict(vars(modules['controllers.CartController']))
        cart_module=importlib.import_module('controllers.cart.Cart')
        self.source_clock=cart_module.datetime
        if self.membership:
            cart_namespace['AddFreeMembership']=compile_free_membership(source_root,dict(vars(cart_module)))
        cart_namespace['AddFreeMembership']=automatic_membership(cart_namespace['AddFreeMembership'])
        self.cart_reader=compile_class(source_root,'controllers/CartController.py','Cart',cart_namespace)()
        # PosProductDetail auto-add calls an imported Cart alias. Bind that
        # alias to the same isolated qualified Cart, including on intermediate
        # product additions; the original alias would bypass history admission.
        catalog_namespace=dict(vars(modules['controllers.CatalogController']))
        catalog_namespace['Cart']=lambda:self.cart_reader
        self.product=compile_class(source_root,'controllers/CatalogController.py','PosProductDetail',catalog_namespace)()
        self.cart_factory=modules['middleware.CartMiddleware'].PosCartFactory
        self.pricelist_manager=modules['middleware.CartMiddleware'].PricelistManager
        namespace=dict(vars(modules['controllers.KinesisProducer']))
        namespace['tasks']=Tasks()
        self.producer=compile_class(source_root,'controllers/KinesisProducer.py','SyncOrderById',namespace)()
        self.controller_hash=CORRECTED_CONTROLLER_SHA256

    def membership_execution_point(self):
        # Exact source Cart.py clock. Only sampled if literal history criteria
        # is reached; its wall-clock zone must match accepted configuration.
        return self.source_clock.now()

    def order_pipeline(self,session,user,plan,capability):
        if self.membership:
            with self.membership.scope(session,user,plan,capability) as state:
                order_id,cart=self._order_pipeline(session,user,plan,capability)
                self.membership.capture(session,order_id,cart,state)
                return order_id,cart
        return self._order_pipeline(session,user,plan,capability)

    def _order_pipeline(self,session,user,plan,capability):
        req,resp,cart,base=self._cart_pipeline(session,user,plan,capability)
        calc=cart.get_item(self.item_types.META,{'name':'calculations'})
        # The selected profile must prove original membership staging and any
        # explicit source-added rows. Shopify remains method15/pending.
        assert_plain_profile(cart,self.item_types,self.settings,plan,calc)
        req.context['data']={**base,'payment_method':'coc' if plan['kind']=='offline' else 'shopify',
            'id':14 if plan['kind']=='offline' else 15,'custom_created_at':plan['createdAt']}
        self.order.on_post(req,resp)
        if UNSAFE_HTTP.get():
            raise ImportReview('ORDER_IMPORT_HTTP_EFFECT_UNQUALIFIED')
        result=json.loads(resp.body)
        if result.get('isValid') is not True or result.get('method')!=(14 if plan['kind']=='offline' else 15):
            raise ImportReview('ORDER_IMPORT_SOURCE_ORDER_UNCONFIRMED')
        return str(result['order']),cart

    def preparation_pipeline(self,session,user,plan,capability):
        # Literal catalog/cart/validation/calculator only. The receiver owns
        # rollback even when old code calls nested Session.commit().
        with read_only_preview():
            if self.membership:
                with self.membership.scope(session,user,plan,capability):
                    self._cart_pipeline(session,user,plan,capability)
            else:
                self._cart_pipeline(session,user,plan,capability)
        if UNSAFE_HTTP.get():
            raise ImportReview('ORDER_IMPORT_HTTP_EFFECT_UNQUALIFIED')

    def _cart_pipeline(self,session,user,plan,capability):
        with guard_history(session) as current:
            return self._cart_body(current,user,plan,capability)

    def _cart_body(self,session,user,plan,capability):
        UNSAFE_HTTP.set(False)
        req=SimpleNamespace(params={},path='/internal/pos/legacy-order-imports',method='POST',
            context={'session':session,'session_r':session,'user':user,'active_cart':None,
                     'pos_rewrite_fresh_customer':{'subject':str(user['user_id']),'loaded':True}},
            get_header=lambda *_args,**_kwargs:None,headers={},access_route=[],remote_addr=None,user_agent=None,
            uri='/internal/pos/legacy-order-imports',url='/internal/pos/legacy-order-imports',referer=None)
        resp=SimpleNamespace(status='200 OK',body='',text='',set_header=lambda *_args:None)
        cart=self.cart_factory.empty_cart(is_pos=True)
        cart.context=req.context
        req.context['cart']=cart
        custom=source_custom_data(plan)
        base={'is_pos':True,'store_id':int(capability['scope']['storeId']),
              'counter_id':int(capability['scope']['counterId']),'admin_user_id':int(capability['scope']['actorId']),
              'custom_data':custom,'tabId':capability['namespace'],'end_user':False}
        req.context.update(data=base,is_pos=True,store_id=int(capability['scope']['storeId']))
        req.context['pricelist_manager']=self.pricelist_manager(req.context)
        with catalog_build(capability):
            for line in plan['lines']:
                barcode=session.execute('SELECT gtin FROM products_gs1 WHERE product_id=:id ORDER BY id LIMIT 2',{'id':int(line['productId'])}).fetchall()
                if len(barcode)!=1:
                    raise ImportReview('ORDER_IMPORT_BARCODE_REVIEW')
                for _ in range(line['quantity']):
                    req.context['data']={**base,'barcode':barcode[0][0],'auto_add_to_cart':1}
                    self.product.on_post(req,resp)
                    if not str(resp.status).startswith('200'):
                        raise ImportReview('ORDER_IMPORT_SOURCE_CART_REJECTED')
        req.context['data']={**base,'payload':{'operation':'get'}}
        serialized=self.cart_reader.on_post(req,resp)
        if not isinstance(serialized,str) or not isinstance(json.loads(serialized),dict):
            raise ImportReview('ORDER_IMPORT_SOURCE_CART_REJECTED')
        req.context['data']=dict(base)
        self.validate.on_post(req,resp)
        self.process.on_post(req,resp)
        if UNSAFE_HTTP.get():
            raise ImportReview('ORDER_IMPORT_HTTP_EFFECT_UNQUALIFIED')
        return req,resp,cart,base

    def publication_intents(self,order_id):
        calls=[]
        token=CAPTURE.set(calls)
        try:
            self.producer.on_post(SimpleNamespace(context={'data':{'payload':int(order_id)}}),SimpleNamespace(text=''))
        finally:
            CAPTURE.reset(token)
        return calls
