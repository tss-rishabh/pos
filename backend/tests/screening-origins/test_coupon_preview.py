"""Real coupon A→B hydration/mutation inside the genuine cart-only preview."""
import copy
import json
import os
import unittest
from sqlalchemy import text
from preview_fixture import Fixture
from coupon_fixture import enable
from origin_contracts import OriginReview

URL=os.environ.get('ORIGIN_PREVIEW_MYSQL_TEST_URL')


@unittest.skipUnless(URL,'Explicit disposable native origin URL required')
class CouponPreviews(unittest.TestCase):
    def setUp(self):self.fixture=Fixture(URL)
    def tearDown(self):self.fixture.close()
    def mutation(self,req,resp,code='FIXTURE_B'):
        def call():
            cart=req.context['cart']
            previous=cart.get_item(self.fixture.cart_module.ItemTypes.META,{'name':'coupon'})
            self.assertEqual(previous['coupon_id'],7)
            cart.update({'type':'meta','data':{'name':'coupon','coupon':code}})
            resp.text=cart.json()
        return call
    def saved_coupon(self):
        with self.fixture.engine.connect() as connection:
            value=connection.execute(text("SELECT value FROM cart_meta WHERE cart_id='cart_77' AND name='meta'")).scalar_one()
            return [item for item in json.loads(value)['items'] if item.get('name')=='coupon']
    def test_current_only_a_to_b_runs_original_validation_without_history_or_order(self):
        f=self.fixture;enable(f,historical=False);req,resp=f.request()
        f.execute(req,resp,self.mutation(req,resp))
        self.assertEqual(f.coupon_calls,[]);self.assertEqual(self.saved_coupon()[0]['coupon_id'],8)
        with f.engine.connect() as connection:self.assertEqual(connection.execute(text('SELECT COUNT(*) FROM pos_rewrite_screening_origin_commands')).scalar_one(),0)
    def test_incoming_historical_b_unwinds_before_bq_then_replays_same_preview(self):
        f=self.fixture;enable(f);req,resp=f.request()
        f.execute(req,resp,self.mutation(req,resp))
        self.assertEqual(len(f.coupon_calls),1);request=f.coupon_calls[0]
        self.assertEqual(request['selection']['couponId'],'8')
        self.assertEqual(request['preview']['purpose'],'cart-mutation')
        self.assertEqual(request['preview']['previewId'],resp.headers['X-TSS-Screening-Preview'])
        self.assertEqual(self.saved_coupon()[0]['coupon_id'],8)
        self.assertFalse(any('FROM orders' in query or 'FROM order_coupon_log' in query for query in f.sql))
    def test_forged_document_refuses_and_keeps_original_native_a(self):
        f=self.fixture;enable(f);req,resp=f.request()
        def tamper(document):
            result=copy.deepcopy(document);result['facts']['globalUsage']='1';return result
        f.coupon_document_mutator=tamper
        with self.assertRaises(OriginReview):f.execute(req,resp,self.mutation(req,resp))
        self.assertEqual(len(f.coupon_calls),1)
        self.assertEqual(self.saved_coupon(),[{'name':'coupon','coupon':'FIXTURE_A'}])
        with f.engine.connect() as connection:self.assertEqual(connection.execute(text('SELECT COUNT(*) FROM pos_rewrite_screening_origin_cart_previews')).scalar_one(),0)
    def test_missing_incoming_code_takes_original_invalid_coupon_removal(self):
        f=self.fixture;enable(f);req,resp=f.request()
        f.execute(req,resp,self.mutation(req,resp,'MISSING_FIXTURE_CODE'))
        self.assertEqual(self.saved_coupon(),[]);self.assertEqual(f.coupon_calls,[])


if __name__=='__main__':unittest.main()
