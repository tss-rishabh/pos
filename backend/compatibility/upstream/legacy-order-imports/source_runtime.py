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
from types import SimpleNamespace

from effects import CAPTURE, Tasks
from protocol import ImportReview, source_custom_data
from transaction import PrivateSessionProxy
from transaction import CURRENT
from contextvars import ContextVar
from profiles import assert_plain_profile

UNSAFE_HTTP=ContextVar('pos_import_unsafe_http',default=False)


def prohibit_source_http(*_args,**_kwargs):
    UNSAFE_HTTP.set(True)
    raise ImportReview('ORDER_IMPORT_HTTP_EFFECT_UNQUALIFIED')

PINS={
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
        for name in ('database.database','database.WriteDbConn','database.ReadDbConn'):
            module=importlib.import_module(name)
            for attr in ('Session','SessionR','SessionC','SessionReadCMS'):
                if hasattr(module,attr):
                    setattr(module,attr,proxy)
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
            for attr in ('redis_object','redis_pos_object','redis_catalogue_object','cms_redis_object','user_redis_object'):
                if hasattr(module,attr):
                    setattr(module,attr,ReadOnlyCache(getattr(module,attr)))
            if hasattr(module,'push_cart_event'):
                module.push_cart_event=lambda *_a,**_k: None
        order_globals=dict(vars(modules['controllers.OrderController']))
        order_globals.update(logger=SilentLogger(),tasks=Tasks())
        # Select the approved per-HP refund function from the deployed composed
        # controller; its exact two-statement patch is checked by prepare.py.
        sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'offline-cash-pricing'))
        from source_refunds import refund_tree, CORRECTED_CONTROLLER_SHA256
        refund_path,refund_ast=refund_tree(source_root,'pos-refund-per-hp-v1')
        allocation=next(node for node in refund_ast.body if isinstance(node,ast.FunctionDef) and node.name=='amount_to_be_refunded_calculation')
        exec(compile(ast.Module(body=[allocation],type_ignores=[]),str(refund_path),'exec'),order_globals)
        self.order=compile_class(source_root,'controllers/OrderController.py','PosOrder',order_globals)()
        self.process=compile_class(source_root,'controllers/OrderController.py','ProcessingOrder',dict(order_globals))()
        self.validate=compile_class(source_root,'controllers/CheckoutController.py','ValidateCheckout',dict(vars(modules['controllers.CheckoutController'])))()
        self.product=modules['controllers.CatalogController'].PosProductDetail()
        self.cart_reader=modules['controllers.CartController'].Cart()
        self.cart_factory=modules['middleware.CartMiddleware'].PosCartFactory
        self.pricelist_manager=modules['middleware.CartMiddleware'].PricelistManager
        namespace=dict(vars(modules['controllers.KinesisProducer']))
        namespace['tasks']=Tasks()
        self.producer=compile_class(source_root,'controllers/KinesisProducer.py','SyncOrderById',namespace)()
        self.controller_hash=CORRECTED_CONTROLLER_SHA256

    def order_pipeline(self,session,user,plan,capability):
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
        calc=cart.get_item(self.item_types.META,{'name':'calculations'})
        # Membership producer activation is ordinary-method-specific. Shopify
        # membership requires a separate qualified source profile, not guessed
        # before-state provenance or a method15→14 substitution.
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

    def publication_intents(self,order_id):
        calls=[]
        token=CAPTURE.set(calls)
        try:
            self.producer.on_post(SimpleNamespace(context={'data':{'payload':int(order_id)}}),SimpleNamespace(text=''))
        finally:
            CAPTURE.reset(token)
        return calls
