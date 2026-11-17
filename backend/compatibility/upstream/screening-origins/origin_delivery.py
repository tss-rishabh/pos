"""Executable origin postcommit ports and selected original task capture.

The original tasks/canvas are retained. Broker acceptance and an invocation of
an original task body are separate facts; neither is a new payment proof.
"""
import base64
import copy
import hashlib
import importlib
import json
import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from sqlalchemy import text
from origin_contracts import canonical,digest,fail
from origin_effects import TASKS,ACTIVE,append
from native import one,rows,json_value

CONTRACT='pos-screening-origin-effects-v1'
PREPARED=None


def prepare(main_file,environment=None):
    """Run before original controller/task import; no broker network calls."""
    global PREPARED
    env=os.environ if environment is None else environment
    if not env.get('POS_SCREENING_ORIGIN_CONTRACT'):return
    if env.get('POS_SCREENING_ORIGIN_EFFECTS_CONTRACT')!=CONTRACT:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
    root=Path(main_file).resolve().parent
    if PREPARED is not None:
        if PREPARED[0]!=root:fail('SCREENING_ORIGIN_SOURCE_UNVERIFIED')
        return
    from private_celery import bind
    celery,options=bind(root,env)
    PREPARED=(root,celery,options)


def install_capture(root,modules):
    """Only selected origin calls use the existing literal FastQueue reducer."""
    from cart_tracking import compile_helper
    import cart_tracking
    from source_runtime import SilentLogger
    from origin_frame import CURRENT_ORIGIN
    if PREPARED is None:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
    settings=importlib.import_module('settings')
    captured=compile_helper(root,settings,PREPARED[2]['queues'],SilentLogger())
    original_collect=cart_tracking.collector_record
    def collect(intent):
        if ACTIVE.get() is None:return original_collect(intent)
        if set(intent)!={'call'}:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
        return append({'kind':'task','call':intent['call']})
    cart_tracking.collector_record=collect
    for module in modules:
        filename=getattr(module,'__file__',None)
        if not filename:continue
        try:inside=Path(filename).resolve().is_relative_to(Path(root).resolve())
        except (OSError,ValueError):inside=False
        if not inside:continue
        for name in ('push_process_order_event','push_after_payment_event'):
            original=getattr(module,name,None)
            if not callable(original):continue
            def routed(*args,_original=original,_captured=captured[name],**kwargs):
                if ACTIVE.get() is None:return _original(*args,**kwargs)
                return _captured(*args,**kwargs)
            setattr(module,name,routed)
        original=getattr(module,'push_cart_event',None)
        if callable(original):
            def cart_event(*args,_original=original,**kwargs):
                if ACTIVE.get() is None:return _original(*args,**kwargs)
                append({'kind':'cart-tracking','args':list(args),'kwargs':kwargs,'recordedAt':CURRENT_ORIGIN.get().owner.clock()})
                return None
            cart_event.__screening_original__=original
            module.push_cart_event=cart_event


class FlushOnly:
    def __init__(self,session):self.session=session
    def execute(self,statement,*args,**kwargs):
        from transaction import LegacyResult
        return LegacyResult(self.session.execute(text(statement) if isinstance(statement,str) else statement,*args,**kwargs))
    def commit(self):self.session.flush()
    def rollback(self):fail('SCREENING_ORIGIN_CART_RECONCILIATION_REQUIRED')
    def close(self):fail('SCREENING_ORIGIN_CART_RECONCILIATION_REQUIRED')
    def __getattr__(self,name):return getattr(self.session,name)


