"""Literal source replacement and tender refusal; synthetic catalog/current stock.

This control-flow oracle does not certify source startup, PosOrder or providers.
The imported fixture executes the pinned Cart, eligibility and calculator bodies.
"""
import copy
from contextlib import contextmanager
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

BACKEND=Path(__file__).resolve().parents[2]
COMMON=BACKEND/'compatibility/upstream/legacy-order-imports'
sys.path.insert(0,str(COMMON))
sys.path.insert(0,str(BACKEND/'tools/legacy-import-preparation'))
from membership_profile import CONTEXT,MembershipProfile
from correction_profile import CalculatedImportReview
from profiles import assert_plain_profile
from protocol import ImportReview
from transaction import private_session,VIOLATION
from cart_preparation import read_only_preview
from effects import CAPTURE
from source_fixture import pipeline,pinned_source,K
from test_source import Session,cap,handoff,plan,HISTORY

ROOT=Path(os.environ['POS_LEGACY_IMPORT_SOURCE_ROOT'])


class StockSession(Session):
    def execute(self,statement,params):
        if 'FROM product_store ' in str(statement):
            self.sql.append(' '.join(str(statement).split()))
            if params!={'store':'1','id':'12'}:
                raise AssertionError('Unclassified replacement stock read')
            return SimpleNamespace(mappings=lambda:SimpleNamespace(fetchmany=lambda _limit:[
                {'stock':10,'is_avail':1,'is_del':0}]))
        return super().execute(statement,params)


class Replacement(unittest.TestCase):
    @contextmanager
    def exercise(self,ordinary='25.49',eligible=True,quantity=1):
        value=plan([(10,quantity,'100.00'),(11,1,ordinary)])
        for number,line in enumerate(value['lines'],2):line['sourceRows']=[number]
        value['originalTenderAmount']='125.49' if ordinary=='25.49' else '2400.00'
        original=copy.deepcopy(value)
        native=StockSession();trace=[];runtime=pipeline(ROOT,value,trace)
        profile=object.__new__(MembershipProfile)
        profile.settings=SimpleNamespace(EXCLUSIVE_PRODUCT={'10':{},'12':{}},
            EXCLUSIVE_UPGRADE_PRODUCT={},FREE_EXCLUSIVE_PRODUCT='12')
        actor={'user_id':77,'is_exclusive':False,'email':'fixture@example.test'}
        with handoff(value,eligible) as history,private_session(native) as session:
            state={'profile':profile,'session':session,'user':actor,'plan':value,
                'capability':cap(value),'historyReader':history,'eligibility':'not-added',
                'historyEvidence':None,'extras':[],'kind':None,'replacement':None}
            token=CONTEXT.set(state);effects=[];capture=CAPTURE.set(effects)
            try:
                with patch.dict(os.environ,{'POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY':HISTORY}),read_only_preview():
                    _req,_resp,cart,_base=runtime._cart_pipeline(session,actor,value,cap(value))
                calculation=cart.get_item(K.META,{'name':'calculations'})
                yield profile,state,cart,calculation,value
                self.assertEqual(value,original)
                self.assertEqual(effects,[])
                self.assertFalse(any('FROM orders' in query or 'FROM has_products' in query for query in native.sql))
            finally:
                CAPTURE.reset(capture);CONTEXT.reset(token)

    def test_literal_paid_to_free_removal_preserves_plan_and_requires_tender_correction(self):
        for ordinary,payable,eligibility in (
                ('25.49','25.00','source-qualified-history'),
                ('2300.00','2300.00','source-cart-over-2000')):
            with self.subTest(ordinary=ordinary),self.exercise(ordinary) as result:
                profile,state,cart,calculation,value=result
                self.assertEqual([row['prod_id'] for row in cart.get(K.PRODUCTS)],[11,12])
                self.assertEqual(state['replacement']['sourceAction'],'AddFreeMembership.remove_exclusive_membership')
                self.assertEqual(state['replacement']['originalLine'],value['lines'][0])
                self.assertEqual(state['eligibility'],eligibility)
                with self.assertRaises(CalculatedImportReview) as error:
                    assert_plain_profile(cart,K,profile.settings,value,calculation)
                self.assertEqual(error.exception.payable,payable)
                self.assertEqual(error.exception.code,'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH')
                self.assertEqual(state['kind'],'auto-free')
                self.assertEqual(state['extras'],[{'productId':'12','quantity':1,'unitPrice':'0.00'}])

    def test_matching_final_quantities_without_literal_removal_causality_are_refused(self):
        with self.assertRaises(ImportReview) as error:
            with self.exercise() as result:
                profile,state,cart,calculation,value=result
                state['replacement']=None
                assert_plain_profile(cart,K,profile.settings,value,calculation)
        self.assertEqual(error.exception.code,'ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')

    def test_original_unqualified_history_preserves_paid_membership_and_plan(self):
        with self.exercise(eligible=False) as result:
            profile,state,cart,_calculation,value=result
            self.assertEqual([row['prod_id'] for row in cart.get(K.PRODUCTS)],[10,11])
            self.assertIsNone(state['replacement'])
            self.assertEqual(profile.admit(cart,K,value),[])
            self.assertEqual(state['kind'],'new')

    def test_multi_quantity_original_member_remains_explicitly_unqualified(self):
        with self.assertRaises(ImportReview) as error:
            with self.exercise(quantity=2):
                # Original process() swallows Exception. Its failed removal
                # must still invalidate the enclosing private transaction.
                self.assertTrue(VIOLATION.get())
        self.assertEqual(error.exception.code,'ORDER_IMPORT_UNQUALIFIED_SQL')


if __name__=='__main__':
    with pinned_source(ROOT) as selected:
        ROOT=selected
        unittest.main()
