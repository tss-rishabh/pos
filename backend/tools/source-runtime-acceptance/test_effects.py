"""Literal source producer/factory tests. No broker, provider or source DB I/O."""
import ast
import copy
import datetime
import io
import json
import os
import ssl
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports'))
from protocol import ImportReview
from transaction import CURRENT,VIOLATION,private_session
from effects import CAPTURE,prepared_calls,publish_once,Tasks
from cart_preparation import read_only_preview
from cart_tracking import compile_helper,checked,HELPER_SHA,SELECTED
from private_celery import install,options,TaskRegistry
from private_cache import configure as configure_cache

SOURCE=Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT',ROOT.parent.parent/'backend-tss-api_v2'))


class Clock(datetime.datetime):
    @classmethod
    def now(cls):return cls(2026,6,15,12,0,0)


class Quiet:
    def __getattr__(self,_name):return lambda *_args,**_kwargs:None


class SourceEffects(unittest.TestCase):
    def setUp(self):
        self.user={'user_id':77,'firstname':'Fixture','lastname':'Customer','telephone':'9999999999','email':'private@example.test'}
        self.cart={'products':{'items':[{'quantity':2},{'quantity':3}]},'meta':{'items':[{'name':'cod','valid':True}]}}
        self.queues=tuple('user_cart_track_'+str(value) for value in range(10))
        self.clock=SimpleNamespace(datetime=Clock,timedelta=datetime.timedelta)

    def capture(self,helper,name,user=None,cart=None):
        result=[];tokens=(CURRENT.set(object()),CAPTURE.set(result),VIOLATION.set(False))
        try:
            args=(user or self.user,cart or self.cart) if name=='push_process_order_event' else (user or self.user,)
            helper[name](*args)
            self.assertFalse(VIOLATION.get())
            return result
        finally:
            CURRENT.reset(tokens[0]);CAPTURE.reset(tokens[1]);VIOLATION.reset(tokens[2])

    def helper(self,enabled=True,queues=None):
        return compile_helper(SOURCE,SimpleNamespace(CART_PROCESS_ORDER_TRACK=enabled),self.queues if queues is None else queues,Quiet(),self.clock)

    def original(self,name,user,cart):
        records=[];controls=[]
        namespace={'datetime':self.clock,'logger':Quiet(),'CART_PROCESS_ORDER_TRACK':True,
                   'abandon_cart_app':SimpleNamespace(control=SimpleNamespace(add_consumer=controls.append)),
                   'fast_queue':SimpleNamespace(process_abandon_cart_data=SimpleNamespace(apply_async=lambda **value:records.append(value)))}
        tree=checked(SOURCE,'fast_queue_helper.py',HELPER_SHA)
        functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in SELECTED]
        exec(compile(ast.Module(body=functions,type_ignores=[]),'<literal-original-fast-helper>','exec'),namespace)
        namespace[name](user,cart) if name=='push_process_order_event' else namespace[name](user)
        return records,controls

    def test_literal_before_and_after_payment_payloads_and_python_hash_partitions(self):
        for name in ('push_process_order_event','push_after_payment_event'):
            for customer in (77,2305843009213693952,9223372036854775807):
                with self.subTest(name=name,customer=customer):
                    user={**self.user,'user_id':customer}
                    original,controls=self.original(name,user,self.cart)
                    captured=self.capture(self.helper(),name,user)
                    self.assertEqual(len(captured),1)
                    call=captured[0]['call']
                    self.assertEqual(call,{'name':'process_abandon_cart_data','args':original[0]['args'],'kwargs':{},'options':{'queue':original[0]['queue']}})
                    self.assertEqual(controls,[call['options']['queue']])
                    if name=='push_after_payment_event':
                        self.assertEqual(call['args'][0]['no_of_items'],0)
                        self.assertEqual(call['args'][0]['last_update_checkout'],'2027-06-15 12:00:00')
                    else:self.assertEqual(call['args'][0]['no_of_items'],5)

    def test_no_source_effects_during_preview_and_feature_disabled_stays_disabled(self):
        result=[];token=CAPTURE.set(result)
        try:
            with read_only_preview():self.helper()['push_process_order_event'](self.user,self.cart)
            self.assertEqual(result,[])
        finally:CAPTURE.reset(token)
        self.assertEqual(self.capture(self.helper(False),'push_process_order_event'),[])

    def test_nullable_source_contact_payload_is_preserved_without_normalization(self):
        user={**self.user,'email':None,'telephone':None}
        original,_=self.original('push_process_order_event',user,self.cart)
        captured=self.capture(self.helper(),'push_process_order_event',user)
        self.assertEqual(captured[0]['call']['args'],original[0]['args'])

    def test_missing_private_scope_or_collector_never_silently_succeeds(self):
        with self.assertRaises(ImportReview):self.helper()['push_process_order_event'](self.user,self.cart)
        token=CURRENT.set(object())
        try:
            with self.assertRaises(ImportReview):self.helper()['push_process_order_event'](self.user,self.cart)
        finally:CURRENT.reset(token);VIOLATION.set(False)

    def test_source_broad_exception_cannot_hide_bad_queue_or_payload(self):
        with self.assertRaises(ImportReview):self.capture(self.helper(queues=()),'push_process_order_event')
        with self.assertRaises(ImportReview):self.capture(self.helper(),'push_process_order_event',cart={'products':{'items':[{'quantity':-1}]}})
        with self.assertRaises(ImportReview):self.capture(self.helper(),'push_process_order_event',user={**self.user,'user_id':0})

    def test_other_swallowed_source_task_failure_taints_the_outer_owned_transaction(self):
        effects=[{} for _ in range(20)];token=CAPTURE.set(effects)
        try:
            with self.assertRaises(ImportReview):
                with private_session(SimpleNamespace(flush=lambda:None)):
                    try:Tasks().netcore_events_task.delay(5001)
                    except Exception:pass  # Actual source broad-handler shape.
            self.assertEqual(len(effects),20)
        finally:CAPTURE.reset(token)


