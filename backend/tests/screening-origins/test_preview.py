"""Native source cart previews and genuine pre-command member decisions."""
import copy
import ast
import json
import os
import sys
import unittest
from datetime import datetime,timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID
from sqlalchemy import text

from preview_fixture import Fixture,KEY,SOURCE,ROOT,Response
from origin_contracts import OriginReview
from origin_frame import CURRENT_ORIGIN
from transaction import CURRENT
import origin_preview

URL=os.environ.get('ORIGIN_PREVIEW_MYSQL_TEST_URL')


@unittest.skipUnless(URL,'Explicit disposable native origin URL required')
class SourcePreviews(unittest.TestCase):
    def setUp(self):self.fixture=Fixture(URL)
    def tearDown(self):self.fixture.close()
    def scalar(self,statement):
        with self.fixture.engine.connect() as connection:return connection.execute(text(statement)).scalar_one()
    def cart_call(self,req,resp,*,membership=False,effect=False):
        f=self.fixture
        def call():
            cart=req.context['cart']
            self.assertEqual(type(cart).__name__,'Cart')
            self.assertIsNotNone(CURRENT.get());self.assertIsNotNone(CURRENT_ORIGIN.get())
            cart.update({'type':'products','data':{'prod_id':390238,'quantity':2}})
            if membership:
                body=json.loads(cart.json(persist=False))
                f.cart_module.AddFreeMembership(req.context['session'],cart,body,req.context['data'],req.context['user']).process()
            if effect:
                from origin_effects import Task
                Task('sendFacebookEvents').delay({'fixture':'private-cart-effect-canary'})
            resp.text=cart.json()
        return call
    def test_middleware_defers_actual_cart_before_command_and_commits_only_cart(self):
        f=self.fixture;req,resp=f.request()
        f.middleware.CartMiddleware().process_request(req,resp)
        f.active.ActiveCartMiddleware().process_request(req,resp)
        self.assertTrue(req.context['_origin_deferred_cart'])
        self.assertNotIn('cart',req.context)
        f.execute(req,resp,self.cart_call(req,resp))
        self.assertEqual(self.scalar("SELECT quantity FROM cart_items WHERE cart_id='cart_77'"),2)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_commands'),0)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_cart_previews'),1)
        self.assertEqual(str(UUID(resp.headers['X-TSS-Screening-Preview'])),resp.headers['X-TSS-Screening-Preview'])
        self.assertEqual(f.provider_calls,0)
    def test_literal_membership_fetches_outside_sql_then_replays_without_old_sql(self):
        f=self.fixture;req,resp=f.request()
        f.execute(req,resp,self.cart_call(req,resp,membership=True))
        self.assertEqual(f.provider_calls,1)
        self.assertEqual(self.scalar("SELECT quantity FROM cart_items WHERE cart_id='cart_77'"),2)
        self.assertFalse(any('FROM orders WHERE  user_id' in query or 'is_exclusive_order FROM has_products' in query for query in f.sql))
        self.assertIsNone(CURRENT.get());self.assertIsNone(CURRENT_ORIGIN.get())
    def test_pinned_cart_controller_reaches_original_member_criteria_before_order_command(self):
        from source_fixture import pipeline
        f=self.fixture;req,resp=f.request()
        plan={'kind':'offline','createdAt':'2026-06-15 12:00:00','lines':[{'productId':'390238','quantity':1,'unitPrice':'25.00'}],'originalTenderAmount':'25.00'}
        source=pipeline(SOURCE,plan,[]).cart_reader.source
        namespace=source.on_post.__func__.__globals__
        namespace.update(ItemTypes=f.cart_module.ItemTypes,AddFreeMembership=f.cart_module.AddFreeMembership,copy=copy)
        helpers=[node for node in ast.parse((SOURCE/'controllers/CartController.py').read_bytes()).body
            if isinstance(node,ast.FunctionDef) and node.name in ('clone_cart','apply_active_cart','apply_selected_calculations','delete_product_from_cart')]
        helpers.extend(node for node in ast.parse((SOURCE/'libs/helper.py').read_bytes()).body
            if isinstance(node,ast.FunctionDef) and node.name=='validate_cart_products')
        namespace['cms_redis_object']=SimpleNamespace(get=lambda _key:None)
        exec(compile(ast.Module(body=helpers,type_ignores=[]),'<pinned-selected-cart-helpers>','exec'),namespace)
        f.execute(req,resp,lambda:source.on_post(req,resp))
        self.assertEqual(resp.status,'200 OK')
        self.assertEqual(f.provider_calls,1)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_commands'),0)
    def test_authority_change_while_bq_is_inflight_preserves_original_cart(self):
        f=self.fixture;req,resp=f.request()
        def changed():
            with f.engine.begin() as connection:connection.execute(text("UPDATE users SET email='changed@example.test' WHERE id=77"))
        f.principal_changes=changed
        with self.assertRaisesRegex(OriginReview,'original screening command'):
            f.execute(req,resp,self.cart_call(req,resp,membership=True))
        self.assertEqual(f.provider_calls,1)
        self.assertEqual(self.scalar("SELECT quantity FROM cart_items WHERE cart_id='cart_77'"),1)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_cart_previews'),0)
    def test_cart_cas_change_while_bq_is_inflight_preserves_newer_cart(self):
        f=self.fixture;req,resp=f.request()
        def changed():
            with f.engine.begin() as connection:connection.execute(text("UPDATE cart_items SET quantity=7 WHERE cart_id='cart_77'"))
        f.principal_changes=changed
        with self.assertRaises(OriginReview):f.execute(req,resp,self.cart_call(req,resp,membership=True))
        self.assertEqual(self.scalar("SELECT quantity FROM cart_items WHERE cart_id='cart_77'"),7)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_cart_previews'),0)
    def test_original_cart_rehearsal_rolls_back_forbidden_native_effect(self):
        f=self.fixture;req,resp=f.request()
        def call():req.context['session'].execute('UPDATE users SET tss_money=999 WHERE id=77')
        with self.assertRaises(OriginReview):f.execute(req,resp,call)
        self.assertEqual(self.scalar('SELECT tss_money FROM users WHERE id=77'),0)
        self.assertEqual(self.scalar("SELECT quantity FROM cart_items WHERE cart_id='cart_77'"),1)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_cart_previews'),0)
    def test_real_customer_jwt_and_current_native_block_are_required(self):
        f=self.fixture;req,resp=f.request();req.auth=req.auth[:-4]+'xxxx'
        with self.assertRaises(OriginReview):f.execute(req,resp,self.cart_call(req,resp))
        req,resp=f.request()
        with f.engine.begin() as connection:connection.execute(text('UPDATE users SET is_block=1 WHERE id=77'))
        with self.assertRaises(OriginReview):f.execute(req,resp,self.cart_call(req,resp))
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_cart_previews'),0)
    def test_literal_over_2000_does_not_require_history(self):
        f=self.fixture
        with f.engine.begin() as connection:connection.execute(text('UPDATE products SET price=2100 WHERE id=390238'))
        req,resp=f.request();f.owner.membership_history_provider=None
        f.execute(req,resp,self.cart_call(req,resp,membership=True))
        self.assertEqual(f.provider_calls,0)
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM cart_items WHERE cart_id='cart_77' AND prod_id=12 AND status='active'"),1)
    def test_active_member_removes_stale_free_sku_without_requesting_history(self):
        f=self.fixture;f.owner.membership_history_provider=None
        with f.engine.begin() as connection:
            connection.execute(text("INSERT INTO user_eav(entity,attribute,value,is_active) VALUES('fixture@example.test','EXCLUSIVE_MEMBER','1',1)"))
            connection.execute(text("INSERT INTO cart_items(cart_id,prod_id,user_id,quantity,`select`,print_name,status,added_at) VALUES('cart_77',12,77,1,1,'','active','2026-06-15')"))
        req,resp=f.request();f.execute(req,resp,self.cart_call(req,resp,membership=True))
        self.assertEqual(f.provider_calls,0)
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM cart_items WHERE cart_id='cart_77' AND prod_id=12 AND status='active'"),0)
    def test_no_ordinary_items_preserves_literal_free_row_removal_without_history(self):
        f=self.fixture;f.owner.membership_history_provider=None
        with f.engine.begin() as connection:connection.execute(text("UPDATE cart_items SET prod_id=12 WHERE cart_id='cart_77'"))
        req,resp=f.request()
        def call():
            cart=req.context['cart'];body=json.loads(cart.json(persist=False))
            f.cart_module.AddFreeMembership(req.context['session'],cart,body,req.context['data'],req.context['user']).process()
            resp.text=cart.json()
        f.execute(req,resp,call)
        self.assertEqual(f.provider_calls,0)
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM cart_items WHERE cart_id='cart_77' AND status='active'"),0)
    def test_both_original_order_paths_refuse_unqualified_saved_free_sku_before_admission(self):
        # Each genuine origin is exercised with its own exact native actor/JWT
        # scope. No Source Order row or simulated paid receipt is needed.
        for kind in ('customer','pos'):
            with self.subTest(kind=kind):
                f=self.fixture if kind=='customer' else Fixture(URL)
                try:
                    with f.engine.begin() as connection:
                        connection.execute(text("INSERT INTO cart_items(cart_id,prod_id,user_id,quantity,`select`,print_name,status,added_at) VALUES('cart_77',12,77,1,1,'','active','2026-06-15')"))
                    req,resp,value=f.final_request(kind);entered=[]
                    source=f.original_order(kind,lambda *_a:entered.append('original-validation'))
                    with self.assertRaises(OriginReview) as refusal:
                        f.owner.order(req,resp,kind,lambda:source.on_post(req,resp))
                    self.assertEqual(refusal.exception.code,'SCREENING_ORIGIN_QUOTE_CHANGED')
                    self.assertEqual(entered,[]);self.assertEqual(f.provider_calls,2) # command count + true-command member document
                    with f.engine.connect() as connection:
                        self.assertEqual(connection.execute(text('SELECT phase FROM pos_rewrite_screening_origin_commands WHERE id=:id'),{'id':value['id']}).scalar_one(),'REJECTED')
                        self.assertEqual(connection.execute(text('SELECT COUNT(*) FROM pos_rewrite_screening_origin_creations')).scalar_one(),0)
                        self.assertEqual(connection.execute(text("SELECT COUNT(*) FROM cart_items WHERE prod_id=12 AND status='active'")).scalar_one(),1)
                finally:
                    if f is not self.fixture:f.close()
    def test_both_original_order_paths_keep_eligible_reviewed_free_sku_and_reach_validation(self):
        class BeforeFinancialCreation(Exception):pass
        for kind in ('customer','pos'):
            with self.subTest(kind=kind):
                f=self.fixture if kind=='customer' else Fixture(URL)
                try:
                    with f.engine.begin() as connection:
                        connection.execute(text('UPDATE products SET price=2100 WHERE id=390238'))
                        connection.execute(text("INSERT INTO cart_items(cart_id,prod_id,user_id,quantity,`select`,print_name,status,added_at) VALUES('cart_77',12,77,1,1,'','active','2026-06-15')"))
                    req,resp,value=f.final_request(kind);entered=[]
                    def boundary(_req,_resp):
                        entered.append('original-validation')
                        raise BeforeFinancialCreation()
                    source=f.original_order(kind,boundary)
                    with self.assertRaises(BeforeFinancialCreation):f.owner.order(req,resp,kind,lambda:source.on_post(req,resp))
                    self.assertEqual(entered,['original-validation']);self.assertEqual(f.provider_calls,1)
                    self.assertEqual(f.original_counter_calls,[{'user_id':77,'sku':390238}])
                    with f.engine.connect() as connection:
                        self.assertEqual(connection.execute(text('SELECT phase FROM pos_rewrite_screening_origin_commands WHERE id=:id'),{'id':value['id']}).scalar_one(),'PREPARED')
                        self.assertEqual(connection.execute(text('SELECT COUNT(*) FROM pos_rewrite_screening_origin_closures')).scalar_one(),0)
                        self.assertEqual(connection.execute(text('SELECT COUNT(*) FROM pos_rewrite_screening_origin_creations')).scalar_one(),0)
                finally:
                    if f is not self.fixture:f.close()
    def test_final_original_order_qualifies_existing_free_sku_from_true_command_history(self):
        class BeforeFinancialCreation(Exception):pass
        f=self.fixture
        with f.engine.begin() as connection:
            connection.execute(text("INSERT INTO cart_items(cart_id,prod_id,user_id,quantity,`select`,print_name,status,added_at) VALUES('cart_77',12,77,1,1,'','active','2026-06-15')"))
        req,resp,_value=f.final_request();entered=[]
        def selection(scope):
            delivered={'id':'800','paymentMethod':f.cart_module.PaymentMethod.DCC.value,
                'createdAt':(datetime.strptime(scope['asOf'],'%Y-%m-%d %H:%M:%S')-timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S'),
                'lines':[{'lineId':'900','productId':'390238','isExclusiveOrder':1}]}
            return {'lastDeliveredOrder':delivered,'recentDeliveredOrders':[delivered]}
        f.member_selection=selection
        def boundary(_req,_resp):entered.append(True);raise BeforeFinancialCreation()
        source=f.original_order('customer',boundary)
        with self.assertRaises(BeforeFinancialCreation):f.owner.order(req,resp,'customer',lambda:source.on_post(req,resp))
        self.assertEqual(entered,[True]);self.assertEqual(f.provider_calls,2)
        self.assertFalse(any('FROM orders WHERE  user_id' in query or 'is_exclusive_order FROM has_products' in query for query in f.sql))
    def test_final_history_head_change_refuses_before_original_validation_or_quota(self):
        f=self.fixture;req,resp,value=f.final_request();entered=[]
        def changed():
            with f.engine.begin() as connection:connection.execute(text('UPDATE fixture_member_head SET revision=revision+1 WHERE customer_id=77'))
        f.principal_changes=changed
        source=f.original_order('customer',lambda *_args:entered.append(True))
        with self.assertRaises(OriginReview):f.owner.order(req,resp,'customer',lambda:source.on_post(req,resp))
        self.assertEqual(entered,[]);self.assertEqual(f.provider_calls,2)
        with f.engine.connect() as connection:
            self.assertEqual(connection.execute(text('SELECT phase FROM pos_rewrite_screening_origin_commands WHERE id=:id'),{'id':value['id']}).scalar_one(),'PREPARED')
            self.assertEqual(connection.execute(text('SELECT COUNT(*) FROM pos_rewrite_screening_origin_creations')).scalar_one(),0)
    def test_deferred_original_task_is_journaled_with_the_same_cart_commit(self):
        f=self.fixture;req,resp=f.request();f.execute(req,resp,self.cart_call(req,resp,effect=True))
        identity=resp.headers['X-TSS-Screening-Preview']
        with f.sessions() as session:
            _row,receipt,effects,deliveries=origin_preview.load(session,identity,KEY)
        self.assertEqual(receipt['preview']['purpose'],'cart-mutation')
        self.assertEqual(effects[0]['call']['name'],'sendFacebookEvents');self.assertEqual(deliveries,[])
        self.assertNotIn('private-cart-effect-canary',json.dumps(receipt))
    def test_original_deferred_consumer_executes_once_and_replays_saved_result(self):
        from origin_delivery import OriginEffectRegistry
        from origin_consumer import install
        from preview_fixture import module
        class Ignore(Exception):pass
        module('celery.exceptions',{'Ignore':Ignore})
        f=self.fixture;req,resp=f.request();f.execute(req,resp,self.cart_call(req,resp,effect=True))
        identity=resp.headers['X-TSS-Screening-Preview'];messages=[];executed=[]
        class Task:
            request=SimpleNamespace(headers={})
            def run(self,value):
                self_test.assertFalse(f.leased);executed.append(value);return {'observed':'original-body'}
            def apply_async(self,args,kwargs,**options):
                messages.append((args,kwargs,options));return SimpleNamespace(id='fixture-confirmed-broker-ack')
        self_test=self;task=Task()
        registry=object.__new__(OriginEffectRegistry);registry.owner=f.owner
        registry.tasks=SimpleNamespace(sendFacebookEvents=task,route=lambda _task,options,_args,_kwargs:options)
        install(SimpleNamespace(registry=registry,runtime=f.owner))
        self.assertEqual(origin_preview.dispatch(f.owner,identity,registry)['phase'],'COMPLETE')
        self.assertEqual(len(messages),1);self.assertEqual(executed,[])
        args,kwargs,options=messages[0];task.request.headers=options['headers']
        self.assertEqual(task.run(*args,**kwargs),{'observed':'original-body'})
        self.assertEqual(task.run(*args,**kwargs),{'observed':'original-body'})
        self.assertEqual(len(executed),1)
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM pos_rewrite_screening_origin_task_invocations WHERE phase='INVOKED'"),1)
        self.assertEqual(origin_preview.dispatch(f.owner,identity,registry)['phase'],'COMPLETE')
        self.assertEqual(len(messages),1)
    def test_uncertain_delivery_never_republishes_the_original_cart_effect(self):
        f=self.fixture;req,resp=f.request();f.execute(req,resp,self.cart_call(req,resp,effect=True))
        identity=resp.headers['X-TSS-Screening-Preview'];calls=[]
        def publish(*_args):calls.append('accepted-or-unknown');raise RuntimeError('fixture-lost-broker-ack')
        registry=SimpleNamespace(publish=publish)
        self.assertEqual(origin_preview.dispatch(f.owner,identity,registry)['phase'],'UNCERTAIN')
        self.assertEqual(origin_preview.dispatch(f.owner,identity,registry)['phase'],'UNCERTAIN')
        self.assertEqual(calls,['accepted-or-unknown'])
    def test_actual_csk_prefix_is_frozen_and_same_command_resume_does_not_repeat_it(self):
        from system_preparation import resume
        f=self.fixture;system=f.system()
        req,resp=f.request({'user':{'email':'fixture@example.test','phone':'9999999999'},'address':{},
            'order':{'order_id':'original-csk-reference','line_items':[{'sku_id':'390238','quantity':'1'}]}})
        req.headers['X-CSK-API-Key']=f.settings.CSK_API_DETAILS['key']
        system.on_post(req,resp);command=json.loads(resp.text)['commandId']
        self.assertEqual(resp.status,'202 Accepted')
        first=system.run(command)
        self.assertEqual(first['phase'],'PREPARATION_PAUSED')
        self.assertEqual(f.prefix_calls,['user','address'])
        self.assertEqual(len(f.final_calls),1)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_system_cart_prefixes'),1)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_creations'),0)
        resume(system,command,f.settings.CSK_API_DETAILS)
        second=system.run(command)
        self.assertEqual(second['phase'],'PREPARATION_PAUSED')
        self.assertEqual(f.prefix_calls,['user','address'])
        self.assertEqual(len(f.final_calls),2)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_commands'),1)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_payments'),0)
    def test_genuine_csk_key_and_current_signed_service_precede_queuing(self):
        f=self.fixture;system=f.system();req,resp=f.request({'order':{'line_items':[]}})
        req.headers['X-CSK-API-Key']='untrusted-customer-selected-prepaid'
        with self.assertRaises(Exception):system.on_post(req,resp)
        self.assertEqual(self.scalar('SELECT COUNT(*) FROM pos_rewrite_screening_origin_system_jobs'),0)
        self.assertEqual(f.prefix_calls,[])


if __name__=='__main__':unittest.main()
