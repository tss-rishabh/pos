"""Public POS membership composition of the ordinary, pinned producer.

The public capability is the authority. There is no CSV operation, namespace,
financial-stage nonce, or manufactured import plan in this module.
"""
import ast
import copy
import hmac
import importlib
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from types import ModuleType
from sqlalchemy import text

from writer_protocol import fail
from native_authority import one, rows
from source_runtime import checked_source
from transaction import VIOLATION

CONTRACT='pos-node-screening-benefits-v1'
ACTIVE=ContextVar('pos_public_screening_membership',default=None)


def denied(code='SCREENING_MEMBERSHIP_PROOF_REQUIRED'):
    VIOLATION.set(True)
    fail(code)


def ordinary_producer():
    directory=Path(__file__).resolve().parent.parent/'pending-cancellation'
    sys.path.insert(0,str(directory))
    module=ModuleType('pos_public_screening_membership_producer')
    exec(compile((directory/'membership_provenance.py').read_text(),'<ordinary-public-membership>','exec'),module.__dict__)
    def journal(proxy):
        current=ACTIVE.get()
        if current is None:denied()
        for _callback,args,kwargs in proxy.invalidations:
            if (kwargs or len(args)!=6 or args[1] is not None or args[2]!='exclusive_user'
                    or str(args[4])!=current.cap['customerId'] or args[5]!=current.user['email']):denied()
        current.invalidations+=len(proxy.invalidations)
    module._publish=journal
    return module


