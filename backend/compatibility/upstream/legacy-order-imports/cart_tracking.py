"""Pinned FastQueue payload/partition calculation, captured before any I/O.

The actual source helper is executed. Its broad exception handler cannot hide
a refused capture. Ad-hoc worker-control broadcasts are replaced by a checked
declared durable queue; a worker must already consume it before activation.
"""
import ast
import datetime
import hashlib
import sys
from contextvars import ContextVar
from pathlib import Path
from types import ModuleType,SimpleNamespace
from effects import collector_record
from protocol import ImportReview,canonical
from transaction import CURRENT,VIOLATION
from cart_preparation import PREVIEW_ONLY

HELPER_SHA='a55300fb3d2e0151f09820c41529eee67b6f98bc593fd48b5ec68dd31eb63969'
TASK_SHA='d0fe47aa6b34bdb5f7affc1d1bb887c672b9f2c3e76c6dc5e7349e3ed4541b60'
FRAME=ContextVar('pos_import_cart_tracking',default=None)
SELECTED=('get_queue_name','add_queue_to_worker','extract_items','push_process_order_event','push_after_payment_event')


def invalid():
    VIOLATION.set(True)
    frame=FRAME.get()
    if frame is not None:frame['failed']=True
    raise ImportReview('ORDER_IMPORT_CART_EFFECT_UNQUALIFIED') from None


def checked(root,name,expected):
    raw=(Path(root)/name).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=expected:invalid()
    return ast.parse(raw)


class CaptureControl:
    def __init__(self,queues):self.queues=queues
    def add_consumer(self,queue):
        frame=FRAME.get()
        if frame is None or frame['queue'] is not None or queue not in self.queues:invalid()
        frame['queue']=queue


class CaptureTask:
    def apply_async(self,args=None,**options):
        frame=FRAME.get()
        if (frame is None or frame['recorded'] or CURRENT.get() is None or not isinstance(args,list)
                or len(args)!=1 or not isinstance(args[0],dict) or set(options)!={'queue'}
                or options['queue']!=frame['queue']):invalid()
        payload=args[0]
        if (set(payload)!={'user_id','user_name','user_mobile','user_email','no_of_items','is_cod_eligible','last_update','last_update_checkout'}
                or type(payload['user_id']) is not int or payload['user_id']!=frame['customer']
                or type(payload['no_of_items']) is not int or not 0<=payload['no_of_items']<=1000000
                or type(payload['is_cod_eligible']) is not bool
                or not isinstance(payload['user_name'],str) or len(payload['user_name'])>2048
                or any(payload[name] is not None and (not isinstance(payload[name],str) or len(payload[name])>2048) for name in ('user_mobile','user_email'))
                or len(canonical(payload).encode())>16000):invalid()
        for name in ('last_update','last_update_checkout'):
            try:
                parsed=datetime.datetime.strptime(payload[name],'%Y-%m-%d %H:%M:%S')
                if parsed.strftime('%Y-%m-%d %H:%M:%S')!=payload[name]:invalid()
            except Exception:invalid()
        result=collector_record({'call':{'name':'process_abandon_cart_data','args':args,'kwargs':{},'options':options}})
        frame['recorded']=True
        return result


def _scope(function,enabled):
    def captured(user,*args):
        if PREVIEW_ONLY.get():return None
        if FRAME.get() is not None or CURRENT.get() is None or not isinstance(user,dict):invalid()
        try:
            customer=int(user['user_id'])
            if customer<1 or customer>9223372036854775807:invalid()
        except Exception:invalid()
        value={'customer':customer,'queue':None,'recorded':False,'failed':False}
        token=FRAME.set(value)
        try:
            result=function(user,*args)
            if value['failed'] or bool(enabled)!=value['recorded'] or bool(enabled)!=(value['queue'] is not None):invalid()
            return result
        finally:FRAME.reset(token)
    return captured


def compile_helper(root,settings,queues,logger,clock=datetime):
    tree=checked(root,'fast_queue_helper.py',HELPER_SHA)
    selected=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in SELECTED]
    if tuple(node.name for node in selected)!=SELECTED:invalid()
    namespace={'__name__':'fast_queue_helper','datetime':clock,'logger':logger,
               'CART_PROCESS_ORDER_TRACK':settings.CART_PROCESS_ORDER_TRACK,
               'abandon_cart_app':SimpleNamespace(control=CaptureControl(queues)),
               'fast_queue':SimpleNamespace(process_abandon_cart_data=CaptureTask())}
    exec(compile(ast.Module(body=selected,type_ignores=[]),'<pinned-private-cart-tracking>','exec'),namespace)
    for name in ('push_process_order_event','push_after_payment_event'):
        namespace[name]=_scope(namespace[name],settings.CART_PROCESS_ORDER_TRACK)
    return namespace


def install(root,settings,queues,app,logger):
    """Install before controller import; no SQS/Mongo client is constructed.

    This publisher registers the literal source task name/body on a real Celery
    app. Eager execution is refused; the approved consumer owns the original
    downstream SQS transport separately from broker delivery confirmation.
    """
    root=Path(root).resolve()
    for name in ('fast_queue','fast_queue_helper'):
        old=sys.modules.get(name)
        if old is not None:
            if getattr(old,'__pos_private_cart_tracking__',None)!=str(root):invalid()
            return sys.modules['fast_queue_helper'],sys.modules['fast_queue'].process_abandon_cart_data
    tree=checked(root,'fast_queue.py',TASK_SHA)
    functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='process_abandon_cart_data']
    if len(functions)!=1:invalid()
    task=ModuleType('fast_queue');task.__file__=str(root/'fast_queue.py')
    task.__dict__.update(abandon_cart_app=app,logger=logger,send_message=lambda *_a,**_k:invalid())
    exec(compile(ast.Module(body=functions,type_ignores=[]),'<pinned-private-fast-queue>','exec'),task.__dict__)
    helper=ModuleType('fast_queue_helper');helper.__file__=str(root/'fast_queue_helper.py')
    helper.__dict__.update(compile_helper(root,settings,queues,logger))
    # The nonpersisted private cart does not emit abandonment notifications.
    # No default attribute fallback can admit an unrelated producer.
    helper.push_cart_event=lambda *_a,**_k:None
    helper.push_notification=lambda *_a,**_k:invalid()
    task.__pos_private_cart_tracking__=helper.__pos_private_cart_tracking__=str(root)
    sys.modules['fast_queue']=task;sys.modules['fast_queue_helper']=helper
    return helper,task.process_abandon_cart_data
