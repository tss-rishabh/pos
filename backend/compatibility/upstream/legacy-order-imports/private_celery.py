"""Owned pre-import Celery factories. No broker control occurs at import.

The two actual source apps are configured for a qualified private AMQP broker;
the pinned module's fourteen ad-hoc consumer broadcasts are not executed. Real
workers must already consume the explicitly declared durable queues.
"""
import ast
import hashlib
import importlib
import re
import ssl
import sys
from pathlib import Path
from types import ModuleType
from urllib.parse import urlsplit
from protocol import ImportReview

CONTRACT='pos-import-owned-celery-v1'
SOURCE_SHA='cc7dfef73bd6b2d45e706bb9b38c0f49084acd86112a9ef5d07606c9a62921c7'
QUEUE=re.compile(r'[A-Za-z0-9_.:-]{1,128}')


def invalid():raise ImportReview('ORDER_IMPORT_PUBLISHER_UNQUALIFIED') from None


def options(environment):
    import json
    if environment.get('POS_LEGACY_IMPORT_CELERY_CONTRACT')!=CONTRACT:invalid()
    try:
        url=environment['POS_LEGACY_IMPORT_BROKER_URL'];parsed=urlsplit(url)
        queues=json.loads(environment['POS_LEGACY_IMPORT_EFFECT_QUEUES'])
        default=environment.get('POS_LEGACY_IMPORT_DEFAULT_QUEUE','pos-import-effects')
        ca=Path(environment['POS_LEGACY_IMPORT_BROKER_CA_FILE']).resolve(strict=True)
        if (parsed.scheme!='amqps' or not parsed.hostname or not parsed.username or not parsed.password
                or parsed.query or parsed.fragment or len(url)>4096 or parsed.port not in (None,5671)
                or not ca.is_file() or not isinstance(queues,list) or not 1<=len(queues)<=100
                or len(set(queues))!=len(queues) or any(not isinstance(value,str) or not QUEUE.fullmatch(value) for value in queues)
                or default not in queues):invalid()
        return {'contract':CONTRACT,'broker':url,'ca':str(ca),'queues':tuple(queues),'default':default}
    except Exception:invalid()


def configure(module,value):
    from kombu import Queue
    result={}
    for name in ('app','abandon_cart_app'):
        app=module.Celery('pos_import_'+name,broker=value['broker'],backend=None)
        app.conf.update(broker_use_ssl={'ca_certs':value['ca'],'cert_reqs':ssl.CERT_REQUIRED,'check_hostname':True},
            broker_transport_options={'confirm_publish':True},task_publish_retry=False,
            task_default_delivery_mode=2,task_default_queue=value['default'],
            task_create_missing_queues=False,task_queues=[Queue(name,durable=True,auto_delete=False) for name in value['queues']],
            broker_connection_timeout=5,broker_connection_retry=False,broker_connection_retry_on_startup=False,
            task_ignore_result=True,task_store_errors_even_if_ignored=False,task_always_eager=False,
            task_send_sent_event=False,worker_send_task_events=False)
        result[name]=app
    return result


def _package(root,name):
    existing=sys.modules.get(name)
    if existing is not None:return existing
    target=root/name/'__init__.py'
    if not target.exists() or target.read_bytes()!=b'':invalid()
    value=ModuleType(name);value.__path__=[str(root/name)];value.__file__=str(target)
    sys.modules[name]=value
    return value


