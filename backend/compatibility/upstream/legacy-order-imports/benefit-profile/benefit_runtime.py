"""Invocation-local composition of the literal source coupon/POS gift paths."""
import copy
import os
import re
import sys
import time
from contextlib import contextmanager,nullcontext
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from benefit_source import BenefitReview,strict_pos_grants,qualified_has_products
from benefit_profile import benefit_scope,assert_benefit_profile
from benefit_controls import CouponControls,UnavailableCouponHeads
from benefit_claims import legacy_guard_observation,GUARD_CONTRACT
from coupon_handoff import CURRENT_COUPON_HISTORY
from benefit_receipts import coupon_users,coupon_receipt,complementary_receipt,store_descriptor
from benefit_native import native_benefit_order
from benefit_codec import install_complementary_codec
from transaction import CURRENT

ACTIVE=ContextVar('pos_import_literal_benefit_invocation',default=None)
COUPON='pos-csv-automatic-coupon-v1'
COMPLEMENTARY='pos-csv-pos-complementary-v1'
FUNCTIONS=('get_auto_apply_coupon','auto_apply_birthday_coupon','get_valid_coupon',
           'set_attributes_for_coupon','apply_coupon','calculate_coupon_discount')


def selected_contracts(environment):
    result={}
    for variable,field,expected in (
        ('POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT','automaticCoupon',COUPON),
        ('POS_LEGACY_IMPORT_COMPLEMENTARY_CONTRACT','complementary',COMPLEMENTARY)):
        value=environment.get(variable)
        if value in (None,''):continue
        if value!=expected:raise BenefitReview('ORDER_IMPORT_BENEFIT_CONFIGURATION_REQUIRED')
        result[field]=value
    return result


def dispatcher(name):
    def invoke(*args,**kwargs):
        current=ACTIVE.get()
        if current is None:raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
        return getattr(current,name)(*args,**kwargs)
    return invoke