class CeleryFactories(unittest.TestCase):
    def test_exact_two_factories_and_fourteen_consumers_are_never_executed(self):
        tree=ast.parse((SOURCE/'libs/celery.py').read_bytes());names=[]
        for node in tree.body:
            if isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and ast.unparse(node.value.func)=='app.control.add_consumer':names.append(node.value.args[0].id)
        settings=SimpleNamespace(**{name:'fixture-'+name.lower() for name in names})
        settings.CELERY_TASK_RESULT_EXPIRES_IN_SEC=300
        # All source Redis/Celery URI attributes are deliberately absent.
        apps={name:SimpleNamespace(conf=SimpleNamespace()) for name in ('app','abandon_cart_app')}
        with patch.dict(sys.modules,{},clear=False):
            sys.modules.pop('libs.celery',None);sys.modules.pop('libs',None)
            module=install(SOURCE,settings,{'queues':tuple(getattr(settings,name) for name in names)},apps)
            self.assertIs(module.app,apps['app']);self.assertIs(module.abandon_cart_app,apps['abandon_cart_app'])
            self.assertEqual(len(names),14)

    def test_options_reject_unverified_plaintext_broker_and_bad_queue_without_echoing_values(self):
        with tempfile.NamedTemporaryFile() as ca:
            env={'POS_LEGACY_IMPORT_CELERY_CONTRACT':'pos-import-owned-celery-v1',
                 'POS_LEGACY_IMPORT_BROKER_URL':'amqps://fixture:private@broker.invalid:5671/private',
                 'POS_LEGACY_IMPORT_EFFECT_QUEUES':'["pos-import-effects"]','POS_LEGACY_IMPORT_BROKER_CA_FILE':ca.name}
            self.assertEqual(options(env)['default'],'pos-import-effects')
            for value in ('redis://fixture:private@broker.invalid/1','amqp://fixture:private@broker.invalid/private','amqps://fixture:private@broker.invalid/private?secret=private'):
                with self.assertRaises(ImportReview) as error:options({**env,'POS_LEGACY_IMPORT_BROKER_URL':value})
                self.assertNotIn('private',str(error.exception))
            with self.assertRaises(ImportReview):options({**env,'POS_LEGACY_IMPORT_EFFECT_QUEUES':'["bad/queue"]'})

    def test_task_specific_router_and_literal_queue_are_qualified_before_publish(self):
        queue=SimpleNamespace(name='user_cart_track_7',durable=True,auto_delete=False);routed=[];published=[]
        value={'broker':'amqps://fixture:private@broker.invalid/private','ca':'fixture-ca','queues':(queue.name,)}
        def app(label):
            conf=SimpleNamespace(broker_url=value['broker'],broker_use_ssl={'cert_reqs':ssl.CERT_REQUIRED,'ca_certs':'fixture-ca','check_hostname':True},
                broker_transport_options={'confirm_publish':True},task_publish_retry=False,task_default_delivery_mode=2,task_create_missing_queues=False,task_always_eager=False,
                task_send_sent_event=False,worker_send_task_events=False)
            router=SimpleNamespace(route=lambda options,name,**kwargs:(routed.append((label,name)) or {**options,'queue':queue}))
            return SimpleNamespace(conf=conf,amqp=SimpleNamespace(router=router,queues={queue.name:queue}))
        main=app('main');cart=app('cart')
        task=SimpleNamespace(app=cart,name='fast_queue.process_abandon_cart_data',apply_async=lambda **value:(published.append(value) or SimpleNamespace(id='actual-celery-id')))
        registry=TaskRegistry(SimpleNamespace(app=main),task,value)
        intent={'call':{'name':'process_abandon_cart_data','args':[{}],'kwargs':{},'options':{'queue':queue.name}}}
        self.assertEqual(publish_once(registry,intent),{'id':'actual-celery-id','kind':'cart-tracking'})
        self.assertEqual(routed,[('cart',task.name)])
        self.assertEqual(published[0]['retry'],False);self.assertEqual(published[0]['mandatory'],True)
        self.assertEqual(published[0]['timeout'],5)
        self.assertEqual(published[0]['argsrepr'],'<private-source-effect>')
        cart.conf.task_always_eager=True
        with self.assertRaises(ImportReview):prepared_calls(registry,intent)
        self.assertEqual(len(published),1)


