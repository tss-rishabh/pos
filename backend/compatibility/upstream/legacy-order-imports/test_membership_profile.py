"""Pinned source vectors; no source service, database or transport imports."""
import ast
import copy
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from membership_profile import CONTRACT, CONTEXT, MembershipProfile, compile_free_membership, producer, selected
from profiles import assert_plain_profile
from protocol import ImportReview
from transaction import VIOLATION
SOURCE=HERE.parents[4]/'backend-tss-api_v2'

class K:
    PRODUCTS='products'; META='meta'; GIFT_VOUCHERS='vouchers'; COMPLEMENTARY_PRODUCTS='freebies'
class Cart:
    def __init__(self,products,total):self.products=copy.deepcopy(products);self.total=total
    def get(self,kind):return self.products if kind==K.PRODUCTS else []
    def get_item(self,_kind,_query):return {}
    def update(self,value):
        product=value['data'];self.products=[row for row in self.products if row['prod_id']!=product['prod_id']]+[product]
    def delete(self,value):self.products=[row for row in self.products if row['prod_id']!=value['data']['prod_id']]
class Session:
    def __init__(self):self.calls=[]
    def execute(self,statement,params=None,**_kwargs):
        self.calls.append(str(statement))
        if 'FROM tss.products' not in str(statement):raise AssertionError('Unexpected historical query')
        return SimpleNamespace(fetchone=lambda:{'prod_id':10})
    def commit(self):pass

def free_class():
    return compile_free_membership(SOURCE,{'FREE_EXCLUSIVE_PRODUCT':10,'EXCLUSIVE_PRODUCT':{'10':{'expiry_delta':90}},
        'BAMBOO_TOOTHBRUSH_EM':999,'ItemTypes':K,'logger':SimpleNamespace(debug=lambda *_a:None)})

def state():return {'eligibility':'not-added'}

