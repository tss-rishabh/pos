"""Additive installation after the existing public source bootstrap.

Root composes the generated entry; this module does not edit source siblings,
start a worker, connect to a database, or enable any flag in its constructor.
"""
import functools
import importlib
import os
import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from sqlalchemy import event
from origin_contracts import CONTRACT,OriginReview,digest,fail,unsafe
from origin_frame import (CURRENT_ORIGIN,OriginRuntime,Frame,after_original_auth,after_order_insert,install)
from origin_resource import OriginCommands,OriginClose
from origin_effects import ACTIVE as EFFECTS,Tasks,Task,Cache
from source_runtime import SilentLogger,SOURCE_REDIS_ALIASES
from transaction import CURRENT,PrivateSessionProxy,guard_private_commit,guard_private_statement,normalize_source_sentinels


def options(environment):
    selected=environment.get('POS_SCREENING_ORIGIN_CONTRACT')
    if not selected:return None
    if selected!=CONTRACT:fail('SCREENING_ORIGIN_UNAVAILABLE')
    key=environment.get('POS_SCREENING_ORIGIN_PROOF_KEY','')
    digest(key,'ready',None)
    others=[environment.get(name) for name in (
        'POS_LEGACY_IMPORT_PROOF_KEY','POS_PUBLIC_SCREENING_NEGATIVE_KEY','POS_MEMBERSHIP_PROOF_KEY',
        'TSS_POS_CUSTOMER_CONTEXT_KEY','POS_LEGACY_IMPORT_KEY','POS_PUBLIC_SCREENING_PUBLICATION_KEY',
        'POS_SCREENING_ORIGIN_HISTORY_CAPTURE_KEY','POS_SCREENING_ORIGIN_HISTORY_PUBLICATION_KEY',
    ) if environment.get(name)]
    if key in others:fail('SCREENING_ORIGIN_KEY_REQUIRED')
    return {'contract':selected,'key':key}


def current_source():
    frame=CURRENT_ORIGIN.get()
    if frame is None:return None
    if CURRENT.get() is not None:return PrivateSessionProxy().current()
    return frame.source


def patch_public_routes():
    """Extend the installed routers, including already captured controller aliases.
    Inactive customer-origin calls delegate to the unchanged public Node frame.
    """
    import source_frame
    if getattr(source_frame,'_origin_routed',False):return
    old_call=source_frame.RoutedSession.__call__;old_get=source_frame.RoutedSession.__getattr__
    def call(instance,*args,**kwargs):
        source=current_source()
        if source is None:return old_call(instance,*args,**kwargs)
        if args or kwargs:fail('SCREENING_ORIGIN_SQL_UNQUALIFIED')
        return source
    def get(instance,name):
        source=current_source()
        return old_get(instance,name) if source is None else getattr(source,name)
    source_frame.RoutedSession.__call__=call;source_frame.RoutedSession.__getattr__=get
    old_cache=source_frame.RoutedCache.__getattr__
    def cached(instance,name):
        frame=CURRENT_ORIGIN.get()
        if frame is None or EFFECTS.get() is None:return old_cache(instance,name)
        return getattr(Cache(instance.original,instance.__dict__.get('origin_alias')),name)
    source_frame.RoutedCache.__getattr__=cached
    old_tasks=source_frame.RoutedTasks.__getattr__
    source_frame.RoutedTasks.__getattr__=lambda instance,name:getattr(Tasks(),name) if EFFECTS.get() is not None else old_tasks(instance,name)
    old_log=source_frame.RoutedLogger.__getattr__
    source_frame.RoutedLogger.__getattr__=lambda instance,name:getattr(SilentLogger(),name) if CURRENT_ORIGIN.get() is not None else old_log(instance,name)
    # Public source controller hook is captured as an alias by bootstrap.
    # Choose the genuine current origin; never fill FRAME with a fake POS cap.
    import bootstrap
    original_validate=bootstrap.frame_after_validate
    def validated(req):
        frame=CURRENT_ORIGIN.get()
        if frame is not None:
            if not frame.admitted:frame.admit(req)
            return
        return original_validate(req)
    bootstrap.frame_after_validate=validated
    source_frame._origin_routed=True


