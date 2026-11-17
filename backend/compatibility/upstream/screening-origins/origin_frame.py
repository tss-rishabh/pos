"""One genuine source-authenticated Order creation and its original nonce.

Installed below the original Falcon auth decorator. This is not a POS operator
capability, customer impersonation endpoint, or a replacement pricing engine.
"""
import copy
import hashlib
import json
import re
from contextlib import ExitStack
from contextvars import ContextVar
from functools import wraps
from types import SimpleNamespace
from sqlalchemy import text
from origin_contracts import CONTRACT,PROOF,UUID,OriginReview,digest,fingerprint,canonical,identifier,fail
from origin_auth import source_origin,authority_hash,fresh_source_user
from origin_ledger import read,insert,save,reserve,creation,projection
from origin_effects import ACTIVE as EFFECTS,persist as persist_effects,append as effect
from native import one,rows,HEADER,LINE
from screening_counter import read_current,ReplaySession,writer_entry,_SHAPE
from transaction import private_session,CURRENT,VIOLATION
from writer_protocol import portable_hash
import origin_history

CURRENT_ORIGIN=ContextVar('screening_original_origin',default=None)
RUNTIME=None
HEADER_NAME='X-TSS-Screening-Command'
CREATION='pos-screening-origin-creation-v1'
SOURCE='2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
ALLOCATION="LOWER(SHA2(CAST(JSON_OBJECT('parentOrderId',parent_order_id,'originalOrderId',original_order_id,'hlParentOrderId',hl_parent_order_id,'locationId',location_id,'locationType',location_type,'isExpress',is_express,'flagId',flag_id,'isNewCalc',is_new_calc) AS CHAR CHARACTER SET utf8mb4),256))"
NEGATIVE={'SCREENING_ORIGIN_LIMIT','SCREENING_ORIGIN_CART_CHANGED','SCREENING_ORIGIN_QUOTE_CHANGED'}


def request_hash(req):
    data=copy.deepcopy(req.context.get('data') or {})
    data.pop('name',None)
    return portable_hash({'data':data,'params':dict(req.params)})


def namespace(principal,req):
    if principal['origin'] in ('legacy-django','mpos'):
        return 'cart_'+principal['customerId']+'_'+principal['storeId']
    return 'cart_'+principal['customerId']


def cart_native_hash(session,name):
    # Current cart facts, bounded and never copied to a response/log/receipt.
    from database.mysqlCart import MySQLCart
    result=MySQLCart(session).get_cart_unified(name)
    values=[dict(row._mapping) if hasattr(row,'_mapping') else dict(row) for row in result]
    if len(values)>2000:fail('SCREENING_ORIGIN_CART_TOO_LARGE')
    def scalar(value):
        if value is None or type(value) in (str,int,float,bool):return value
        return str(value)
    normalized=[{name:scalar(value) for name,value in row.items()} for row in values]
    normalized.sort(key=canonical)
    return portable_hash(normalized)


def tickets(cart):
    from controllers.cart.Cart import ItemTypes
    values=cart.get(ItemTypes.PRODUCTS)
    quantity=0
    for row in values:
        if str(row.get('prod_id'))=='390238':
            if type(row.get('quantity')) is not int or row['quantity'] not in (1,2):fail('SCREENING_ORIGIN_LIMIT')
            quantity+=row['quantity']
    return quantity


def selected(req):
    cart=req.context.get('cart')
    if cart is not None and tickets(cart):return True
    data=req.context.get('data') or {}
    nested=data.get('data') if isinstance(data.get('data'),dict) else {}
    return str(data.get('prod_id') or nested.get('prod_id'))=='390238'


class CounterReplay:
    """Only the exact pinned screening helper is replayed; no SQL whitelist."""
    def __init__(self,session,snapshot,pending=0):
        self.session,self.snapshot,self.pending=session,snapshot,pending
    def execute(self,statement,parameters=None,**kwargs):
        compact=' '.join(str(statement).split()).strip()
        if compact==_SHAPE:
            result=ReplaySession(self.session,self.snapshot).execute(statement,parameters,**kwargs)
            if self.pending:
                from screening_counter import _Result
                return _Result(self.snapshot.count+self.pending)
            return result
        if re.search(r'\bspiderman_screening_orders\b',compact,re.I):fail('SCREENING_ORIGIN_COUNTER_SQL_UNQUALIFIED')
        return self.session.execute(statement,parameters,**kwargs)
    def __getattr__(self,name):return getattr(self.session,name)


def after_validate(req):
    frame=CURRENT_ORIGIN.get()
    if frame is not None:frame.admit(req)


