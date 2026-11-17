"""Exact original history criteria with purpose-bound synthetic publications."""
import copy
from datetime import datetime
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
from membership_history import CONTRACT,signature
from membership_profile import CONTEXT,compile_free_membership
from protocol import ImportReview
SOURCE=HERE.parents[4]/'backend-tss-api_v2';KEY='isolated-purpose-specific-membership-history-key-012345'
class Clock:
    @staticmethod
    def now():return datetime(2026,6,15,12,0,0)
class K:PRODUCTS=1;META=2
class Session:
    def execute(self,*_args,**_kwargs):raise AssertionError('History fell back to MySQL')
class Port:
    def __init__(self,last,recent,mutate=None):self.last,self.recent,self.mutate=last,recent,mutate;self.calls=[]
    def read(self,query):
        self.calls.append(copy.deepcopy(query))
        body={'scope':copy.deepcopy(query),'reader':'bigquery','generationId':'a'*64,'complete':True,'fetchedAt':int(time.time()*1000),'lastDeliveredOrder':self.last,'recentDeliveredOrders':self.recent}
        if self.mutate:self.mutate(body)
        return {**body,'signature':signature(body,KEY)}
def order(date='2026-06-01 12:00:00',method=14,flag=1,member=False):
    return {'id':'9007199254740993','paymentMethod':method,'createdAt':date,'lines':[{'lineId':'9007199254740994','productId':'10' if member else '11','isExclusiveOrder':flag}]}
def criteria(last,recent,mutate=None):
    cls=compile_free_membership(SOURCE,{'FREE_EXCLUSIVE_PRODUCT':10,'EXCLUSIVE_PRODUCT':{'10':{'expiry_delta':90}},'MEMBERSHIP_PROD_ID':['10'],
        'BAMBOO_TOOTHBRUSH_EM':999,'ItemTypes':K,'PaymentMethod':SimpleNamespace(DCC=SimpleNamespace(value=10)),
        'datetime':Clock,'timedelta':__import__('datetime').timedelta,'logger':SimpleNamespace(debug=lambda *_a:None)})
    port=Port(last,recent,mutate);state={'historyReader':port,'user':{'user_id':77},'capability':{'operationId':'5a5d1efb-727e-45ea-b214-9136be787031','requestHash':'b'*64,'planHash':'c'*64}}
    token=CONTEXT.set(state)
    try:
        value=cls(Session(),None,{},None,{'user_id':77});value.cart_value=1999;value.number_of_items=1
        with patch.dict(os.environ,{'POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY':KEY}):result=value.check_criteria()
        assert len(port.calls)==1
        return result,state
    finally:CONTEXT.reset(token)
class Cases(unittest.TestCase):
    def test_original_source_history_vectors(self):
        vectors=[(None,[],False),(order('2026-01-01 00:00:00',10,1),[],True),
                 (order('2026-01-01 00:00:00',10,0),[],False),(order('2026-01-01 00:00:00',14,1),[],False),
                 (order(flag=1),[order(flag=1)],True),(order(flag=0),[order(flag=0)],False),
                 (order(member=True),[order(member=True)],True)]
        for last,recent,expected in vectors:
            result,state=criteria(last,recent);self.assertEqual(result,expected)
            self.assertEqual(state['eligibility'],'source-qualified-history');self.assertEqual(state['historyEvidence']['cutoff'],'2026-05-01 12:00:00')
    def test_mixed_unordered_hp_flags_are_reviewed(self):
        row=order();row['lines'].append({'lineId':'9007199254740995','productId':'12','isExclusiveOrder':0})
        with self.assertRaises(ImportReview) as error:criteria(row,[row])
        self.assertEqual(error.exception.code,'ORDER_IMPORT_MEMBERSHIP_HISTORY_AMBIGUOUS')
    def test_scope_generation_completeness_and_freshness_are_not_optional(self):
        def changed_scope(body):body['scope']['customerId']='88'
        def stale(body):body['fetchedAt']-=60001
        def future(body):body['fetchedAt']+=60001
        def missing_generation(body):body['generationId']=''
        def partial(body):body['complete']=False
        for mutation in (changed_scope,stale,future,missing_generation,partial):
            with self.assertRaises(ImportReview):criteria(None,[],mutation)
    def test_absence_recent_latest_and_tied_dates_cannot_be_fabricated(self):
        with self.assertRaises(ImportReview):criteria(order(),[])
        row=order();duplicate={**row,'id':'9007199254740997'}
        with self.assertRaises(ImportReview):criteria(row,[row,duplicate])
if __name__=='__main__':unittest.main()