class OriginEffectRegistry:
    def __init__(self,owner,namespace):
        if PREPARED is None:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
        self.owner,self.namespace=owner,namespace
        from private_celery import TaskRegistry
        self.original_tasks=importlib.import_module('tasks')
        self.fast_queue=importlib.import_module('fast_queue')
        self.tasks=TaskRegistry(self.original_tasks,self.fast_queue.process_abandon_cart_data,PREPARED[2])
        self.tasks.assert_ready()
        self.caches={}
        from source_runtime import SOURCE_REDIS_ALIASES
        for module in tuple(__import__('sys').modules.values()):
            if getattr(module,'__name__','') not in ('database.database','database.WriteDbConn'):continue
            for alias in SOURCE_REDIS_ALIASES:
                value=getattr(module,alias,None)
                if value is not None:self.caches[alias]=getattr(value,'original',value)
    def task(self,name):
        if name not in TASKS:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
        value=getattr(self.tasks,name,None)
        if value is None and name=='update_customer_support_flagging_task':value=self.namespace.get(name)
        if value is not None:value=getattr(value,'__dict__',{}).get('original',value)
        if value is None or not callable(getattr(value,'apply_async',None)):fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
        return value
    def publish(self,effect,effect_id):
        calls=[effect['call']] if effect['kind']=='task' else effect['calls']
        if len(calls) not in (1,2) or len(calls)==2 and [item['name'] for item in calls]!=['sync_kinesis_orders','insert_into_kinesis']:fail()
        prepared=[]
        for index,call in enumerate(calls):
            if set(call)!={'name','args','kwargs','options'}:fail()
            task=self.task(call['name']);options=dict(call['options'])
            if any(name in options for name in ('headers','task_id','link','link_error','retry','producer','connection')):fail()
            scope={'contract':CONTRACT,'effectId':effect_id,'commandId':effect['commandId'],'ordinal':index,
                   'name':call['name'],'callHash':digest(self.owner.key,'effect-call',call),'callsHash':digest(self.owner.key,'effect-calls',calls)}
            headers={'screening-origin-effect':{'data':scope,'proofHash':digest(self.owner.key,'effect-call-authorization',scope)}}
            options=self.tasks.route(task,{**options,'task_id':effect_id+('.'+str(index) if len(calls)>1 else ''),'headers':headers},call['args'],call['kwargs'])
            prepared.append((task,call,options))
        if len(prepared)==1:
            task,call,options=prepared[0];result=task.apply_async(args=call['args'],kwargs=call['kwargs'],**options)
        else:
            first,second=[task.s(*call['args'],**call['kwargs']).set(**options) for task,call,options in prepared]
            options=dict(effect.get('options') or {})
            if any(name in options for name in ('headers','task_id','retry','link','link_error','producer','connection')):fail()
            result=(first|second).apply_async(args=effect.get('args') or [],**{**options,'retry':False,'delivery_mode':2,'mandatory':True})
        if not isinstance(getattr(result,'id',None),str) or not 1<=len(result.id)<=128:fail('SCREENING_ORIGIN_EFFECT_UNCERTAIN')
        return {'id':result.id,'accepted':True}
    def direct(self,effect,effect_id):
        # Original synchronous task returns are unused. Publish the same body
        # through its qualified app after commit, retaining its own invocation.
        return self.publish({**effect,'kind':'task'},effect_id)
    def cart_tracking(self,effect,effect_id):
        # Execute the original helper's literal payload selection under the
        # worker's native once fence. Its queue admission cannot broadcast a
        # consumer command and all called tasks use the qualified second app.
        helper=importlib.import_module('fast_queue_helper')
        original=helper.push_cart_event
        function=getattr(original,'__screening_original__',original)
        control=helper.add_queue_to_worker;queue=helper.fast_queue;clock=helper.datetime
        observations=[];failed=[]
        def checked(queue):
            if queue not in PREPARED[2]['queues']:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
        registry=self
        class CapturedQueue:
            class Process:
                def apply_async(self,args=None,kwargs=None,**options):
                    try:
                        task=registry.fast_queue.process_abandon_cart_data
                        routed=registry.tasks.route(task,{**options,'task_id':effect_id,'headers':{'screening-origin-cart-event':effect_id}},args or [],kwargs or {})
                        result=task.apply_async(args=args or [],kwargs=kwargs or {},**routed)
                        if not isinstance(getattr(result,'id',None),str):fail()
                        observations.append(result.id);return result
                    except BaseException:failed.append(True);raise
            process_abandon_cart_data=Process()
        from datetime import datetime
        from types import SimpleNamespace
        class FrozenDate(datetime):
            @classmethod
            def now(cls,tz=None):return cls.fromtimestamp(effect['recordedAt']/1000,tz)
        helper.add_queue_to_worker=checked
        helper.fast_queue=CapturedQueue();helper.datetime=SimpleNamespace(datetime=FrozenDate)
        try:function(*effect['args'],**effect['kwargs'])
        finally:helper.add_queue_to_worker=control;helper.fast_queue=queue;helper.datetime=clock
        if failed or len(observations)!=(1 if helper.CART_EVENT_TRACK else 0):fail('SCREENING_ORIGIN_EFFECT_UNCERTAIN')
        return {'id':effect_id,'accepted':True}
    def cache(self,effect,effect_id):
        from origin_cache import execute
        cache=self.caches.get(effect['alias'])
        if cache is None:fail('SCREENING_ORIGIN_CACHE_UNQUALIFIED')
        execute(cache,effect,effect_id,self.owner.key)
        return {'id':effect_id,'accepted':True}
    def membership_cache(self,effect,effect_id):
        # A membership invalidation must carry a real compare-owner cache
        # mutation; no current-state recomputation or blanket cache delete.
        return self.cache(effect,effect_id)
    def cart(self,effect,effect_id):
        from origin_frame import cart_native_hash
        from database.mysqlCart import MySQLCart
        with self.owner.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'REPEATABLE READ'})
            one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':effect['customerId']})
            prior=rows(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_local_effects WHERE effect_id=:id FOR UPDATE',{'id':effect_id},2)
            if prior:
                record=json_value(prior[0]['data'])
                if record.get('commandId')!=effect['commandId'] or record.get('effectId')!=effect_id or digest(self.owner.key,'local-effect',record)!=prior[0]['proof_hash']:fail()
                return {'id':effect_id,'accepted':True}
            indexes=rows(session,"SELECT TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('cart_items','cart_meta') AND SEQ_IN_INDEX=1",limit=100)
            if any(not any(row['TABLE_NAME']==table and row['COLUMN_NAME']=='cart_id' and row['SUB_PART'] is None for row in indexes) for table in ('cart_items','cart_meta')):fail('SCREENING_ORIGIN_CART_SCHEMA_UNQUALIFIED')
            # Current locking reads retain the exact cart ranges until commit.
            # A later source persist waits and then writes its newer cart.
            if len(rows(session,'SELECT prod_id FROM cart_items WHERE cart_id=:id ORDER BY prod_id LIMIT 2001 FOR UPDATE',{'id':effect['namespace']},2002))>2000:fail()
            if len(rows(session,'SELECT name FROM cart_meta WHERE cart_id=:id ORDER BY name LIMIT 2001 FOR UPDATE',{'id':effect['namespace']},2002))>2000:fail()
            disposition='newer-cart-preserved'
            if cart_native_hash(FlushOnly(session),effect['namespace'])==effect['expectedHash']:
                from controllers.cart.cart_serializer import CartSerializer
                helper=MySQLCart(FlushOnly(session))
                helper.save_cart_items(effect['namespace'],int(effect['customerId']),CartSerializer.products_to_db_payload(effect['value']))
                helper.save_cart_meta(effect['namespace'],effect['value']);session.flush();disposition='original-cart-persisted'
            record={'contract':CONTRACT,'commandId':effect['commandId'],'effectId':effect_id,'kind':'cart','disposition':disposition,'createdAt':self.owner.clock()}
            session.execute(text('INSERT INTO pos_rewrite_screening_origin_local_effects(effect_id,command_id,data,proof_hash) VALUES(:id,:command,:data,:hash)'),
                            {'id':effect_id,'command':effect['commandId'],'data':canonical(record),'hash':digest(self.owner.key,'local-effect',record)})
        return {'id':effect_id,'accepted':True}
    def close(self):
        for app in (self.tasks.app,self.fast_queue.process_abandon_cart_data.app):app.close()
        for cache in self.caches.values():
            pool=getattr(cache,'connection_pool',None)
            if pool is not None:pool.disconnect()