class SourceBenefits:
    def __init__(self,root,settings,source_cache,item_types,error_type,heads=None,environment=None,clock=None,point_factory=None,zone=None,has_product_model=None,coupon_settings=None):
        self.root=Path(root).resolve();self.settings=settings;self.source_cache=source_cache
        self.types,self.error_type=item_types,error_type
        self.environment=os.environ if environment is None else environment
        self.contracts=selected_contracts(self.environment)
        self.source_key=self.environment.get('POS_LEGACY_IMPORT_PROOF_KEY','')
        self.guard_key=self.environment.get('POS_LEGACY_IMPORT_COUPON_GUARD_KEY','')
        self.guard_contract=self.environment.get('POS_LEGACY_IMPORT_BIRTHDAY_GUARD_CONTRACT')
        self.heads=heads or UnavailableCouponHeads()
        self.clock=clock or (lambda:int(time.time()*1000))
        self.point_factory=point_factory or datetime.now
        self.zone=zone or self.environment.get('BUSINESS_TIMEZONE','Asia/Kolkata')
        self.line_items=bool(settings.IS_LINE_ITEM_ENABLED)
        self.has_product_model=has_product_model
        self.coupon_settings=copy.deepcopy(coupon_settings) if coupon_settings is not None else {
            name:copy.deepcopy(getattr(settings,name)) for name in
            ('BIRTHDAY_MESSAGE','EMPLOYEE_COUPON_DOMAIN_MAP','REDIS_COUPON_EXPIRY_IN_SEC','EXCLUSIVE_PRODUCT')}

    def install(self):
        """Dedicated private process only. Alias replacement is static, but all
        data and choices live in ACTIVE, never a mutable singleton invocation.
        Pinned functions themselves are independently compiled by the candidate.
        """
        wrapped={name:dispatcher(name) for name in FUNCTIONS}
        for _name,module in tuple(sys.modules.items()):
            path=getattr(module,'__file__',None) if module is not None else None
            if not path:continue
            try:inside=Path(path).resolve().is_relative_to(self.root)
            except (OSError,ValueError):inside=False
            if not inside:continue
            for name,function in wrapped.items():
                if callable(getattr(module,name,None)):setattr(module,name,function)

    def order_namespace(self,namespace):
        if self.contracts.get('complementary'):
            original=sys.modules.get('libs.FreebieGrantHelper')
            if original is None:raise BenefitReview('ORDER_IMPORT_FREEBIE_SCHEMA_UNQUALIFIED')
            namespace['persist_pos_freebie_grants']=strict_pos_grants(self.root,dict(vars(original)))
            namespace['build_has_products_model']=qualified_has_products(namespace['build_has_products_model'])

    @contextmanager
    def scope(self,session,user,plan,cap,preview=False):
        if ACTIVE.get() is not None:raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
        marker=cap.get('benefitContracts',{})
        if marker and marker!=self.contracts:raise BenefitReview('ORDER_IMPORT_BENEFIT_CONFIGURATION_REQUIRED')
        current=Invocation(self,session,user,plan,cap,preview)
        token=ACTIVE.set(current)
        try:yield current
        finally:ACTIVE.reset(token)

    def guard_observation(self,scope):
        if (CURRENT.get() is not None or self.guard_contract!=GUARD_CONTRACT
                or not isinstance(self.guard_key,str) or not re.fullmatch(r'[!-~]{32,4096}',self.guard_key)
                or self.guard_key==self.source_key):raise BenefitReview('ORDER_IMPORT_BIRTHDAY_GUARD_UNQUALIFIED')
        try:return legacy_guard_observation(self.source_cache,scope,self.guard_key,self.clock())
        except Exception:raise BenefitReview('ORDER_IMPORT_BIRTHDAY_GUARD_UNQUALIFIED') from None

    def head_scope(self,session,cap):
        prepared=CURRENT_COUPON_HISTORY.get()
        if prepared is None:return nullcontext()
        if CURRENT.get() is not None:raise BenefitReview('ORDER_IMPORT_COUPON_HEADS_UNQUALIFIED')
        self.heads.assert_ready()
        return self.heads.scope(session,cap,prepared.scope,prepared.value['witness'])

    def native(self,session,order_id,plan,cap,cart,additional,replaced):
        current=getattr(cart,'pos_import_benefit_context',None)
        if current is None:raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
        return native_benefit_order(session,order_id,plan,cap,cart,self.types,current,additional,replaced)

    def stock_quantity(self,session,plan,line,cap):
        # Offline Go consumes actual HP quantities. The literal type4 POS
        # selection always creates one free HP, even after repeated CSV adds.
        # Shopify deliberately deducts original plan.lines instead.
        selected=cap.get('benefitContracts',{}).get('complementary')
        if plan['kind']!='offline' or selected!=COMPLEMENTARY or line['quantity']==1:
            return line['quantity']
        if self.contracts.get('complementary')!=selected:
            raise BenefitReview('ORDER_IMPORT_BENEFIT_CONFIGURATION_REQUIRED')
        from native import one
        product=one(session,'SELECT prod_type FROM products WHERE id=:id FOR SHARE',{'id':line['productId']})
        return 1 if product['prod_type']==4 else line['quantity']

    def capture(self,session,state,plan,cap,cart,order):
        current=getattr(cart,'pos_import_benefit_context',None)
        if current is None or current.plan is not plan or current.cap is not cap:
            raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
        descriptors={};candidate=current.controls.candidate
        if candidate and candidate.applied:
            value,_proof=coupon_receipt(session,state,plan,order,cart,self.types,current.controls.history.value['document'],
                candidate.cache.claim,current.users_before,self.source_key)
            store_descriptor(session,state,'coupon-benefit',value,self.source_key,self.clock());descriptors['coupon']=value
        selected=cart.get_item(self.types.META,{'name':'pos_freebies'})
        if selected and selected.get('items'):
            value,_proof=complementary_receipt(session,state,plan,order,selected,current.controls.point.strftime('%Y-%m-%d %H:%M:%S'),self.source_key)
            store_descriptor(session,state,'pos-complement',value,self.source_key,self.clock());descriptors['complementary']=value
        if candidate is not None:
            # This is deliberately LATE. Do not hold source tracking heads from
            # Cart across Order DML while legacy triggers use Order→head order.
            self.heads.assert_ready()
            current.controls.history.assert_current(current.controls.scope)
            self.heads.validate_after_native(session,current.controls.scope,current.controls.witness,
                {'state':state,'plan':plan,'order':order,'descriptors':descriptors})
        delattr(cart,'pos_import_benefit_context')
        return descriptors


