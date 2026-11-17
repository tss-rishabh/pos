"""Capture actual Celery source calls and execute each original canvas once.

Production requires broker publisher confirms. A connection/ACK loss is an
uncertain delivery, never an excuse to republish a job with a new identity.
"""
from types import SimpleNamespace
from protocol import ImportReview, canonical

KINDS = {'make_assign_warehouse_request':'warehouse','create_cashback_for_pos':'cashback',
         'sendFacebookEvents':'facebook','netcore_events_task':'engagement',
         'mirror_order_to_post_order':'shadow','sync_kinesis_orders':'kinesis-chain',
         'insert_into_kinesis':'kinesis-chain','send_order_placed_sms':'sms',
         'pos_import_invalidate_membership':'membership-cache'}


class EffectCall:
    def __init__(self,name,args=None,kwargs=None,options=None):
        if name not in KINDS:
            raise ImportReview('ORDER_IMPORT_EFFECT_UNQUALIFIED')
        self.value = {'name':name,'args':list(args or []),'kwargs':kwargs or {},'options':options or {}}

    def set(self,**options):
        self.value['options'].update(options)
        return self

    def __or__(self,other):
        return EffectChain([self,other])


class EffectChain:
    def __init__(self,calls):
        self.calls=calls

    def apply_async(self,args=None,**options):
        return collector_record({'chain':[call.value for call in self.calls], 'args':list(args or []),'options':options})


from contextvars import ContextVar
CAPTURE = ContextVar('pos_import_effects',default=None)


def collector_record(value):
    target=CAPTURE.get()
    if target is None or len(target)>=20 or len(canonical(value).encode())>256000:
        raise ImportReview('ORDER_IMPORT_EFFECT_UNQUALIFIED')
    target.append(value)
    return SimpleNamespace(id='deferred-source-effect')


class Task:
    def __init__(self,name):
        self.name=name

    def s(self,*args,**kwargs):
        return EffectCall(self.name,args,kwargs)

    def apply_async(self,args=None,kwargs=None,**options):
        call=EffectCall(self.name,args,kwargs,options)
        collector_record({'call':call.value})
        return SimpleNamespace(id='deferred-source-effect')

    def delay(self,*args,**kwargs):
        return self.apply_async(args,kwargs)


class Tasks:
    def __getattr__(self,name):
        if name not in KINDS:
            raise ImportReview('ORDER_IMPORT_EFFECT_UNQUALIFIED')
        return Task(name)


def prepared_calls(tasks,intent):
    def options(value,task,args,kwargs):
        chosen=tasks.app.amqp.router.route({**value,'retry':False,'delivery_mode':2,'mandatory':True},task.name,args=args,kwargs=kwargs)
        queue=chosen.get('queue')
        if isinstance(queue,str):queue=tasks.app.amqp.queues.get(queue)
        if queue is None or queue.durable is not True or queue.auto_delete is not False:
            raise ImportReview('ORDER_IMPORT_PUBLISHER_UNQUALIFIED')
        return chosen
    def prepared(value):
        if value['name'] not in KINDS:raise ImportReview('ORDER_IMPORT_EFFECT_UNQUALIFIED')
        task=getattr(tasks,value['name'])
        return task,value,options(value['options'],task,value['args'],value['kwargs'])
    if 'call' in intent:
        return [prepared(intent['call'])]
    if [value['name'] for value in intent['chain']] != ['sync_kinesis_orders','insert_into_kinesis']:
        raise ImportReview('ORDER_IMPORT_EFFECT_UNQUALIFIED')
    return [prepared(value) for value in intent['chain']]


def publish_once(tasks,intent):
    prepared=prepared_calls(tasks,intent)
    if 'call' in intent:
        task,value,options=prepared[0]
        result=task.apply_async(args=value['args'],kwargs=value['kwargs'],**options)
        kind=KINDS[value['name']]
    else:
        calls=[task.s(*value['args'],**value['kwargs']).set(**options) for task,value,options in prepared]
        result=(calls[0]|calls[1]).apply_async(args=intent['args'],**{**intent['options'],'retry':False,'delivery_mode':2,'mandatory':True})
        kind='kinesis-chain'
    if not isinstance(getattr(result,'id',None),str) or not 1<=len(result.id)<=128:
        raise ImportReview('ORDER_IMPORT_PUBLICATION_UNCONFIRMED')
    return {'id':result.id,'kind':kind}
