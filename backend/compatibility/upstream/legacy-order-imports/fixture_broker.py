"""Synthetic I/O for native tests only. Never imported by production runtime."""
from types import SimpleNamespace
from uuid import uuid4
from protocol import ImportReview


class Signature:
    def __init__(self,broker,name):self.broker=broker;self.name=name;self.options={}
    def set(self,**options):self.options.update(options);return self
    def __or__(self,other):return Chain(self.broker,[self,other])


class Chain:
    def __init__(self,broker,signatures):self.broker=broker;self.signatures=signatures
    def apply_async(self,**_options):return self.broker.accept('kinesis-chain')


class Task:
    queue=None
    def __init__(self,broker,name):self.broker=broker;self.name=name
    def s(self,*_args,**_kwargs):return Signature(self.broker,self.name)
    def apply_async(self,**options):
        if options.get('retry') is not False or options.get('delivery_mode')!=2 or options.get('mandatory') is not True:
            raise ImportReview('ORDER_IMPORT_PUBLISHER_UNQUALIFIED')
        return self.broker.accept(self.name)


class FixtureBroker:
    def __init__(self,mode=None):
        self.mode=mode;self.accepted=[]
        self.app=SimpleNamespace(conf=SimpleNamespace(broker_url='amqps://fixture.invalid/vhost',
            broker_transport_options={'confirm_publish':True},task_publish_retry=False,task_default_delivery_mode=2,
            task_default_queue='fixture-default'),amqp=SimpleNamespace(queues={name:SimpleNamespace(durable=True,auto_delete=False)
                for name in ('fixture-default','fixture-cashback','fixture-warehouse','fixture-kinesis','fixture-engagement')}))
        self.app.amqp.router=SimpleNamespace(route=lambda options,_name,**_args:{**options,'queue':
            self.app.amqp.queues.get(options.get('queue') or 'fixture-default')})
    def __getattr__(self,name):return Task(self,name)
    def accept(self,name):
        identifier=str(uuid4());self.accepted.append({'id':identifier,'task':name})
        if self.mode=='lost-queue-ack' and len(self.accepted)==3:
            raise ImportReview('ORDER_IMPORT_PUBLICATION_UNCONFIRMED')
        return SimpleNamespace(id=identifier)