class OriginBootstrap:
    def __init__(self,environment=None):
        self.environment=os.environ if environment is None else environment
        self.options=options(self.environment)
        self.runtime=None
        self.system=None
    def activate(self,public_bootstrap,namespace,history_provider=None):
        if self.options is None:return self
        if public_bootstrap.middleware is None:fail('SCREENING_ORIGIN_UNAVAILABLE')
        if history_provider is None and self.environment.get('POS_SCREENING_ORIGIN_HISTORY_BRIDGE_URL'):
            from origin_history_http import History
            history_provider=History(self.environment['POS_SCREENING_ORIGIN_HISTORY_BRIDGE_URL'],self.options['key'],lambda:int(time.time()*1000))
        self.runtime=OriginRuntime(public_bootstrap.sessions,self.options['key'],self.environment.get('POS_LEGACY_IMPORT_PROOF_KEY',''),
                                   bool(namespace['settings'].IS_LINE_ITEM_ENABLED),lambda:int(time.time()*1000),history_provider)
        if self.options['key'] in (namespace['settings'].SECRET_KEY,getattr(namespace['settings'],'SECRET_KEY_512',None)):fail('SCREENING_ORIGIN_KEY_REQUIRED')
        for name in ('EXCLUSIVE_PRODUCT','EXCLUSIVE_UPGRADE_PRODUCT'):
            configured=getattr(namespace['settings'],name,{})
            if isinstance(configured,dict):self.runtime.member_product_ids.update(str(value) for value in configured if str(value).isdigit())
        asset_contract=self.environment.get('POS_SCREENING_ORIGIN_ASSET_CONTRACT')
        if asset_contract:
            from origin_assets import OriginAssets
            self.runtime.assets=OriginAssets(namespace['settings'],self.options['key'],asset_contract)
            original_gift=namespace['build_gift_voucher_model']
            @functools.wraps(original_gift)
            def gift(*args,**kwargs):return self.runtime.assets.construct(original_gift,*args,**kwargs)
            namespace['build_gift_voucher_model']=gift
        install(self.runtime);patch_public_routes()
        bind=public_bootstrap.sessions.kw['bind']
        # Both are physical-engine events. RELEASE SAVEPOINT remains legal.
        if not event.contains(bind,'commit',guard_private_commit):event.listen(bind,'commit',guard_private_commit)
        if not event.contains(bind,'before_cursor_execute',guard_private_statement):event.listen(bind,'before_cursor_execute',guard_private_statement)
        def inserted(session,_context):
            frame=CURRENT_ORIGIN.get()
            if frame is None or session is not frame.session:return
            for model in list(session.new):
                if getattr(model,'__tablename__',None)=='orders' and getattr(model,'id',None) is not None:
                    if frame.order_id is None:after_order_insert(model)
                    elif str(model.id)!=frame.order_id:fail('SCREENING_ORIGIN_DUPLICATE_ORDER')
        event.listen(public_bootstrap.sessions.class_,'after_flush',inserted)
        for owner_name,kind in (('Order','customer'),('PosOrder','pos')):
            owner=namespace[owner_name]
            # Run the actual source auth_required first, including its original
            # native identity check, then enter the origin-owned transaction.
            original=owner.on_post
            wrapped=after_original_auth(kind)(original)
            @functools.wraps(original)
            def authenticated(resource,req,resp,*args,_method=wrapped,**kwargs):
                from utils.hooks import auth_required
                from screening_counter import CounterReadRefused
                try:
                    auth_required(req,resp,resource)
                    return _method(resource,req,resp,*args,**kwargs)
                except CounterReadRefused:static_error(OriginReview('SCREENING_ORIGIN_COUNTER_REQUIRED'))
                except Exception as error:
                    if isinstance(error,OriginReview):static_error(error)
                    # No exception/SQL/body crosses the selected-origin boundary.
                    if req.get_header('X-TSS-Screening-Command'):static_error(OriginReview())
                    raise
            owner.on_post=authenticated
        cart=importlib.import_module('controllers.CartController').Cart
        cart.on_post=after_original_auth('cart')(cart.on_post)
        # Standalone imported task symbols bypass a module-level tasks router.
        for module in tuple(sys.modules.values()):
            filename=getattr(module,'__file__',None)
            if not filename:continue
            try:inside=Path(filename).resolve().is_relative_to(public_bootstrap.root)
            except (ValueError,OSError):inside=False
            if not inside:continue
            for alias in SOURCE_REDIS_ALIASES:
                value=getattr(module,alias,None)
                if hasattr(value,'original'):value.origin_alias=alias
            task=getattr(module,'update_customer_support_flagging_task',None)
            if task is not None:
                class RoutedTask:
                    def __init__(self,original):self.original=original
                    def __getattr__(self,name):return getattr(Task('update_customer_support_flagging_task') if EFFECTS.get() is not None else self.original,name)
                    def __call__(self,*args,**kwargs):return (Task('update_customer_support_flagging_task') if EFFECTS.get() is not None else self.original)(*args,**kwargs)
                module.update_customer_support_flagging_task=RoutedTask(task)
        import requests
        original_request=requests.sessions.Session.request
        def request(instance,*args,**kwargs):
            if CURRENT_ORIGIN.get() is not None and CURRENT.get() is not None:
                unsafe('SCREENING_ORIGIN_HTTP_UNQUALIFIED')
            return original_request(instance,*args,**kwargs)
        requests.sessions.Session.request=request
        external=importlib.import_module('controllers.external.OrderPlacement')
        original_system=external.OrderPlacement.on_post
        original_placement=external.place_order
        def is_ticket(data):
            lines=data.get('order',{}).get('line_items',[]) if isinstance(data,dict) else []
            return any(isinstance(line,dict) and str(line.get('sku_id'))=='390238' for line in lines)
        def guarded_system(resource,req,resp,api_key=None):
            if is_ticket(req.context.get('data') or {}):fail('SCREENING_ORIGIN_USE_HEADER_RESOURCE')
            return original_system(resource,req,resp,api_key)
        def guarded_old_job(req,resp,payload,details):
            if is_ticket(payload):fail('SCREENING_ORIGIN_USE_HEADER_RESOURCE')
            return original_placement(req,resp,payload,details)
        external.OrderPlacement.on_post=guarded_system;external.place_order=guarded_old_job
        system_contract=self.environment.get('POS_SCREENING_ORIGIN_SYSTEM_CONTRACT')
        if system_contract:
            if system_contract!='pos-screening-origin-system-v1':fail('SCREENING_ORIGIN_SERVICE_UNQUALIFIED')
            from origin_system import SystemOrders,SOURCE_HASH,UTILS_HASH
            import hashlib
            external=importlib.import_module('controllers.external.OrderPlacement')
            utility=public_bootstrap.root/'controllers/external/external_api_utils.py'
            if hashlib.sha256(utility.read_bytes()).hexdigest()!=UTILS_HASH:fail('SCREENING_ORIGIN_SOURCE_UNVERIFIED')
            self.system=SystemOrders(self.runtime,vars(external),public_bootstrap.root/'controllers/external/OrderPlacement.py',SOURCE_HASH,
                                     namespace['settings'].PAYMENT_URL+'orders')
        return self
    def register(self,app,settings):
        if self.runtime is None:return
        resource=OriginCommands(self.runtime)
        path=settings.API_PREFIX+'/screening-commands'
        app.add_route(path,resource);app.add_route(path+'/{command_id}',resource)
        app.add_route(path+'/{command_id}/close',OriginClose(resource))
        if self.system is not None:
            from origin_system import SystemClose
            system_path=settings.API_PREFIX+'/external/screening-orders'
            app.add_route(system_path,self.system);app.add_route(system_path+'/{command_id}',self.system)
            app.add_route(system_path+'/{command_id}/close',SystemClose(self.system))


def static_error(error):
    import falcon
    code=error.code if isinstance(error,OriginReview) else 'SCREENING_ORIGIN_RECONCILIATION_REQUIRED'
    raise falcon.HTTPConflict(title=code,description='Keep the original command reference and check its outcome before placing another order.') from None