def install(root,settings,value,apps):
    """Execute the pinned configuration after replacing only SQL-free factories
    and exact eager control/discovery nodes. Original task decorators still use
    real Celery apps; source broker URLs are never evaluated as constructors.
    """
    root=Path(root).resolve();source=root/'libs/celery.py';raw=source.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=SOURCE_SHA:invalid()
    existing=sys.modules.get('libs.celery')
    if existing is not None:
        if getattr(existing,'__pos_private_celery__',None)!=str(root):invalid()
        if any(getattr(existing,name) is not apps[name] for name in apps):invalid()
        return existing
    tree=ast.parse(raw);counts={'factory':0,'control':0,'discovery':0,'transport':0,'legacy_uri':0}
    for index,node in enumerate(tree.body):
        if isinstance(node,ast.Import) and any(alias.name=='celery' for alias in node.names):
            # The selected factory has already imported real Celery. This
            # assignment keeps unit fixtures network-disabled without a fake
            # arbitrary module registry or a default attribute fallback.
            tree.body[index]=ast.copy_location(ast.Assign(targets=[ast.Name(id='celery',ctx=ast.Store())],value=ast.Constant(value=None)),node)
        elif isinstance(node,ast.Import) and any(alias.name=='settings' for alias in node.names):
            tree.body[index]=ast.copy_location(ast.Assign(targets=[ast.Name(id='settings',ctx=ast.Store())],value=ast.Name(id='_settings',ctx=ast.Load())),node)
        elif isinstance(node,ast.ImportFrom) and node.module=='settings':
            assignments=[ast.Assign(targets=[ast.Name(id=alias.asname or alias.name,ctx=ast.Store())],
                value=ast.Attribute(value=ast.Name(id='_settings',ctx=ast.Load()),attr=alias.name,ctx=ast.Load())) for alias in node.names]
            tree.body[index]=ast.copy_location(ast.If(test=ast.Constant(value=True),body=assignments,orelse=[]),node)
        elif isinstance(node,ast.Assign) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) and isinstance(node.value.func.value,ast.Name) and node.value.func.value.id=='celery' and node.value.func.attr=='Celery':
            if len(node.targets)!=1 or not isinstance(node.targets[0],ast.Name) or node.targets[0].id not in apps:invalid()
            node.value=ast.Subscript(value=ast.Name(id='_apps',ctx=ast.Load()),slice=ast.Constant(value=node.targets[0].id),ctx=ast.Load());counts['factory']+=1
        elif isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute):
            call=node.value
            if call.func.attr=='add_consumer':
                if ast.unparse(call.func)!='app.control.add_consumer' or len(call.args)!=1 or not isinstance(call.args[0],ast.Name):invalid()
                queue=getattr(settings,call.args[0].id)
                if queue not in value['queues']:invalid()
                tree.body[index]=ast.copy_location(ast.Pass(),node);counts['control']+=1
            elif call.func.attr=='autodiscover_tasks':
                tree.body[index]=ast.copy_location(ast.Pass(),node);counts['discovery']+=1
        elif isinstance(node,ast.Assign) and any(isinstance(target,ast.Attribute) and target.attr=='broker_transport_options' for target in node.targets):
            tree.body[index]=ast.copy_location(ast.Pass(),node);counts['transport']+=1
        elif isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id=='CELERY_BROKER_BACKEND':
            tree.body[index]=ast.copy_location(ast.Pass(),node);counts['legacy_uri']+=1
    if counts!={'factory':2,'control':14,'discovery':2,'transport':1,'legacy_uri':1}:invalid()
    module=ModuleType('libs.celery');module.__file__=str(source);module.__package__='libs'
    module.__dict__.update(_settings=settings,_apps=apps)
    exec(compile(ast.fix_missing_locations(tree),'<pinned-private-celery>','exec'),module.__dict__)
    module.__pos_private_celery__=str(root)
    _package(root,'libs').celery=module;sys.modules['libs.celery']=module
    return module


def bind(root,environment):
    value=options(environment)
    settings=importlib.import_module('settings')
    apps=configure(importlib.import_module('celery'),value)
    return install(root,settings,value,apps),value


class TaskRegistry:
    def __init__(self,tasks,cart,value):
        self.original=tasks;self.cart=cart;self.value=value;self.app=tasks.app
    def assert_ready(self):
        for app in (self.app,self.cart.app):
            conf=app.conf;security=conf.broker_use_ssl
            if (conf.broker_url!=self.value['broker'] or not isinstance(security,dict)
                    or security.get('cert_reqs')!=ssl.CERT_REQUIRED or security.get('ca_certs')!=self.value['ca'] or security.get('check_hostname') is not True
                    or conf.broker_transport_options.get('confirm_publish') is not True
                    or conf.task_publish_retry is not False or conf.task_default_delivery_mode!=2
                    or conf.task_create_missing_queues is not False or conf.task_always_eager is not False
                    or conf.task_send_sent_event is not False or conf.worker_send_task_events is not False):invalid()
    def __getattr__(self,name):
        if name=='process_abandon_cart_data':return self.cart
        return getattr(self.original,name)
    def route(self,task,value,args,kwargs):
        self.assert_ready()
        if task.app not in (self.app,self.cart.app):invalid()
        chosen=task.app.amqp.router.route({**value,'retry':False,'delivery_mode':2,'mandatory':True,'timeout':5,
            'argsrepr':'<private-source-effect>','kwargsrepr':'<private-source-effect>'},task.name,args=args,kwargs=kwargs)
        queue=chosen.get('queue');name=queue if isinstance(queue,str) else getattr(queue,'name',None)
        if name not in self.value['queues']:invalid()
        if isinstance(queue,str):queue=task.app.amqp.queues.get(queue)
        if queue is None or queue.durable is not True or queue.auto_delete is not False:invalid()
        return {**chosen,'queue':queue}