class PrivateCaches(unittest.TestCase):
    def test_current_body_runs_without_cache_io_and_only_postcommit_invalidation_uses_external_port(self):
        called=[]
        def decorator(*_args,**_kwargs):
            def bind(function):
                def external(*args,**kwargs):called.append('redis-read-write');return function(*args,**kwargs)
                return external
            return bind
        module=SimpleNamespace(cache_regions={},cache_region=decorator,region_invalidate=lambda *_a,**_k:called.append('postcommit-invalidate'))
        settings=SimpleNamespace(BEAKER_REDIS_URL='rediss://fixture.invalid:6379/9',**{
            name:5 for name in ('CACHE_SHORT_TERM','CACHE_MINI_SHORT_TERM','CACHE_ULTRA_SHORT_TERM','CACHE_LONG_TERM','CACHE_ULTRA_LONG_TERM','CACHE_MAJOR_LONG_TERM')})
        configure_cache(SOURCE,settings,module)
        bodies=[]
        @module.cache_region('long_term','fixture')
        def source_body(value):bodies.append(value);return {'value':value}
        with self.assertRaises(ImportReview):source_body(0)
        token=CURRENT.set(object())
        try:
            self.assertEqual(source_body(1),{'value':1})
            self.assertEqual(source_body(2),{'value':2})
            module.region_invalidate(source_body,'long_term','fixture')
        finally:CURRENT.reset(token)
        self.assertEqual(called,[]);self.assertEqual(bodies,[1,2])
        module.region_invalidate(source_body,'long_term','fixture')
        self.assertEqual(called,['postcommit-invalidate'])
        self.assertEqual(len(module.cache_regions),6)


if __name__=='__main__':unittest.main()
