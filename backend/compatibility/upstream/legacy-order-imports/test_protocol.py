"""No external services: transport/privacy/transaction/canvas boundary checks."""
import copy
import io
import json
import sys
import traceback
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from protocol import digest,verify_capability,ImportReview,source_custom_data
from tracing import TRUSTED_ACTOR
from http_app import private_application
from effects import publish_once
from fixture_broker import FixtureBroker
from transaction import private_session,guard_private_statement,guard_private_commit
from receiver import seal_effects,open_effects
from order_guard import ImportOrderGuard
from profiles import assert_plain_profile

KEY='fixture-independent-private-capability-key-0123456789'
OP='5a5d1efb-727e-45ea-b214-9136be787031'
NOW=1781505000000
PLAN={'kind':'shopify','email':'contact-canary@example.invalid','createdAt':'2026-06-15 12:00:00',
      'legacyTaxDigit':1,'shippingCharges':'7.50','currency':'USD','discountAmount':'2.00',
      'address':{'shipping_street':'private-address-canary'},'lines':[{'productId':'9007199254740993','unitPrice':'25.00','quantity':2}]}


def capability(phase='order'):
    value={'contract':'pos-legacy-order-import-source-v1','phase':phase,'operationId':OP,
           'requestHash':'a'*64,'planHash':'b'*64,'planDigest':digest(KEY,'plan',PLAN),'namespace':'pos-import-v1:'+OP,
           'scope':{'actorId':'44','operationId':OP,'storeId':'1','counterId':'3'},
           'authority':{},'nonce':'62123802-cf5f-49f1-976c-35cf1282e82b',
           'orderId':None if phase=='order' else '5001','issuedAt':NOW,'expiresAt':NOW+60000}
    return {**value,'signature':digest(KEY,'capability',value)}


