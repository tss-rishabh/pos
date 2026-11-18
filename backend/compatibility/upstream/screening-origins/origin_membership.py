"""Literal AddFreeMembership history replay for genuine origin scopes.

The pinned class and its current catalog/price decisions remain unchanged.
Only check_criteria's three historical SELECTs and its execution clock are
substituted. An absent publication unwinds the owned transaction before HTTP.
"""
import copy
import ast
import types
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from functools import wraps
from zoneinfo import ZoneInfo
from origin_contracts import digest,unsafe
from origin_membership_history import (NeedOriginMembershipHistory,PreparedOriginMembershipHistory,
    PreparedOriginMembershipPreview,request,preview_request)

ACTIVE=ContextVar('genuine_origin_membership',default=None)


class MembershipScope:
    def __init__(self,owner,session,value,document,preview):
        self.owner,self.session,self.value=owner,session,copy.deepcopy(value)
        self.document,self.preview,self.prepared,self.used=document,preview,None,False
    def criteria(self,instance,original):
        # This is the original function's first branch. Preserve it before
        # requesting any history; do not infer eligibility from plan prices.
        if instance.cart_value>2000:return original(instance)
        # check_localcart already counted actual source items. With no ordinary
        # item both literal criteria outcomes remove an existing free row; the
        # false branch preserves that result without an unnecessary BQ read.
        if instance.number_of_items==0:return False
        if self.prepared is None:
            if self.document is None:
                source_point=datetime.fromtimestamp(self.value['issuedAt']/1000,ZoneInfo(self.owner.zone)).replace(tzinfo=None,microsecond=0) if self.preview else self.owner.point()
                make=preview_request if self.preview else request
                scope,head=make(self.value,source_point,self.owner.settings,self.session)
                raise NeedOriginMembershipHistory(scope,head)
            qualifier=PreparedOriginMembershipPreview if self.preview else PreparedOriginMembershipHistory
            self.prepared=qualifier(self.document,self.value,self.owner.key,self.owner.settings,self.owner.clock)
        self.prepared.assert_current(self.value,late=True,session=self.session)
        from membership_history import HistorySession
        prior=instance.session
        instance.session=HistorySession(prior,self.prepared.facts())
        at=self.prepared.point
        class FrozenDateTime(datetime):
            @classmethod
            def now(cls,tz=None):
                if tz is not None:unsafe('SCREENING_ORIGIN_MEMBERSHIP_CLOCK')
                return at
        namespace=dict(original.__globals__);namespace['datetime']=FrozenDateTime
        literal=types.FunctionType(original.__code__,namespace,original.__name__,original.__defaults__,original.__closure__)
        self.used=True
        try:return literal(instance)
        except BaseException:
            from transaction import VIOLATION
            VIOLATION.set(True);raise
        finally:instance.session=prior
    def assert_current(self):
        if self.used:self.prepared.assert_current(self.value,late=True,session=self.session)
    def evidence(self):return self.prepared.evidence() if self.used else None