def after_order_insert(order):
    frame=CURRENT_ORIGIN.get()
    if frame is not None:
        if frame.order_id is not None:fail('SCREENING_ORIGIN_DUPLICATE_ORDER')
        frame.order_id=identifier(order.id)
        origin_history.after_order_insert(order)


def after_original_auth(kind):
    """Artifact injection: @falcon.before(auth_required) then this decorator."""
    def decorate(original):
        @wraps(original)
        def wrapped(resource,req,resp,*args,**kwargs):
            # Node public and private import frames have their own real proofs.
            # Do not reinterpret a Node capability as a customer/staff origin.
            from source_frame import FRAME
            if FRAME.get() is not None or CURRENT_ORIGIN.get() is not None:return original(resource,req,resp,*args,**kwargs)
            if not selected(req):return original(resource,req,resp,*args,**kwargs)
            if RUNTIME is None:fail('SCREENING_ORIGIN_UNAVAILABLE')
            if kind=='cart':return RUNTIME.cart(req,resp,lambda:original(resource,req,resp,*args,**kwargs))
            return RUNTIME.order(req,resp,kind,lambda:original(resource,req,resp,*args,**kwargs))
        return wrapped
    return decorate


class Frame:
    def __init__(self,owner,req,kind):
        self.owner,self.req,self.kind=owner,req,kind
        self.session=owner.sessions();self.contexts=ExitStack();self.order_id=None;self.admitted=False
        self.effects=[];self.original_context=dict(req.context);self.cart_persist=None
    def open(self):
        self.transaction=self.session.begin()
        self.connection=self.session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        if self.connection.get_isolation_level()!='READ COMMITTED':fail()
        from origin_system import ACTIVE as SYSTEM
        self.system=SYSTEM.get()
        origin='external-system' if self.system is not None else (self.req.get_header('X-TSS-Screening-Origin') or 'customer')
        if self.system is not None:
            if self.kind!='customer':fail('SCREENING_ORIGIN_SERVICE_REQUIRED')
            self.customer,self.principal,self.grant=self.system.authorize(self.session,self.req)
        else:self.customer,self.principal,self.grant=source_origin(self.req,self.session,self.owner.key,self.owner.clock(),origin)
        self.command_id=self.req.get_header(HEADER_NAME)
        if not isinstance(self.command_id,str) or not UUID.fullmatch(self.command_id):fail('SCREENING_ORIGIN_COMMAND_REQUIRED')
        self.value=read(self.session,self.command_id,self.principal['customerId'],self.owner.key)
        if self.value is None:fail('SCREENING_ORIGIN_COMMAND_REQUIRED')
        if self.value['origin']!=origin:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
        if self.system is not None:self.system.assert_running(self.session,self.value)
        if self.value['phase'] in ('BOUND','COUNTED'):
            self.previous=creation(self.session,self.value,self.owner.key)
            projection(self.session,self.value)
            return False
        if self.value['phase']=='REJECTED':fail('SCREENING_ORIGIN_CLOSED_NO_ORDER')
        if self.value['phase']!='PREPARED' or self.value['expiresAt']<=self.owner.clock():fail('SCREENING_ORIGIN_EXPIRED')
        # Append-only outcomes also fence a stale/replayed signed PREPARED row.
        # A valid old state HMAC cannot erase an already committed disposition.
        for table in ('pos_rewrite_screening_origin_creations','pos_rewrite_screening_origin_closures','pos_rewrite_screening_origin_payments','pos_rewrite_screening_origin_effects'):
            if rows(self.session,'SELECT command_id FROM '+table+' WHERE command_id=:id FOR SHARE',{'id':self.command_id},2):fail('SCREENING_ORIGIN_RECONCILIATION_REQUIRED')
        if (self.value['authorityHash']!=authority_hash(self.owner.key,self.principal) or self.value['requestHash']!=request_hash(self.req)
                or any(self.value[name]!=self.principal[name] for name in ('actorId','customerId','storeId','counterId'))):fail('SCREENING_ORIGIN_SCOPE_CHANGED')
        self.namespace=self.system.namespace() if self.system is not None else namespace(self.principal,self.req)
        actual_cart_hash=self.system.cart_hash() if self.system is not None else cart_native_hash(self.session,self.namespace)
        if fingerprint(self.owner.key,'namespace',self.namespace)!=self.value['namespaceHash'] or actual_cart_hash!=self.value['cartHash']:fail('SCREENING_ORIGIN_CART_CHANGED')
        # The current materialized counter/trigger coverage is checked before
        # source mutation; this reader never scans historical orders/HP rows.
        snapshot=read_current(self.session,self.value['customerId'])
        from origin_assets_guard import membership
        self.member_before=membership(self.session,self.customer['email'])
        self.contexts.enter_context(writer_entry(self.session,self.value['customerId']))
        self.savepoint=self.session.begin_nested()
        self.token=CURRENT_ORIGIN.set(self);self.effect_token=EFFECTS.set(self.effects)
        replay=self.session
        self.history=None
        if self.kind=='customer':
            replay=self.contexts.enter_context(origin_history.scope(replay,self.value,self.owner.key,self.owner.clock()))
            self.history=replay
        replay=CounterReplay(replay,snapshot)
        self.source=self.contexts.enter_context(private_session(replay))
        self.contexts.enter_context(origin_history.guard_source(self.session,self))
        self.req.context['session']=self.source
        # Read the actual current membership row using the original predicate;
        # an AuthHandler/Redis cache hit cannot invent entitlement.
        active=rows(self.session,"SELECT id FROM user_eav WHERE entity=:email AND attribute='EXCLUSIVE_MEMBER' AND is_active=1 LIMIT 2 FOR SHARE",{'email':self.customer['email']},3)
        if len(active)>1:fail('SCREENING_ORIGIN_MEMBERSHIP_AMBIGUOUS')
        self.user=fresh_source_user(self.customer,bool(active))
        self.req.context['user']=self.user
        self.req.context['pos_rewrite_fresh_customer']={'subject':self.value['customerId'],'loaded':True}
        # Rehydrate the original current namespace using source serializers.
        # Every source persist is captured and can never COMMIT cart/order rows.
        from middleware.CartMiddleware import CartFactory,PosCartFactory
        factory=PosCartFactory if self.kind=='pos' else CartFactory
        if self.system is not None:cart=self.system.cart;cart.context=self.req.context
        elif self.kind=='pos':
            cart=factory.instantiate(None,self.user,self.req.context,store_id=self.value['storeId'],is_pos=True)
        else:
            data=self.req.context['data'];cart=factory.instantiate(None,self.user,self.req.context,is_hyperlocal=bool(data.get('is_hyperlocal')),
                is_split_order=bool(data.get('is_split_order')),is_express=bool(data.get('is_express')))
        self.cart=cart;self.req.context['cart']=cart
        if self.system is None or cart.persist_handler is not None:cart.persist_handler=self.capture_cart
        if self.owner.assets is not None:
            # Capture original native member state and physical collection locks
            # under the already-owned customer, before any original Order row.
            with origin_history.trusted_native():self.asset_state=self.owner.assets.before(self)
        return True
    def capture_cart(self,value):
        # Keep the last source persist, preserving the original final cart.
        # The encrypted worker checks the untouched namespace revision first.
        copied=json.loads(canonical(value))
        if len(canonical(copied).encode())>500000:fail('SCREENING_ORIGIN_CART_TOO_LARGE')
        self.cart_persist=copied
    def admit(self,req):
        if req is not self.req or self.admitted or tickets(req.context['cart'])!=self.value['quantity']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
        if self.grant is not None:
            if (self.grant['requestHash']!=self.value['requestHash'] or self.grant['cartHash']!=self.value['cartHash']
                    or self.grant['expiresAt']<=self.owner.clock()):fail('SCREENING_ORIGIN_STAFF_REVOKED')
            data=req.context['data']
            if str(data.get('store_id'))!=self.value['storeId'] or str(data.get('counter_id'))!=self.value['counterId']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
            operators=rows(self.session,'SELECT id FROM users WHERE pos_admin_id=:actor AND status=1 AND COALESCE(is_block,0)=0 AND COALESCE(is_disabled,0)=0 ORDER BY id LIMIT 2 FOR SHARE',{'actor':self.value['actorId']},3)
            if len(operators)!=1 or str(operators[0]['id'])!=str(data.get('admin_user_id')):fail('SCREENING_ORIGIN_OPERATOR_CUSTOMER_CHANGED')
        from screening_counter import read_current
        with origin_history.trusted_native():
            self.value=reserve(self.session,self.value,self.owner.key,self.owner.legacy_key,read_current(self.session,self.value['customerId']),self.owner.clock())
        self.admitted=True
    def seal(self,resp):
        with origin_history.trusted_native():return self.seal_native(resp)
    def seal_native(self,resp):
        if not self.admitted or VIOLATION.get() or self.order_id is None or self.owner.clock()>=self.value['expiresAt']:fail()
        if self.system is not None:self.system.assert_running(self.session,self.value)
        try:result=json.loads(resp.text if resp.text else resp.body)
        except Exception:fail()
        if (not str(resp.status).startswith('200') or not isinstance(result,dict) or set(result)!={'order','method','isValid','name'}
                or result['isValid'] is not True or result['name']!='placed_order' or str(result['order'])!=self.order_id):fail()
        header=one(self.session,'SELECT user_id,payment_method,order_status,payment_status,'+HEADER+' AS hash,'+ALLOCATION+' AS allocationHash FROM orders WHERE id=:id FOR SHARE',{'id':self.order_id})
        if str(header['user_id'])!=self.value['customerId'] or header['payment_method']!=result['method'] or header['order_status']!=0 or header['payment_status']!=0:fail()
        lines=rows(self.session,'SELECT id,prod_id,qty,sub_prod_id,gift_voucher_id AS gv_id,'+LINE+' AS hash FROM has_products WHERE order_id=:id ORDER BY id LIMIT 1001',{'id':self.order_id},1002)
        if not 1<=len(lines)<=1000:fail('SCREENING_ORIGIN_LINE_LIMIT')
        now=self.owner.clock();assets_hash=None
        if self.owner.assets is None:
            from origin_assets_guard import no_new_assets
            no_new_assets(self,lines)
        else:assets_hash=self.owner.assets.capture(self,header['hash'],now)
        ticket=[{'id':str(row['id']),'quantity':row['qty']} for row in lines if str(row['prod_id'])=='390238']
        markers=rows(self.session,'SELECT id,has_product_id,user_id FROM spiderman_screening_orders FORCE INDEX(idx_order_id) WHERE order_id=:id ORDER BY id LIMIT 3',{'id':self.order_id},4)
        if len(markers)!=self.value['markerRows'] or any(str(row['user_id'])!=self.value['customerId'] for row in markers):fail()
        if self.cart_persist is not None:effect({'kind':'cart','namespace':self.namespace,'customerId':self.value['customerId'],
                                              'expectedHash':self.value['cartHash'],'value':self.cart_persist})
        effects_hash=persist_effects(self.session,self.value,self.owner.key,self.effects,now)
        proof={'contract':CREATION,'commandId':self.value['id'],'origin':self.value['origin'],'customerId':self.value['customerId'],
            'actorId':self.value['actorId'],'storeId':self.value['storeId'],'counterId':self.value['counterId'],
            'authorityHash':self.value['authorityHash'],'requestHash':self.value['requestHash'],'cartHash':self.value['cartHash'],
            'referenceHash':self.value['referenceHash'],'orderId':self.order_id,'method':result['method'],'headerHash':header['hash'],'allocationHash':header['allocationHash'],
            'lines':[{'id':str(row['id']),'productId':str(row['prod_id']),'quantity':row['qty'],'inputHash':row['hash']} for row in lines],
            'ticketLines':ticket,'markers':[{'id':str(row['id']),'lineId':str(row['has_product_id'])} for row in markers],
            'lineItemsEnabled':self.value['lineItemsEnabled'],'effectsHash':effects_hash,'sourceCommit':SOURCE,'createdAt':now}
        if self.system is not None:proof['systemAuthorityHash']=self.system.system_authority_hash
        if assets_hash is not None:proof['assetsHash']=assets_hash
        seal=digest(self.owner.key,'creation',proof)
        self.session.execute(text('INSERT INTO pos_rewrite_screening_origin_creations(command_id,order_id,data,proof_hash) VALUES(:id,:order,:data,:proof)'),
                             {'id':self.value['id'],'order':self.order_id,'data':canonical(proof),'proof':seal})
        self.value=save(self.session,{**self.value,'phase':'BOUND','orderId':self.order_id,'lines':ticket,'markers':proof['markers'],'creationHash':seal},self.owner.key,now)
        projection(self.session,self.value)
        if self.history is not None:origin_history.finish(self.session,self.value,self.history)
        self.close_source()
        self.savepoint.commit();self.transaction.commit()
        resp.set_header('X-TSS-Screening-Origin-Contract',CONTRACT)
        resp.set_header('X-TSS-Screening-Command',self.value['id'])
        return result
    def reject(self,error):
        if (not isinstance(error,OriginReview) or error.code not in NEGATIVE or not hasattr(self,'savepoint')
                or not self.savepoint.is_active or not self.transaction.is_active or VIOLATION.get()):return False
        self.close_source(error);self.savepoint.rollback()
        value=read(self.session,self.command_id,self.principal['customerId'],self.owner.key)
        if value is None or value['phase']!='PREPARED' or value['orderId'] is not None:fail()
        for table,column in (('pos_rewrite_screening_origin_creations','command_id'),('pos_rewrite_screening_origin_payments','command_id'),('pos_rewrite_screening_origin_effects','command_id')):
            if rows(self.session,'SELECT '+column+' FROM '+table+' WHERE '+column+'=:id FOR SHARE',{'id':value['id']},2):fail()
        now=self.owner.clock()
        proof={'contract':'pos-screening-origin-closure-v1','commandId':value['id'],'origin':value['origin'],'customerId':value['customerId'],
               'requestHash':value['requestHash'],'cartHash':value['cartHash'],'authorityHash':value['authorityHash'],
               'code':error.code,'noFinancialEffects':True,'createdAt':now}
        seal=digest(self.owner.key,'closure',proof)
        self.session.execute(text('INSERT INTO pos_rewrite_screening_origin_closures(command_id,data,proof_hash) VALUES(:id,:data,:proof)'),
                             {'id':value['id'],'data':canonical(proof),'proof':seal})
        self.value=save(self.session,{**value,'phase':'REJECTED','closureHash':seal},self.owner.key,now)
        self.transaction.commit();return True
    def close_source(self,error=None):
        self.contexts.__exit__(None if error is None else type(error),error,None)
        if hasattr(self,'effect_token'):EFFECTS.reset(self.effect_token);del self.effect_token
        if hasattr(self,'token'):CURRENT_ORIGIN.reset(self.token);del self.token
    def close(self,error=None):
        try:self.close_source(error)
        finally:
            self.req.context.clear();self.req.context.update(self.original_context)
            if getattr(self,'connection',None) is not None and self.connection.invalidated:self.session.invalidate()
            elif self.session.in_transaction():self.session.rollback()
            self.session.close()


