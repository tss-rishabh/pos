"""Literal catalog/cart/validation/calculation/PosOrder in one native receiver.

Catalog documents, cart storage/initializer and address lookup are declared
fixture I/O. Source class methods/calculator, constructors, HP/refund/audit SQL,
owned transaction and receipt binding are real. No broker/provider is used.
"""
import json
import os
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from sqlalchemy import create_engine,event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session,sessionmaker

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports'))
sys.path.insert(0,str(ROOT/'compatibility/upstream/screening-origins'))
sys.path.insert(0,str(ROOT/'tools/legacy-import-preparation'))
from source_fixture import pipeline,K
from test_catalog_pipeline import actual_catalog,fixture_add_io
from cart_tracking import compile_helper
from source_runtime import SourceRuntime,SilentLogger
from receiver import Receiver
from protocol import ImportReview
from transaction import normalize_source_sentinels,guard_private_statement,guard_private_commit
import native_source_driver as native


def run(value,customize=None):
    url=make_url(value['url'])
    if (url.host not in ('localhost','127.0.0.1') or not url.database.startswith('pos_rewrite_import_runtime_') or
            len(url.database)!=len('pos_rewrite_import_runtime_')+12 or url.query):raise RuntimeError('Isolated localhost fixture required')
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
    event.listen(Session,'before_flush',normalize_source_sentinels);event.listen(engine,'commit',guard_private_commit)
    event.listen(engine,'before_cursor_execute',guard_private_statement)
    source=Path(value['sourceRoot']);plan=value['body']['plan'];trace=[]
    literal=pipeline(source,plan,trace)
    native_writer=native.NativePipeline(source,None)
    native_writer.settings.IS_LINE_ITEM_ENABLED=value.get('lineItems',False)
    queues=tuple('user_cart_track_'+str(i) for i in range(10))
    for queue in queues:native_writer.tasks.app.amqp.queues[queue]=SimpleNamespace(durable=True,auto_delete=False)
    literal.tasks=native_writer.tasks;literal.settings=native_writer.settings;literal.controller_hash=native_writer.controller_hash
    literal.product=actual_catalog(source,literal,trace,sku=int(plan['lines'][0]['productId']))
    fixture_add_io(source,literal)
    if customize is not None:customize(value,source,literal,native_writer,engine)
    literal.membership.admit=lambda *_a:[]
    literal.membership.capture=lambda *_a:None
    helpers=compile_helper(source,SimpleNamespace(CART_PROCESS_ORDER_TRACK=True),queues,SilentLogger())
    literal.process.source.on_post.__func__.__globals__['push_process_order_event']=helpers['push_process_order_event']
    original_compile=native.compile_class
    class Order:
        def on_post(self,req,resp):
            trace.append('order')
            cart=req.context['cart'];original_get=cart.get;original_item=cart.get_item
            def kind(value):return K(value.value) if type(getattr(value,'value',None)) is int else value
            cart.get=lambda value:original_get(kind(value))
            cart.get_item=lambda value,query:original_item(kind(value),query)
            def compile_order(root,path,name,namespace):
                original=original_compile(root,path,name,namespace)
                if name!='PosOrder':return original
                class Actual:
                    def on_post(self,inner,response):
                        result=original().on_post(inner,response)
                        resp.body,resp.text,resp.status=response.body,getattr(response,'text',''),response.status
                        return result
                return Actual
            with patch.object(native,'Cart',lambda _plan:cart),patch.object(native,'compile_class',compile_order):
                native_writer.order_pipeline(req.context['session'],req.context['user'],plan,value['body']['capability'])
            if value.get('lateFailure'):raise ImportReview('ORDER_IMPORT_FIXTURE_LATE_FAILURE')
    literal.order=Order()
    literal.publication_intents=native_writer.publication_intents
    service=Receiver(sessionmaker(bind=engine,expire_on_commit=False),literal,value['authKey'],value['proofKey'],clock=lambda:value['now'],
        correction_contract=value.get('correctionContract'))
    try:
        if value.get('phase')=='preparation':
            os.environ['POS_LEGACY_IMPORT_PREPARATION_CONTRACT']='pos-import-order-preparation-v1'
            return service.preparation(value['operationId'],value['body'])
        result=service.order(value['operationId'],value['body'])
        return {**result,'trace':trace,'queueCalls':len(native_writer.tasks.accepted)}
    except Exception as error:
        return {'code':error.code if isinstance(error,ImportReview) else 'ACTUAL_PIPELINE_FIXTURE_FAILED',
                'trace':trace,'queueCalls':len(native_writer.tasks.accepted),'errorType':type(error).__name__,
                'frames':[Path(row.filename).name+':'+str(row.lineno) for row in traceback.extract_tb(error.__traceback__)]}
    finally:engine.dispose()


if __name__=='__main__':
    try:print(json.dumps(run(json.loads(sys.stdin.read())),separators=(',',':')))
    except Exception:
        print('{"code":"ACTUAL_PIPELINE_FIXTURE_BOOTSTRAP_FAILED"}')
        sys.exit(1)
