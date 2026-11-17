"""Literal source lazy history/capability controls; no network or DB service.

The head port and current catalog inputs here are explicit test doubles, not a
certificate of all-writer deployment or source pricing bootstrap.
"""
import copy
import ast
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest
from contextlib import contextmanager
from datetime import date
from types import SimpleNamespace
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from unittest.mock import patch

HERE=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(HERE/'compatibility/upstream/legacy-order-imports'))
sys.path.insert(0,str(HERE/'compatibility/upstream/legacy-order-imports/benefit-profile'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from source_oracle import ROOT,POINT,Cache,coupon_row,history,source_coupon,ItemTypes,KEY
from benefit_runtime import SourceBenefits,ACTIVE
from benefit_controls import NeedCouponHistory
from benefit_source import BenefitReview
from benefit_history import seal,canonical
from coupon_handoff import PreparedCouponHistory,prepared_coupon_history,CURRENT_COUPON_HISTORY,witness_hash
from protocol import digest
from transaction import CURRENT,private_session,VIOLATION

NOW=1781505000000
SOURCE='fixture-literal-source-proof-0123456789'
AUTH='fixture-literal-source-auth-0123456789'
GUARD='fixture-literal-legacy-guard-0123456789'
OP='11111111-1111-4111-8111-111111111111'


class Result:
    def __init__(self,values):self.values=values
    def mappings(self):return self
    def fetchmany(self,count):return self.values[:count]
    def fetchone(self):return self.values[0] if self.values else None
    def fetchall(self):return self.values
    def close(self):pass


class Current:
    def __init__(self,birth=date(1990,6,10)):
        self.birth=birth;self.sql=[];self.control=coupon_row(native_hash='d'*64)
    def execute(self,query,params=None,**_options):
        sql=' '.join(str(query).lower().split());self.sql.append(sql)
        if 'from orders' in sql or 'order_coupon_log' in sql:raise AssertionError('Native historical query escaped')
        if sql.startswith('select birthdate, email from users'):return Result([{'birthdate':self.birth,'email':'synthetic@example.test'}])
        if sql.startswith('select id as coupon_id'):return Result([dict(self.control)])
        if 'from coupons_users' in sql:return Result([])
        if 'from pos_rewrite_import_birthday_guards' in sql:return Result([])
        if sql.startswith('select user_type,default_country_id'):return Result([{'user_type':2,'default_country_id':99}])
        if 'from coupon_countries' in sql:return Result([])
        if 'from has_coupons' in sql:return Result([])
        if 'from coupons_products' in sql:return Result([])
        if sql.startswith('select status, value from tss_settings'):return Result([{'status':1,'value':'birthday_coupon'}])
        if sql.startswith('select status from tss_settings'):return Result([{'status':1}])
        raise AssertionError('Unclassified literal current query')
    def flush(self):pass


class Heads:
    def __init__(self):self.captured=[];self.scoped=[];self.validated=[]
    def assert_ready(self):pass
    def capture(self,_session,scope):
        self.captured.append(copy.deepcopy(scope))
        return {'writersContract':'pos-csv-coupon-history-all-writers-v1','writersDefinitionHash':'e'*64,
            'serverUuid':'22222222-2222-4222-8222-222222222222','sourceSchema':'fixture',
            'heads':[{'kind':'controls','scopeId':'0','revision':'1'},
                     {'kind':'coupon','scopeId':scope['couponId'],'revision':'2'},
                     {'kind':'customer','scopeId':scope['customerId'],'revision':'3'}]}
    @contextmanager
    def scope(self,session,cap,scope,witness):
        if CURRENT.get() is not None:raise AssertionError('Owner SET inside source CURRENT')
        self.scoped.append((cap.get('nonce'),scope,witness))
        try:yield
        finally:
            if CURRENT.get() is not None:raise AssertionError('Owner cleanup inside source CURRENT')
    def validate_after_native(self,*values):self.validated.append(values)


class Cart:
    is_pos=True
    def __init__(self):self.meta={}
    def get_item(self,_kind,query):return self.meta.get(query['name'])
    def update(self,payload):
        item=copy.deepcopy(payload['data'])
        if getattr(self,'hydrate',None):self.hydrate(item)
        self.meta[item['name']]=item


def setup(*,active=True,birth=date(1990,6,10),selected=True,heads=True):
    current=Current(birth);cache=Cache(active=active);head=Heads()
    cap={'operationId':OP,'requestHash':'a'*64,'planHash':'b'*64,'authority':{'customerId':'77'},
         'nonce':'33333333-3333-4333-8333-333333333333'}
    environment={'POS_LEGACY_IMPORT_PROOF_KEY':SOURCE,'POS_LEGACY_IMPORT_COUPON_GUARD_KEY':GUARD,
                 'POS_LEGACY_IMPORT_BIRTHDAY_GUARD_CONTRACT':'pos-csv-birthday-cooperative-guard-v1'}
    if selected:
        environment['POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT']='pos-csv-automatic-coupon-v1'
        cap['benefitContracts']={'automaticCoupon':'pos-csv-automatic-coupon-v1'}
    settings=SimpleNamespace(IS_LINE_ITEM_ENABLED=0,BIRTHDAY_MESSAGE='birthday',EMPLOYEE_COUPON_DOMAIN_MAP={},
                             REDIS_COUPON_EXPIRY_IN_SEC=600,EXCLUSIVE_PRODUCT={})
    runtime=SourceBenefits(ROOT,settings,cache,ItemTypes,ValueError,heads=head if heads else None,
        environment=environment,clock=lambda:NOW,point_factory=lambda:POINT,zone='Asia/Kolkata')
    return runtime,current,cache,head,cap


def discovery(runtime,current,cap):
    cart=Cart();plan={'lines':[]}
    try:
        with private_session(current) as session,runtime.scope(session,{'user_id':77},plan,cap,preview=True) as invocation:
            if invocation.get_auto_apply_coupon(session)['status']:
                invocation.auto_apply_birthday_coupon(session,{'user_id':77},cart,None)
        return None
    except NeedCouponHistory as needed:return needed


def capsule(runtime,cap,needed,**facts):
    scope=needed.scope;witness=needed.witness
    document=history(**{'scope':scope,'fetchedAt':runtime.clock(),**facts})
    document['publication']['controlHeadHash']=witness_hash(scope,witness,SOURCE)
    body={k:v for k,v in document.items() if k!='signature'}
    document['signature']=seal('coupon-history',body,KEY)
    observation=runtime.guard_observation(scope)
    capability={'contract':'pos-csv-coupon-prefetch-v1','scope':scope,'generationId':document['generationId'],
        'documentHash':seal('coupon-history-document',document,KEY),
        'controlHeadHash':document['publication']['controlHeadHash'],
        'guardObservationHash':seal('birthday-observation-document',observation,KEY),'expiresAt':runtime.clock()+50000}
    value={'document':document,'capability':{**capability,'signature':seal('coupon-prefetch',capability,KEY)},
        'witness':witness,'guardObservation':observation}
    selected=copy.deepcopy(cap);selected['couponHistoryHash']=digest(AUTH,'coupon-history',value)
    return value,selected


class Runtime(unittest.TestCase):
    def tearDown(self):
        self.assertIsNone(ACTIVE.get());self.assertIsNone(CURRENT.get());self.assertIsNone(CURRENT_COUPON_HISTORY.get())
        VIOLATION.set(False)

    def test_literal_ineligible_and_disabled_paths_do_not_ask_for_any_history(self):
        for changes in ({'active':False},{'birth':date(1990,5,10)},{'birth':'0000-00-00'}):
            runtime,current,cache,heads,cap=setup(**changes)
            self.assertIsNone(discovery(runtime,current,cap))
            self.assertEqual(heads.captured,[]);self.assertEqual(cache.sets,[])
            self.assertFalse(any('from orders' in sql for sql in current.sql))

    def test_private_fresh_customer_is_the_literal_source_auth_projection_and_json_safe(self):
        from receiver import source_user
        raw=(ROOT/'middleware/AuthHandler.py').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(),'ba10581b1e3a0a20be5871777910ebbcebcec9483bdf06bfa7042b151635c241')
        tree=ast.parse(raw)
        assignments=[node.value for node in ast.walk(tree) if isinstance(node,ast.Assign)
                     and isinstance(node.value,ast.Dict) and any(ast.unparse(target)=="req.context['user']" for target in node.targets)]
        keys=next({key.value for key in value.keys} for value in assignments
                  if any(isinstance(key,ast.Constant) and key.value=='birthdate' for key in value.keys))
        original={name:None for name in keys if name not in ('user_id','is_exclusive','batch')}
        original.update(email='synthetic@example.test',birthdate=date(1990,6,10),tss_money=12.25,
            cashback=3.75,tss_points=8,username='never-copy',password='never-copy',created_at=POINT)
        user=source_user(original,'77',True)
        self.assertEqual(set(user),keys)
        self.assertEqual(user['birthdate'],'1990-06-10')
        self.assertEqual((user['tss_money'],user['cashback'],user['tss_points']),(12.25,3.75,8))
        self.assertNotIn('never-copy',json.dumps(user));self.assertNotIn('created_at',user)

    def test_literal_eligible_escape_is_bound_before_guard_claim_or_historical_sql(self):
        runtime,current,cache,heads,cap=setup();needed=discovery(runtime,current,cap)
        self.assertIsInstance(needed,NeedCouponHistory)
        self.assertEqual(needed.scope['asOf'],'2026-06-15 12:00:00')
        self.assertEqual(needed.scope['customerId'],'77')
        self.assertEqual(heads.captured,[needed.scope]);self.assertEqual(cache.sets,[])
        self.assertFalse(any(not sql.startswith('select ') for sql in current.sql))
        self.assertNotIn('email',canonical(needed.scope));self.assertNotIn('synthetic',canonical(needed.scope))

    def test_disabled_flag_does_not_even_sample_the_coupon_eligibility_clock(self):
        runtime,current,_cache,heads,cap=setup(active=False)
        runtime.point_factory=lambda:(_ for _ in ()).throw(AssertionError('Unused source clock sampled'))
        self.assertIsNone(discovery(runtime,current,cap));self.assertEqual(heads.captured,[])

    def test_unselected_or_unqualified_history_is_never_treated_as_empty(self):
        for changes,code in (({'selected':False},'ORDER_IMPORT_COUPON_PROFILE_REQUIRED'),
                             ({'heads':False},'ORDER_IMPORT_COUPON_HEADS_UNQUALIFIED')):
            runtime,current,_cache,_heads,cap=setup(**changes)
            with self.assertRaises(BenefitReview) as error:discovery(runtime,current,cap)
            self.assertEqual(error.exception.code,code)

    def test_repeated_qualified_preview_matches_literal_original_and_mints_no_claim(self):
        for facts in ({},{'globalUsage':'1000'},{'birthdayTodayUsage':'1'}):
            runtime,current,cache,heads,cap=setup();needed=discovery(runtime,current,cap)
            value,selected=capsule(runtime,cap,needed,**facts)
            original,reader,source_cache,user=source_coupon(facts=history(**facts));original_cart=Cart()
            original['auto_apply_birthday_coupon'](reader,user,original_cart,None)
            cart=Cart()
            with prepared_coupon_history(value,selected,AUTH,KEY,SOURCE,GUARD,'Asia/Kolkata',lambda:NOW):
                with private_session(current) as session,runtime.scope(session,{'user_id':77},None,selected,preview=True) as invocation:
                    user={'user_id':77,'is_exclusive':True,'email':'synthetic@example.test'}
                    cart.hydrate=lambda item:invocation.set_attributes_for_coupon(item,invocation.get_valid_coupon(session,item['coupon'],None,user,is_pos=True))
                    invocation.get_auto_apply_coupon(session)
                    invocation.auto_apply_birthday_coupon(session,user,cart,None)
                    if invocation.controls.candidate is not None:
                        self.assertEqual(bool(invocation.controls.candidate.cache.claim),bool(original_cart.meta))
            self.assertEqual(bool(cart.meta),bool(original_cart.meta))
            if cart.meta:self.assertEqual(cart.meta['coupon']['coupon'],original_cart.meta['coupon']['coupon'])
            self.assertEqual(cache.sets,[])
            self.assertTrue(all(sql.startswith('select ') for sql in current.sql))

    def test_final_owner_scope_is_outside_current_and_capsule_read_is_memory_only(self):
        runtime,current,_cache,heads,cap=setup();needed=discovery(runtime,current,cap)
        value,selected=capsule(runtime,cap,needed)
        with prepared_coupon_history(value,selected,AUTH,KEY,SOURCE,GUARD,'Asia/Kolkata',lambda:NOW) as prepared:
            before=len(current.sql)
            with runtime.head_scope(current,selected),private_session(current),patch('coupon_handoff.qualify',side_effect=AssertionError('Document re-encoded under SQL')):
                for _index in range(1000):prepared.assert_current(needed.scope)
                self.assertEqual(prepared.read(needed.scope)['globalUsage'],'0')
            self.assertEqual(before,len(current.sql))
        self.assertEqual(heads.scoped[0][0],selected['nonce'])

    def test_source_midnight_stops_the_original_capsule_without_using_a_new_day_or_extending_lease(self):
        runtime,current,_cache,_heads,cap=setup()
        point=datetime(2026,6,15,23,59,59)
        now=[int(point.replace(tzinfo=ZoneInfo('Asia/Kolkata')).timestamp()*1000)]
        runtime.clock=lambda:now[0];runtime.point_factory=lambda:point
        needed=discovery(runtime,current,cap);value,selected=capsule(runtime,cap,needed)
        with self.assertRaises(BenefitReview):PreparedCouponHistory(value,selected,AUTH,KEY,SOURCE,GUARD,'Asia/Kolkata',runtime.clock)
        body={key:item for key,item in value['capability'].items() if key!='signature'}
        body['expiresAt']=now[0]+1000
        value['capability']={**body,'signature':seal('coupon-prefetch',body,KEY)}
        selected['couponHistoryHash']=digest(AUTH,'coupon-history',value)
        prepared=PreparedCouponHistory(value,selected,AUTH,KEY,SOURCE,GUARD,'Asia/Kolkata',runtime.clock)
        external=prepared.value;external['document']['globalUsage']='999'
        now[0]+=999
        self.assertEqual(prepared.read(needed.scope)['globalUsage'],'0')
        now[0]+=1
        with self.assertRaises(BenefitReview):prepared.read(needed.scope)

    def test_copy_scope_hmac_expiry_day_and_keys_are_rechecked_before_sql(self):
        runtime,current,_cache,_heads,cap=setup();needed=discovery(runtime,current,cap)
        value,selected=capsule(runtime,cap,needed)
        for field in ('scope','witness','guard','expiry','signature'):
            changed=copy.deepcopy(value)
            if field=='scope':changed['document']['scope']['customerId']='88'
            if field=='witness':changed['witness']['heads'][0]['revision']='2'
            if field=='guard':changed['guardObservation']['present']=True
            if field=='expiry':changed['capability']['expiresAt']=NOW+60001
            if field=='signature':changed['capability']['signature']='0'*64
            signed={**selected,'couponHistoryHash':digest(AUTH,'coupon-history',changed)}
            with self.assertRaises(BenefitReview):PreparedCouponHistory(changed,signed,AUTH,KEY,SOURCE,GUARD,'Asia/Kolkata',lambda:NOW)
        prepared=PreparedCouponHistory(value,selected,AUTH,KEY,SOURCE,GUARD,'Asia/Kolkata',lambda:NOW)
        value['document']['globalUsage']='1000'
        self.assertEqual(prepared.read(needed.scope)['globalUsage'],'0')
        with self.assertRaises(BenefitReview):prepared.read({**needed.scope,'planHash':'f'*64})
        with self.assertRaises(BenefitReview):PreparedCouponHistory(prepared.value,selected,AUTH,KEY,SOURCE,GUARD,'Asia/Kolkata',lambda:NOW+50000)
        with self.assertRaises(BenefitReview):PreparedCouponHistory(prepared.value,selected,AUTH,KEY,SOURCE,KEY,'Asia/Kolkata',lambda:NOW)
        with self.assertRaises(BenefitReview):
            with private_session(current):PreparedCouponHistory(prepared.value,selected,AUTH,KEY,SOURCE,GUARD,'Asia/Kolkata',lambda:NOW)


if __name__=='__main__':unittest.main()