class Invocation:
    def __init__(self,runtime,session,user,plan,cap,preview):
        self.runtime,self.session,self.user,self.plan,self.cap=runtime,session,user,plan,cap
        self.cart=None;self.users_before=[]
        history=CURRENT_COUPON_HISTORY.get()
        self.controls=CouponControls(runtime.root,session,cap,plan,runtime.source_key,runtime.source_cache,
            runtime.coupon_settings,runtime.types,runtime.error_type,runtime.heads,runtime.clock,runtime.point_factory,runtime.zone,history,preview)
    def bind(self,cart):
        if self.cart is not None and self.cart is not cart:raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
        if cart.is_pos is not True:raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
        self.cart=cart;cart.pos_import_benefit_context=self
    def get_auto_apply_coupon(self,_session):
        return self.controls.namespace['get_auto_apply_coupon'](self.controls.reader)
    def auto_apply_birthday_coupon(self,_session,user,cart,platform):
        self.bind(cart)
        if not user or str(user['user_id'])!=self.cap['authority']['customerId']:raise BenefitReview()
        old=cart.get_item(self.runtime.types.META,{'name':'coupon'})
        candidate=self.controls.candidate
        if old and (candidate is None or not candidate.applied):raise BenefitReview('ORDER_IMPORT_UNBOUND_COUPON_META')
        result=self.controls.namespace['auto_apply_birthday_coupon'](self.controls.reader,user,cart,platform)
        candidate=self.controls.candidate
        meta=cart.get_item(self.runtime.types.META,{'name':'coupon'})
        if meta:
            if candidate is None or candidate.cache.claim is None or str(meta.get('coupon_id'))!=candidate.scope['couponId']:
                raise BenefitReview('ORDER_IMPORT_UNBOUND_COUPON_META')
            candidate.applied=True
        return result
    def _candidate(self):
        candidate=self.controls.candidate
        if candidate is None:raise BenefitReview('ORDER_IMPORT_UNBOUND_COUPON_META')
        self.controls.history.assert_current(self.controls.scope)
        return candidate
    def get_valid_coupon(self,session,code,platform,user,**options):
        return self._candidate().get_valid_coupon(session,code,platform,user,**options)
    def set_attributes_for_coupon(self,item,coupon):
        return self._candidate().namespace['set_attributes_for_coupon'](item,coupon)
    def apply_coupon(self,cart,coupon):
        self.bind(cart)
        return self._candidate().apply_coupon(cart,coupon)
    def calculate_coupon_discount(self,cart,item):
        if cart.get_item(self.runtime.types.META,{'name':'coupon'}) is None:return None
        self.bind(cart)
        return self._candidate().calculate_discount(cart,item)
    def admit(self,cart,types,settings,calculations,plain_profile=None):
        self.bind(cart)
        candidate=self.controls.candidate
        selected=cart.get_item(types.META,{'name':'pos_freebies'})
        has_selection=bool(selected and selected.get('items'))
        if not has_selection and candidate is None:
            if plain_profile is None:
                from profiles import assert_plain_profile
                plain_profile=assert_plain_profile
            return plain_profile(cart,types,settings,self.plan,calculations)
        complementary=self.cap.get('benefitContracts',{}).get('complementary')
        if has_selection and complementary!='pos-csv-pos-complementary-v1':
            raise BenefitReview('ORDER_IMPORT_COMPLEMENTARY_PROFILE_REQUIRED')
        if has_selection:
            model=self.runtime.has_product_model
            if model is None:raise BenefitReview('ORDER_IMPORT_FREEBIE_SCHEMA_UNQUALIFIED')
            install_complementary_codec(self.session,model,complementary)
        if candidate is not None:
            self.controls.history.assert_current(self.controls.scope)
            self.runtime.heads.assert_ready()
            self.users_before=coupon_users(self.session,self.cap['authority']['customerId'],candidate.scope['couponId'])
        with benefit_scope(self.plan,coupon=candidate,complementary=complementary):
            from screening_profile import CURRENT_PROFILE,screened_base_profile
            base=screened_base_profile(assert_benefit_profile) if CURRENT_PROFILE.get() is not None else assert_benefit_profile
            return base(cart,types,settings,self.plan,calculations)
