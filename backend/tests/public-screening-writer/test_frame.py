import ast
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import traceback
import unittest
from pathlib import Path
from types import SimpleNamespace,ModuleType

ROOT=Path(__file__).resolve().parents[2]
for folder in ('legacy-order-imports','offline-cash-pricing','public-screening-writer'):
    sys.path.insert(0,str(ROOT/'compatibility/upstream'/folder))
from source_frame import FRAME,RoutedSession,RoutedCache,RoutedTasks,RoutedLogger,projection,NodePosWriterMiddleware
from source_runtime import SOURCE_REDIS_ALIASES
from transaction import CURRENT,TransactionSession
from writer_protocol import ScreeningWriterError,verify

SOURCE=Path(os.environ['POS_LEGACY_IMPORT_SOURCE_ROOT'])


class FrameTests(unittest.TestCase):
    def test_session_exports_route_only_selected_frames(self):
        class Original:
            def __init__(self):self.calls=[]
            def __call__(self):self.calls.append('factory');return 'original-session'
            def execute(self,*args):self.calls.append(args);return 'original-result'
        class Native:
            def execute(self,*_args,**_kwargs):return SimpleNamespace()
        for alias in ('Session','SessionR','SessionC','SessionReadCMS','WriteDbConn.Session'):
            original=Original();proxy=RoutedSession(original)
            self.assertIsInstance(proxy,Original)
            self.assertEqual(proxy(),'original-session')
            frame=FRAME.set(SimpleNamespace());current=CURRENT.set(TransactionSession(Native()))
            try:
                self.assertIs(proxy(),CURRENT.get())
                self.assertIsNotNone(proxy.execute('SELECT 1'))
                self.assertEqual(original.calls,['factory'])
                self.assertIsNone(proxy.close())
            finally:CURRENT.reset(current);FRAME.reset(frame)
            self.assertEqual(proxy.execute('SELECT 2'),'original-result',alias)

    def test_all_eight_source_cache_aliases_cannot_publish(self):
        for alias in SOURCE_REDIS_ALIASES:
            class Original:
                def __init__(self):self.calls=[]
                def __getattr__(self,name):
                    def call(*_args,**_kwargs):self.calls.append(name);return 'original'
                    return call
            original=Original();proxy=RoutedCache(original)
            token=FRAME.set(SimpleNamespace())
            try:
                self.assertEqual(proxy.get('opaque-key'),'original')
                for method in ('set','setex','delete','eval','evalsha','pipeline','transaction','execute_command','register_script'):
                    self.assertIs(getattr(proxy,method)('private-canary'),False,alias+':'+method)
                self.assertEqual(original.calls,['get'])
            finally:FRAME.reset(token)
            self.assertEqual(proxy.set('original'),'original')

    def test_selected_tasks_and_logs_never_reach_the_original(self):
        class Original:
            def __getattr__(self,_name):raise AssertionError('Selected frame escaped')
        token=FRAME.set(SimpleNamespace())
        try:
            RoutedLogger(Original()).exception('body-header-contact-canary')
            with self.assertRaises(Exception):RoutedTasks(Original()).unsupported.delay('canary')
        finally:FRAME.reset(token)

    def test_projection_executes_the_literal_source_gst_block(self):
        calls=[]
        def inclusive(row):calls.append(row['prod_id']);row['price']+=5
        project=projection(SOURCE,{'json':json,'get_gst_status_from_redis':lambda _session:False,'cart_inclusive_gst':inclusive})
        payload={'products':{'items':[{'prod_id':390238,'price':25}]},'meta':{'items':[{'name':'exclusive_user','cart':{'prod_id':42,'price':10}}]}}
        cart=SimpleNamespace(json=lambda **_kwargs:json.dumps(payload))
        result=project(cart,{'user_id':77},SimpleNamespace(context={'session':object()}))
        self.assertEqual(calls,[390238,42]);self.assertEqual(result['products']['items'][0]['price'],30)
        self.assertEqual(payload['products']['items'][0]['price'],25)

    def test_invalid_capability_has_no_private_traceback_chain(self):
        canary='header-cookie-phone-price-canary'
        try:verify(canary,'private-source-context-key-'.join(['key']*5),1781505000000)
        except ScreeningWriterError as error:
            formatted=''.join(traceback.format_exception(error))
            self.assertNotIn(canary,formatted)
            self.assertIsNone(error.__cause__)
            self.assertTrue(error.__suppress_context__)

    def test_generated_patch_preserves_original_pos_order_statements(self):
        spec=importlib.util.spec_from_file_location('public_prepare',ROOT/'compatibility/upstream/public-screening-writer/prepare.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        outputs=module.outputs();manifest=json.loads(outputs['manifest.json'])
        self.assertFalse(manifest['activated'])
        self.assertEqual(manifest['sourceCommit'],'2960acbea10c4eaf16b6d99e15ff6e03ef7724c5')
        patch=outputs['public-pos-screening.patch']
        self.assertEqual(patch.count('+        after_validate(req)'),1)
        self.assertIn('+middleware = [_node_screening, _screening_origins, DatabaseManager(',patch)
        self.assertIn('+_screening_origins.register(app, settings)',patch)
        self.assertIn('+app = _screening_origins.coupon_control_application(app, _origin_event_stream.stdout)',patch)
        self.assertEqual(patch.count('-        ValidateCheckout().on_post(req, resp)'),0)

    def test_reviewed_global_mapping_preserves_default_constructors_and_scoped_dates(self):
        from source_template import source_models
        from model_compat import install_model_codec
        from transaction import normalize_source_sentinels
        models=source_models(SOURCE);order=models['OrderModel'];store=models['OrderStoreModel'];line=models['HasProductModel']
        original_dates={name:order.__table__.c[name].default.arg for name in ('ship_date','ret_ex_request_date')}
        install_model_codec(order,store,line)
        self.assertEqual(order.__table__.c.reward_points_cron.default.arg,'0')
        self.assertEqual(order.__table__.c.ship_flag.default.arg,'0')
        self.assertEqual(store.__table__.c.message.default.arg,'')
        self.assertEqual(line.__table__.c.return_qty.default.arg,'')
        self.assertEqual({name:order.__table__.c[name].default.arg for name in original_dates},original_dates)
        unrelated=order(ship_date='',ret_ex_request_date='',courier='')
        normalize_source_sentinels(SimpleNamespace(new=[unrelated]),None,None)
        self.assertEqual((unrelated.ship_date,unrelated.ret_ex_request_date,unrelated.courier),('','',''))
        selected=order(ship_date='',ret_ex_request_date='',courier='')
        token=CURRENT.set(object())
        try:normalize_source_sentinels(SimpleNamespace(new=[selected]),None,None)
        finally:CURRENT.reset(token)
        self.assertEqual(selected.courier,0)
        self.assertIsNotNone(selected.ship_date)
        self.assertEqual(str(selected.ship_date),'NULL')


if __name__=='__main__':unittest.main()