class Boundaries(unittest.TestCase):
    def test_unsupported_source_profiles_fail_before_the_order_writer(self):
        types_=SimpleNamespace(PRODUCTS='products',GIFT_VOUCHERS='vouchers',COMPLEMENTARY_PRODUCTS='freebies')
        settings=SimpleNamespace(EXCLUSIVE_PRODUCT={'100':True},EXCLUSIVE_UPGRADE_PRODUCT={'101':True})
        state={'products':[{'prod_id':'9007199254740993','quantity':2}],'vouchers':[],'freebies':[]}
        cart=SimpleNamespace(get=lambda kind:state[kind])
        assert_plain_profile(cart,types_,settings,PLAN,{'total':50})
        for product,code in [('100','ORDER_IMPORT_MEMBERSHIP_PROFILE_REQUIRED'),('101','ORDER_IMPORT_MEMBERSHIP_PROFILE_REQUIRED'),
                             ('390238','ORDER_IMPORT_SCREENING_PROFILE_REQUIRED'),('999','ORDER_IMPORT_AUTO_BENEFIT_PROFILE_REQUIRED')]:
            state['products']=[{'prod_id':product,'quantity':2}]
            with self.subTest(product=product),self.assertRaises(ImportReview) as raised:
                assert_plain_profile(cart,types_,settings,PLAN,{'total':50})
            self.assertEqual(raised.exception.code,code)
        state['products']=[{'prod_id':'9007199254740993','quantity':2}]
        for field in ('used_tss_money','used_tss_points','gift_voucher_value','coupon_discount'):
            with self.subTest(field=field),self.assertRaises(ImportReview):assert_plain_profile(cart,types_,settings,PLAN,{field:1})
        state['freebies']=[{'prod_id':'42'}]
        with self.assertRaises(ImportReview):assert_plain_profile(cart,types_,settings,PLAN,{'total':50})

    def test_capability_exact_scope_purpose_time_and_plan(self):
        original=capability()
        self.assertEqual(verify_capability(KEY,original,OP,'order',PLAN,NOW)['scope']['actorId'],'44')
        cases=[(original,OP,'publication',PLAN,NOW),(original,OP,'order',PLAN,NOW+60000),
               (original,OP,'order',{**PLAN,'currency':'INR'},NOW)]
        for value,op,phase,plan,now in cases:
            with self.subTest(phase=phase,now=now),self.assertRaises(ImportReview):
                verify_capability(KEY,value,op,phase,plan,now)
        changed=copy.deepcopy(original);changed['scope']['actorId']='45'
        with self.assertRaises(ImportReview):verify_capability(KEY,changed,OP,'order',PLAN,NOW)

    def test_original_shopify_first_digit_custom_fields_are_preserved(self):
        value=source_custom_data(PLAN)
        self.assertEqual(value['tax'],1)
        self.assertEqual(value['price'],{'9007199254740993':25.0})
        self.assertEqual((value['shipping_charges'],value['currency'],value['discount_amount']),(7.5,'USD',2.0))

    def test_source_commit_flush_and_swallowed_cart_escape_taint(self):
        session=SimpleNamespace(flush=lambda:None)
        with private_session(session) as source:
            source.commit()
            with self.assertRaises(ImportReview):source.rollback()
        with self.assertRaises(ImportReview):
            with private_session(session):
                try:guard_private_statement(None,None,'UPDATE cart_meta SET data=1',None,None,None)
                except ImportReview:pass
        with self.assertRaises(ImportReview):
            with private_session(session):
                try:guard_private_commit(session)
                except ImportReview:pass

    def test_effects_ciphertext_binds_operation_and_content(self):
        values=[{'call':{'name':'make_assign_warehouse_request','args':[5001],'kwargs':{},'options':{}}}]
        import hashlib
        from protocol import canonical
        payload=seal_effects(KEY,OP,values);body_hash=hashlib.sha256(canonical(values).encode()).hexdigest()
        self.assertEqual(open_effects(KEY,OP,payload,body_hash),values)
        for operation,seal in [(OP,'0'*64),('62123802-cf5f-49f1-976c-35cf1282e82b',body_hash)]:
            with self.assertRaises(ImportReview):open_effects(KEY,operation,payload,seal)

    def test_non_durable_queue_never_publishes(self):
        broker=FixtureBroker()
        broker.app.amqp.queues['fixture-default'].durable=False
        with self.assertRaises(ImportReview):publish_once(broker,{'call':{'name':'make_assign_warehouse_request','args':[5001],'kwargs':{},'options':{}}})
        self.assertEqual(broker.accepted,[])

    def test_private_wsgi_omits_all_sensitive_data_and_unverified_actors(self):
        class Receiver:
            def order(self,operation,body):
                verified=verify_capability(KEY,body['capability'],operation,'order',body['plan'],NOW)
                TRUSTED_ACTOR.set(verified['scope']['actorId'])
                raise RuntimeError('private-raw-error-canary')
        logs=io.StringIO();app=private_application(Receiver(),KEY,logs)
        def call(body,**changes):
            raw=json.dumps(body).encode();statuses=[]
            env={'PATH_INFO':'/internal/pos/legacy-order-imports/'+OP+'/order','REQUEST_METHOD':'POST',
                 'QUERY_STRING':'','CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(raw)),
                 'HTTP_X_POS_LEGACY_IMPORT_KEY':KEY,'HTTP_X_POS_OPERATOR_ID':'44',
                 'HTTP_X_REQUEST_ID':'fixture-request','HTTP_COOKIE':'private-cookie-canary','wsgi.input':io.BytesIO(raw),**changes}
            result=b''.join(app(env,lambda status,_headers:statuses.append(status)))
            self.assertEqual(statuses,['409 Conflict'])
            return json.loads(result)
        original={'capability':capability(),'plan':PLAN}
        self.assertEqual(call(original),{'code':'ORDER_IMPORT_SOURCE_REVIEW'})
        self.assertEqual(json.loads(logs.getvalue().splitlines()[0])['userId'],'44')
        call(original,HTTP_X_POS_LEGACY_IMPORT_KEY='private-key-canary',HTTP_X_POS_OPERATOR_ID='45')
        self.assertIsNone(json.loads(logs.getvalue().splitlines()[1])['userId'])
        call(original,QUERY_STRING='email=query-contact-canary')
        call(original,CONTENT_LENGTH='256001')
        self.assertIsNone(TRUSTED_ACTOR.get())
        for value in [KEY,'contact-canary','private-address','private-cookie','private-key','private-raw-error','query-contact',OP]:
            self.assertNotIn(value,logs.getvalue())

    def test_public_middleware_suppresses_sensitive_exception_chain(self):
        class HTTPForbidden(Exception):pass
        module=types.ModuleType('falcon');module.HTTPForbidden=HTTPForbidden
        writer=types.ModuleType('database.WriteDbConn');writer.Session=object()
        with patch.dict(sys.modules,{'falcon':module,'database':types.ModuleType('database'),'database.WriteDbConn':writer}),patch('order_guard.assert_available',side_effect=RuntimeError('private-sql-password-canary')):
            try:ImportOrderGuard().process_resource(SimpleNamespace(method='POST',context={'data':{'order_id':'5001'}}),None,None,{})
            except HTTPForbidden as error:
                rendered=''.join(traceback.format_exception(error))
            else:self.fail('Expected a closed public writer fence.')
        self.assertNotIn('private-sql-password-canary',rendered)
        self.assertIn('requires import reconciliation',rendered)

    def test_public_customer_token_cannot_supply_private_price_or_date_overrides(self):
        class HTTPForbidden(Exception):pass
        module=types.ModuleType('falcon');module.HTTPForbidden=HTTPForbidden
        writer=types.ModuleType('database.WriteDbConn');writer.Session=object()
        with patch.dict(sys.modules,{'falcon':module,'database':types.ModuleType('database'),'database.WriteDbConn':writer}):
            for value in [{'custom_created_at':'2020-01-01 00:00:00'},
                          {'custom_data':{'price':{'10':1}}},{'custom_data':{'tax':1}},
                          {'custom_data':{'currency':'USD'}}]:
                with self.subTest(fields=tuple(value)),self.assertRaises(HTTPForbidden):
                    ImportOrderGuard().process_resource(SimpleNamespace(method='POST',context={'data':value}),None,None,{})


if __name__=='__main__':unittest.main()