class OriginMembership:
    def __init__(self,settings,key,clock,point_factory,zone):
        self.settings,self.key,self.clock,self.point_factory,self.zone=settings,key,clock,point_factory,zone
        ZoneInfo(zone);digest(key,'membership-ready',None)
    def point(self):
        value=self.point_factory()
        if not isinstance(value,datetime) or value.tzinfo is not None:unsafe('SCREENING_ORIGIN_MEMBERSHIP_CLOCK')
        value=value.replace(microsecond=0)
        if not 0<=self.clock()-int(value.replace(tzinfo=ZoneInfo(self.zone)).timestamp()*1000)<1000:unsafe('SCREENING_ORIGIN_MEMBERSHIP_CLOCK')
        return value
    def validate_final(self,frame):
        """Rehearse literal eligibility before the first Order/admission write.

        Source Order/PosOrder hydrate the saved cart but never call the cart
        controller's AddFreeMembership step. A stale or crafted free row must
        therefore be requalified here. The real source Cart is cloned in
        memory; native SQL is SELECT-only and its source commits only flush.
        Changed products/prices/quantities require another reviewed cart,
        rather than silently editing the authenticated original command.
        """
        if ACTIVE.get() is not getattr(frame,'member_history',None):unsafe('SCREENING_ORIGIN_MEMBERSHIP_REQUIRED')
        from controllers.cart.Cart import Cart,AddFreeMembership
        from origin_effects import ACTIVE as EFFECTS
        from origin_preview import read_only
        from origin_contracts import fail
        original=frame.cart
        cart=Cart(types=original.types,wrappers=original.wrappers,
            is_hyperlocal=original.is_hyperlocal,is_split_order=original.is_split_order,
            is_pos=original.is_pos,is_express=original.is_express)
        cart.context=dict(original.context)
        cart.context['data']=copy.deepcopy(frame.req.context['data'])
        cart.context['user']=copy.deepcopy(frame.user)
        cart.context['cart']=cart
        cart.restore(original.get_snapshot())
        # A source wrapper may record a task while calculating the in-memory
        # rehearsal. It is neither an Order effect nor a cart mutation receipt.
        effects=EFFECTS.set([])
        try:
            with read_only(frame.session):
                before=cart.simple_obj()
                reviewed=_review(before)
                AddFreeMembership(frame.source,cart,before,cart.context['data'],cart.context['user']).process()
                prepared=_review(cart.simple_obj())
                frame.member_history.assert_current()
                if prepared!=reviewed:fail('SCREENING_ORIGIN_QUOTE_CHANGED')
        finally:EFFECTS.reset(effects)
    @contextmanager
    def before(self,session,value,document=None,*,preview=False):
        if ACTIVE.get() is not None:unsafe('SCREENING_ORIGIN_MEMBERSHIP_NESTED')
        state=MembershipScope(self,session,value,document,preview);token=ACTIVE.set(state)
        try:
            yield state
            state.assert_current()
        finally:ACTIVE.reset(token)


def _review(value):
    """Compare source-owned financial inputs without rebuilding any price."""
    fields=('prod_id','quantity','price','spl_price','exclusive_price','mrp',
        'gv_id','amount','initial_amount','option_id','combo_parent_id',
        'combo_price_fraction','prod_type','select')
    from origin_contracts import canonical
    stores={}
    for name,store in value.items():
        if name=='meta':continue
        stores[name]=sorted(({key:copy.deepcopy(item[key]) for key in fields if key in item}
            for item in (store.get('items') or [])),key=canonical)
    # IndexedItemStore stamps each recalculation with the source wall clock;
    # those bookkeeping timestamps are not a changed financial input.
    calculations=[{key:copy.deepcopy(entry) for key,entry in item.items() if key not in ('updated_at','added_at')}
        for item in (value.get('meta',{}).get('items') or []) if item.get('name')=='calculations']
    return {'stores':stores,'calculations':calculations}


def install(root):
    """Route captured aliases without changing ordinary unselected calls."""
    import importlib
    source=importlib.import_module('controllers.cart.Cart')
    original=source.AddFreeMembership
    if getattr(original,'__origin_membership__',False):return
    from membership_profile import _source
    tree=ast.parse(_source(root,'controllers/cart/Cart.py'))
    selected=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='AddFreeMembership')
    namespace=dict(vars(source))
    from source_runtime import SilentLogger
    namespace['logger']=SilentLogger()
    exec(compile(ast.Module(body=[copy.deepcopy(selected)],type_ignores=[]),'<pinned-origin-AddFreeMembership>','exec'),namespace)
    literal=namespace['AddFreeMembership']
    class QualifiedMember(literal):
        __origin_membership__=True
        def process(self):
            if ACTIVE.get() is None:return original(self.session,self.cart,self.cart_resp,self.data,self.user).process()
            return super().process()
        @wraps(literal.check_criteria)
        def check_criteria(self):
            state=ACTIVE.get()
            return literal.check_criteria(self) if state is None else state.criteria(self,literal.check_criteria)
    import sys
    for module in tuple(sys.modules.values()):
        for name,value in tuple(vars(module).items()):
            if value is original:setattr(module,name,QualifiedMember)