class Cases(unittest.TestCase):
    def test_disabled_is_unchanged_and_partial_configuration_fails(self):
        with patch.dict(os.environ,{'POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT':''}):self.assertFalse(selected())
        with patch.dict(os.environ,{'POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT':CONTRACT,'POS_MEMBERSHIP_FRESH_READER_CONTRACT':''}):
            with self.assertRaises(ImportReview):selected()

    def test_exact_original_free_threshold_vectors_and_no_historical_sql(self):
        for total in (2000.01,2001,2300):
            cart=Cart([{'prod_id':11,'quantity':1,'price':total}],total);session=Session();captured=state();token=CONTEXT.set(captured)
            try:
                cls=free_class();value=cls(session,cart,{'products':{'items':cart.products},'meta':{'items':[{'name':'calculations','main_sub_total':total,'total_savings':0}]}},{},{'user_id':77,'is_exclusive':False})
                value.process()
                self.assertEqual([row['prod_id'] for row in cart.products],[11,10]);self.assertEqual(captured['eligibility'],'source-cart-over-2000')
                self.assertEqual(len(session.calls),1)
            finally:CONTEXT.reset(token)

    def test_unknown_old_history_is_not_empty_history_or_swallowed_success(self):
        for total in (0,1999,2000):
            cart=Cart([{'prod_id':11,'quantity':1,'price':total}],total);session=Session();token=CONTEXT.set(state());violation=VIOLATION.set(False)
            try:
                value=free_class()(session,cart,{'products':{'items':cart.products},'meta':{'items':[{'name':'calculations','main_sub_total':total,'total_savings':0}]}},{},{'user_id':77,'is_exclusive':False})
                with self.assertRaises(ImportReview) as error:value.process()
                self.assertEqual(error.exception.code,'ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED');self.assertTrue(VIOLATION.get());self.assertEqual(session.calls,[])
            finally:CONTEXT.reset(token);VIOLATION.reset(violation)

    def test_no_ordinary_items_has_same_observable_removal_without_old_history(self):
        cart=Cart([{'prod_id':10,'quantity':1,'price':0}],0);session=Session();token=CONTEXT.set(state())
        try:
            value=free_class()(session,cart,{'products':{'items':cart.products},'meta':{'items':[{'name':'calculations','main_sub_total':0,'total_savings':0}]}},{},{'user_id':77,'is_exclusive':False})
            value.process();self.assertEqual(cart.products,[]);self.assertEqual(len(session.calls),1)
        finally:CONTEXT.reset(token)

    def test_shopify_only_changes_the_exact_stage_status_domain(self):
        adapter=producer();self.assertEqual(adapter.STAGED_CONTRACT,'pos-cancellation-membership-staged-v2')
        parsed=ast.parse((HERE.parent/'pending-cancellation/membership_provenance.py').read_text())
        original=next(node for node in parsed.body if isinstance(node,ast.FunctionDef) and node.name=='membership_order_stage')
        self.assertIn("order['payment_method'] not in (3, 14)",ast.unparse(original))
        self.assertEqual(adapter.ACTIVATED_CONTRACT,'pos-cancellation-membership-provenance-v2')

    def test_runtime_compiler_reads_artifact_without_git_and_matches_reviewed_stage_block(self):
        from membership_profile import membership_order_tree
        sys.path.insert(0,str(HERE.parent/'pending-cancellation'))
        from prepare_membership_producers import api_candidates
        reference=ast.parse(api_candidates()['controllers/OrderController.py'][1])
        with patch('subprocess.check_output',side_effect=AssertionError('Runtime attempted Git')):
            actual=membership_order_tree(SOURCE)
        def stage(tree):
            return next(node for node in ast.walk(tree) if isinstance(node,ast.With) and any(
                isinstance(item.context_expr,ast.Call) and isinstance(item.context_expr.func,ast.Name) and item.context_expr.func.id=='membership_order_stage' for item in node.items))
        self.assertEqual(ast.unparse(stage(actual)),ast.unparse(stage(reference)))

    def test_original_post_cash_em_check_is_noop_for_confirmed_current_entitlement(self):
        sys.path.insert(0,str(HERE.parent/'pending-cancellation'))
        from prepare_membership_producers import source
        tree=ast.parse(source('controllers/OrderController.py'))
        node=next(item for item in tree.body if isinstance(item,ast.ClassDef) and item.name=='EmCheckView')
        written=[];row={'order_id':5001,'user_id':77,'order_date':__import__('datetime').datetime(2020,1,2),
                        'prod_id':10,'is_active':1,'has_product_id':6001}
        scope={'SessionR':object(),'settings':SimpleNamespace(EXCLUSIVE_PRODUCT={'10':{'expiry_delta':365}}),
               'fetchOne':lambda *_args,**_kwargs:row,'json':json,
               'set_exclusive_user_check':lambda *args:written.append(args)}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<pinned-original-EmCheck>','exec'),scope)
        endpoint=scope['EmCheckView']();endpoint.is_order_processed=lambda *_args:False
        endpoint.log_em_purchase_check=lambda *_args,**_kwargs:None
        req=SimpleNamespace(context={'session':object(),'data':{'order_id':5001}});response=SimpleNamespace(text='')
        endpoint.on_post(req,response);self.assertEqual(written,[])
        row['is_active']=0
        endpoint.on_post(req,response);self.assertEqual(written[0][3],row['order_date'])

    def test_membership_does_not_bypass_tender_coupon_extra_or_screening_guards(self):
        settings=SimpleNamespace(EXCLUSIVE_PRODUCT={},EXCLUSIVE_UPGRADE_PRODUCT={})
        plan={'kind':'offline','lines':[{'productId':'11','quantity':1}],'originalTenderAmount':'100.00'}
        for kind in ('tender','coupon','extra','screening'):
            products=[{'prod_id':11,'quantity':1}];calc={'total':100}
            if kind=='tender':calc['total']=99
            if kind=='coupon':calc['coupon_discount']=1
            if kind=='extra':products.append({'prod_id':12,'quantity':1})
            if kind=='screening':products=[{'prod_id':390238,'quantity':1}]
            with self.assertRaises(ImportReview):assert_plain_profile(Cart(products,100),K,settings,plan,calc)

if __name__=='__main__':unittest.main()