def qualified_free_membership(root,namespace,original):
    """Only the exact three historical SELECTs receive copied warehouse facts.
    The unselected public class remains the original class, including its clock.
    """
    from membership_profile import _source
    tree=ast.parse(_source(root,'controllers/cart/Cart.py'))
    target=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='AddFreeMembership')
    values=dict(namespace)
    from source_runtime import SilentLogger
    values['logger']=SilentLogger()
    source_clock=values['datetime']
    history_clock=ContextVar('pos_public_membership_execution_clock',default=None)
    class Clock:
        @staticmethod
        def now():return history_clock.get() or source_clock.now()
    values['datetime']=Clock
    exec(compile(ast.Module(body=[copy.deepcopy(target)],type_ignores=[]),'<pinned-public-AddFreeMembership>','exec'),values)
    literal=values['AddFreeMembership']
    class PublicMembership(literal):
        def process(self):
            if ACTIVE.get() is None:
                # The dedicated subclass never changes ordinary, unselected API
                # calls through a mutable ambient source flag.
                return original(self.session,self.cart,self.cart_resp,self.data,self.user).process()
            return super().process()
        def remove_exclusive_membership(self):
            current=ACTIVE.get()
            if current is None:return super().remove_exclusive_membership()
            if current.replacement is not None:denied()
            before=copy.deepcopy(self.em_prod)
            result=super().remove_exclusive_membership()
            current.replacement={'sourceAction':'AddFreeMembership.remove_exclusive_membership',
                                 'originalProductId':str(before['prod_id']),
                                 'replacementProductId':str(self.prod_id)}
            return result
        def check_criteria(self):
            current=ACTIVE.get()
            if current is None:return super().check_criteria()
            if self.cart_value>2000:
                current.eligibility='source-cart-over-2000'
                return super().check_criteria()
            if self.number_of_items==0:
                # Both literal outcomes remove an existing free row here.
                current.eligibility='no-ordinary-items'
                return False
            history=current.history
            if history is None:
                if not current.preview:denied('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
                from public_membership_history import NeedMembershipHistory
                raise NeedMembershipHistory(*current.history_request(source_clock.now()))
            from membership_history import HistorySession
            history.assert_current(current.cap)
            previous=self.session
            self.session=HistorySession(previous,history.facts())
            token=history_clock.set(history.point)
            try:
                result=super().check_criteria()
                current.eligibility='source-qualified-history'
                return result
            finally:
                history_clock.reset(token)
                self.session=previous
    return PublicMembership


class PublicMembershipProfile:
    def __init__(self,root,settings,namespace):
        self.root,self.settings=Path(root),settings
        self.adapter=ordinary_producer()
        self.adapter.config(settings)
        # Compilation is pure and independently pin checked. The same ordinary
        # lock, revision and staging producer is used by source/Go cancellation.
        from membership_profile import compile_writers
        dal=importlib.import_module('controllers.user.userDal')
        self.writers=compile_writers(root,dict(vars(dal)),self.adapter)
        self.namespace=namespace

    @contextmanager
    def scope(self,session,cap,user,history=None,preview=False):
        if ACTIVE.get() is not None:denied()
        # Zero-row metadata reads retain orders/HP MDL through preview/final
        # admission without reading historical facts or taking a head-first lock.
        session.execute(text('SELECT id FROM orders LIMIT 0')).close()
        session.execute(text('SELECT id FROM has_products LIMIT 0')).close()
        customer=user
        if user.get('email'):
            if preview:
                # Public native authority already holds this customer. Preview
                # only verifies identity/fence/current rows; it never creates
                # a revision or invokes a staging writer.
                customer=one(session,'SELECT id,email,status,is_block,is_disabled FROM users WHERE id=:id FOR UPDATE',{'id':cap['customerId']})
                owners=rows(session,'SELECT id FROM users WHERE email=:email ORDER BY id LIMIT 2 FOR SHARE',{'email':customer['email']},2)
                if len(owners)!=1 or str(owners[0]['id'])!=cap['customerId']:denied()
                self.adapter.assert_fence(session,customer['email'])
            else:customer,_revision=self.adapter.lock_customer(session,cap['customerId'])
            before=self.adapter.current(session,customer['email'])
        else:before=[]
        active=any(row['attribute']=='EXCLUSIVE_MEMBER' and row['active']==1 for row in before)
        if customer['email']!=user['email']:denied()
        user['is_exclusive']=active
        state=Invocation(self,session,cap,user,before,history,preview)
        token=ACTIVE.set(state)
        try:yield state
        finally:ACTIVE.reset(token)

    @contextmanager
    def stage(self,session,order_id,user,settings):
        current=ACTIVE.get()
        if current is None:
            # Existing non-Node source calls keep their actual ordinary writes.
            yield self.adapter.SimpleStage(True,session)
            return
        with self.adapter.membership_order_stage(session,order_id,user,settings) as staged:
            yield staged

    def order_class(self,namespace):
        from membership_profile import membership_order_tree
        target=membership_order_tree(self.root)
        original=ast.parse(checked_source(self.root,'controllers/OrderController.py'))
        owner=next(node for node in original.body if isinstance(node,ast.ClassDef) and node.name=='PosOrder')
        method=next(node for node in target.body if isinstance(node,ast.FunctionDef) and node.name=='on_post')
        method.decorator_list=copy.deepcopy(next(node for node in owner.body if isinstance(node,ast.FunctionDef) and node.name=='on_post').decorator_list)
        calls=[index for index,node in enumerate(method.body) if isinstance(node,ast.Expr)
               and isinstance(node.value,ast.Call) and ast.unparse(node.value.func)=='ValidateCheckout().on_post']
        if len(calls)!=1:denied('SCREENING_WRITER_SOURCE_UNVERIFIED')
        method.body[calls[0]+1:calls[0]+1]=ast.parse('from source_frame import after_validate\nafter_validate(req)').body
        values=dict(namespace)
        from source_frame import RoutedLogger,RoutedTasks,RoutedCache
        from source_runtime import SOURCE_REDIS_ALIASES
        if 'logger' in values:values['logger']=RoutedLogger(values['logger'])
        if 'tasks' in values:values['tasks']=RoutedTasks(values['tasks'])
        for name in SOURCE_REDIS_ALIASES:
            if name in values:values[name]=RoutedCache(values[name])
        values['membership_order_stage']=self.stage
        for name in ('set_exclusive_user','set_exclusive_upgrade_user'):
            original_writer=namespace[name];qualified=self.writers[name]
            def routed(*args,_original=original_writer,_qualified=qualified,**kwargs):
                return (_qualified if ACTIVE.get() is not None else _original)(*args,**kwargs)
            values[name]=routed
        exec(compile(ast.fix_missing_locations(ast.Module(body=[target],type_ignores=[])),'<pinned-public-member-PosOrder>','exec'),values)
        return values['PosOrder']


class Invocation:
    def __init__(self,profile,session,cap,user,before,history,preview):
        self.profile,self.session,self.cap,self.user=profile,session,cap,user
        self.before,self.history,self.preview=before,history,preview
        self.invalidations=0;self.eligibility='not-added';self.replacement=None;self.selection=None

    def history_request(self,point):
        from public_membership_history import request
        return request(self.cap,point,self.profile.settings,self.session)

    def admit(self,cart,types):
        ids={str(value) for group in (self.profile.settings.EXCLUSIVE_PRODUCT,self.profile.settings.EXCLUSIVE_UPGRADE_PRODUCT) for value in group}
        selected=[item for item in cart.get(types.PRODUCTS) if str(item['prod_id']) in ids]
        if not selected:
            self.selection=None
            return
        if len(selected)!=1 or type(selected[0]['quantity']) is not int or selected[0]['quantity']!=1:denied()
        if not self.user.get('email'):denied('SCREENING_MEMBERSHIP_CUSTOMER_REQUIRED')
        item=selected[0];sku=str(item['prod_id'])
        if sku in {str(value) for value in self.profile.settings.EXCLUSIVE_UPGRADE_PRODUCT}:
            if not self.user['is_exclusive']:denied()
            kind='upgrade'
        elif sku==str(self.profile.settings.FREE_EXCLUSIVE_PRODUCT):
            if (self.user['is_exclusive'] or self.eligibility not in ('source-cart-over-2000','source-qualified-history')
                    or float(item.get('spl_price') or item.get('price') or 0)!=0):denied()
            kind='auto-free'
        else:
            if self.user['is_exclusive']:denied()
            kind='new'
        self.selection={'kind':kind,'productId':sku,'eligibility':self.eligibility,
                        **({'replacement':copy.deepcopy(self.replacement)} if self.replacement else {})}

    def capture(self,order_id):
        adapter=self.profile.adapter
        if self.history is not None:self.history.assert_current(self.cap,late=True,session=self.session)
        if self.selection is None:
            if self.invalidations:denied()
            return None
        proof=adapter._decode(one(self.session,'SELECT * FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=:id FOR UPDATE',{'id':order_id}))
        key,_ids=adapter.config(self.profile.settings)
        current=adapter.current(self.session,self.user['email'])
        revision=one(self.session,'SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=:id FOR UPDATE',{'id':self.cap['customerId']})['revision']
        if (proof['contract']!=adapter.STAGED_CONTRACT or proof['before']!=self.before or proof['confirmed']!=current
                or proof['revision']!=str(revision) or proof['customerId']!=self.cap['customerId']
                or not hmac.compare_digest(adapter.proof_hash(proof,key),proof['proofHash'])):denied()
        line=rows(self.session,'SELECT id,prod_id,qty FROM has_products WHERE order_id=:id AND prod_id=:sku ORDER BY id LIMIT 2 FOR SHARE',
                  {'id':order_id,'sku':self.selection['productId']},2)
        if len(line)!=1 or line[0]['qty']!=1:denied()
        return {**self.selection,'lineId':str(line[0]['id']),'provenance':proof,
                'cacheInvalidations':self.invalidations,
                'historyEvidence':None if self.history is None else self.history.evidence()}