class OriginRuntime:
    def __init__(self,sessions,key,legacy_key,line_items,clock,history_provider=None):
        digest(key,'ready',None)
        if key==legacy_key:fail('SCREENING_ORIGIN_KEY_REQUIRED')
        self.sessions,self.key,self.legacy_key,self.line_items,self.clock=sessions,key,legacy_key,line_items,clock
        self.history_provider=history_provider
        self.member_product_ids=set()
        self.assets=None
    def order(self,req,resp,kind,call):
        frame=Frame(self,req,kind)
        failure=None
        try:
            if frame.open():
                # The original ValidateCheckout still runs in the original body.
                # Reserve before it; a refusal rolls back this native savepoint.
                frame.admit(req)
                call();return frame.seal(resp)
            proof=frame.previous
            resp.text=canonical({'order':int(proof['orderId']),'method':proof['method'],'isValid':True,'name':'placed_order'})
            resp.set_header('X-TSS-Screening-Command',proof['commandId'])
            resp.set_header('X-TSS-Screening-Origin-Contract',CONTRACT)
            return None
        except BaseException as error:
            failure=error
            if isinstance(error,OriginReview):frame.reject(error)
            raise
        finally:frame.close(failure)
    def cart(self,req,resp,call):
        # Add/set screening checks use the same projection; no reservation,
        # order or financial receipt is created by a cart mutation.
        original=dict(req.context);cart=req.context.get('cart');cart_context=None if cart is None else dict(cart.context)
        with self.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            native,principal,_grant=source_origin(req,session,self.key,self.clock(),req.get_header('X-TSS-Screening-Origin') or 'customer')
            snapshot=read_current(session,principal['customerId'])
            from origin_ledger import all_pending
            pending=all_pending(session,principal['customerId'],self.legacy_key,self.key)
            captured=snapshot.count+pending;customer=principal['customerId'];expires=self.clock()+5000
        # Cart limits are informational. Release the native authority locks
        # before the original Cart persistence/producer lifecycle; final Order
        # creation always acquires a NEW owned current projection/admission.
        def guard():
            if self.clock()>=expires or str(req.context.get('user',{}).get('user_id'))!=customer:fail('SCREENING_ORIGIN_CART_SCOPE_CHANGED')
        copy_snapshot=SimpleNamespace(customer=customer,count=captured,guard=guard)
        proxy=CounterReplay(original['session'],copy_snapshot)
        frame=SimpleNamespace(source=proxy,order_id=None)
        token=CURRENT_ORIGIN.set(frame)
        req.context['session']=proxy
        if cart is not None:cart.context['session']=proxy
        try:
            with origin_history.guard_source(original['session'],frame):return call()
        finally:
            CURRENT_ORIGIN.reset(token)
            req.context.clear();req.context.update(original)
            if cart is not None:cart.context.clear();cart.context.update(cart_context)


def install(runtime):
    global RUNTIME
    if RUNTIME is not None:fail('SCREENING_ORIGIN_ALREADY_INSTALLED')
    RUNTIME=runtime
