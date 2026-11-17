"""Selected Node POS resource frame around the actual source PosOrder body.

Install before source controller imports. An unselected request keeps the exact
original scoped sessions/tasks/caches. Selected requests own one RC transaction;
no nested source commit, cache/cart publication, or HTTP can escape that frame.
"""
import ast
import copy
import hashlib
import json
import time
from contextvars import ContextVar
from pathlib import Path
from types import SimpleNamespace
from sqlalchemy.orm import sessionmaker
from writer_protocol import CONTRACT,HEADER,ScreeningWriterError,fail,verify,portable_hash,quote_snapshot
from native_authority import lock_authority,rows
from creation import reserve,bind,read_creation
from protocol import canonical,ImportReview,digest
from transaction import private_session,PrivateSessionProxy,CURRENT,VIOLATION,guard_private_commit,guard_private_statement
from effects import CAPTURE,Tasks
from receiver import seal_effects,Receiver
from source_runtime import PINS,checked_source,SilentLogger,ReadOnlyCache,SOURCE_REDIS_ALIASES
from negative import assert_open,seal as seal_negative,CODES as NEGATIVE_CODES

FRAME=ContextVar('pos_node_screening_writer',default=None)
CONTEXT='pos_node_screening_writer'
class NoCounterReadRefused(BaseException):pass


class RoutedSession:
    def __init__(self,original):self.original=original
    @property
    def __class__(self):
        # DatabaseManager selects remove() vs close() using isinstance on the
        # original scoped-session type. Preserve that unselected lifecycle.
        return self.original.__class__
    def __call__(self,*args,**kwargs):
        if FRAME.get() is not None:
            if args or kwargs:fail()
            return PrivateSessionProxy().current()
        return self.original(*args,**kwargs)
    def __getattr__(self,name):
        if FRAME.get() is not None:return getattr(PrivateSessionProxy().current(),name)
        return getattr(self.original,name)


class RoutedCache:
    def __init__(self,original):self.original=original
    def __getattr__(self,name):
        source=ReadOnlyCache(self.original) if FRAME.get() is not None else self.original
        return getattr(source,name)


class RoutedTasks:
    def __init__(self,original):self.original=original
    def __getattr__(self,name):
        return getattr(Tasks() if FRAME.get() is not None else self.original,name)


class RoutedLogger:
    def __init__(self,original):self.original=original
    def __getattr__(self,name):
        return getattr(SilentLogger() if FRAME.get() is not None else self.original,name)


def projection(root,namespace):
    """Compile only the literal ProcessOrder serialization + GST output block."""
    tree=ast.parse(checked_source(root,'controllers/OrderController.py'))
    owner=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='ProcessingOrder')
    function=next(node for node in owner.body if isinstance(node,ast.FunctionDef) and node.name=='on_post')
    def assigned(node,name):
        return isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id==name for target in node.targets)
    start=next(index for index,node in enumerate(function.body) if assigned(node,'cart_details'))
    end=next(index for index,node in enumerate(function.body) if index>start and isinstance(node,ast.For) and
             isinstance(node.target,ast.Name) and node.target.id=='prodata')
    body=copy.deepcopy(function.body[start:end])
    expected=('cart_details','response_data','fb_event_custom_data','gst_status')
    if tuple(node.targets[0].id for node in body if isinstance(node,ast.Assign))!=expected or len(body)!=5:fail('SCREENING_WRITER_SOURCE_UNVERIFIED')
    target=ast.parse('def projected(cart,user,req,platform=None):\n return None').body[0]
    target.body=body+[ast.Return(value=ast.Name(id='response_data',ctx=ast.Load()))]
    values=dict(namespace)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[target],type_ignores=[])),'<pinned-processorder-screening-projection>','exec'),values)
    return values['projected']


def after_validate(req):
    frame=FRAME.get()
    cart=req.context.get('cart')
    if frame is None:
        # Hook is called for the public PosOrder resource only. The untouched
        # source predicate remains in the body; absent origin proof is never
        # converted into permission for a Node or legacy ticket writer.
        from controllers.cart.Cart import ItemTypes
        if any(str(row.get('prod_id'))=='390238' for row in cart.get(ItemTypes.PRODUCTS)):
            fail('SCREENING_WRITER_ORIGIN_UNQUALIFIED')
        return
    try:frame.after_validate(req)
    except Exception as error:
        frame.remember_rejection(error)
        raise


class _Frame:
    def __init__(self,owner,req,cap):
        self.owner,self.req,self.cap=owner,req,cap
        self.session=owner.sessions()
        self.effects=[];self.tokens=[];self.validated=False;self.reservation=None
        self.rejection_code=None
        self.benefit_context=None;self.benefit_state=None;self.counter_context=None;self.history_context=None
    def open(self,preview=False,history=None):
        self.preview=preview
        self.transaction=self.session.begin()
        connection=self.session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        self.connection=connection
        if connection.get_isolation_level()!='READ COMMITTED':fail()
        self.state,self.customer=lock_authority(self.session,self.cap,self.owner.clock())
        assert_open(self.session,self.cap,self.owner.proof_key)
        if self.cap.get('benefitsContract'):
            if preview:
                from native_authority import one,value_json
                saved=one(self.session,'SELECT data,proof_hash,status FROM pos_rewrite_public_screening_work WHERE operation_id=:id FOR UPDATE',{'id':self.cap['operationId']})
                if (saved['status']!='prepared' or value_json(saved['data'])!=self.cap
                        or saved['proof_hash']!=digest(self.owner.proof_key,'public-screening-intent',self.cap)
                        or rows(self.session,'SELECT operation_id FROM pos_rewrite_public_screening_submission_dispatches WHERE operation_id=:id FOR SHARE',{'id':self.cap['operationId']},1)):
                    fail()
            else:
                from negative import intent
                if intent(self.session,self.cap['operationId'],self.owner.proof_key)[0]!=self.cap:fail()
            if self.owner.benefits is None:fail('SCREENING_BENEFITS_UNAVAILABLE')
        # Keep authority/creation locks outside the source savepoint. A typed
        # native denial rolls back every original write, then seals its nonce
        # in this same outer transaction, without an unlocked create window.
        self.savepoint=self.session.begin_nested()
        self.tokens.append((FRAME,FRAME.set(self)))
        self.tokens.append((CAPTURE,CAPTURE.set(self.effects)))
        replay=self.session
        if self.owner.counter_scope is not None:
            self.counter_context=self.owner.counter_scope(self.session,self.cap,preview=preview)
            replay=self.counter_context.__enter__()
        if self.cap.get('benefitsContract'):
            from receiver import source_user
            user=source_user(self.customer,self.cap['customerId'],False)
            self.benefit_context=self.owner.benefits.scope(self.session,self.cap,user,preview=preview,history=history)
            self.benefit_state=self.benefit_context.__enter__()
        # Only the literal in-memory membership replay may answer the three
        # historical queries. Guard both this proxy and already imported aliases
        # on its physical connection; an old Session alias is never a fallback.
        from cart_preparation import guard_history
        self.history_context=guard_history(replay)
        replay=self.history_context.__enter__()
        self.private=private_session(replay)
        self.source=self.private.__enter__()
        self.tainted=False
    def rollback(self):
        # A refused physical COMMIT invalidates the DBAPI connection. Discard
        # its session too instead of trying to roll back detached savepoints.
        connection=getattr(self,'connection',None)
        if connection is not None and connection.invalidated:self.session.invalidate()
        else:self.session.rollback()
    def remember_rejection(self,error):
        if isinstance(error,ScreeningWriterError) and error.code in NEGATIVE_CODES:
            self.rejection_code=error.code
    def abort(self):
        try:
            try:self.exit_source(False)
            finally:self.rollback()
        finally:
            for variable,token in reversed(self.tokens):variable.reset(token)
            self.tokens=[]
            self.session.close()
    def close_contexts(self,succeeded):
        error=None if succeeded else ScreeningWriterError('SCREENING_WRITER_RECONCILIATION_REQUIRED')
        def close(name):
            context=getattr(self,name,None)
            if context is not None:
                setattr(self,name,None)
                context.__exit__(None if succeeded else type(error),error,None)
        try:close('history_context')
        finally:
            try:close('benefit_context')
            finally:close('counter_context')
    def exit_source(self,succeeded):
        private=getattr(self,'private',None)
        try:
            if private is not None:
                self.private=None
                error=None if succeeded else ScreeningWriterError('SCREENING_WRITER_RECONCILIATION_REQUIRED')
                private.__exit__(None if succeeded else type(error),error,None)
        finally:self.close_contexts(succeeded)
    def after_validate(self,req):
        if req is not self.req or self.validated:fail()
        cap=self.cap
        user=req.context.get('user')
        marker=req.context.get('pos_rewrite_fresh_customer')
        if (not isinstance(user,dict) or str(user.get('user_id'))!=cap['customerId'] or
            not isinstance(marker,dict) or marker.get('subject')!=cap['customerId'] or marker.get('loaded') is not True):fail()
        # The source auth decorator/JWT remains independently required. The
        # native lock additionally binds balances/contact and current block flags.
        for name in ('email','telephone','tss_money','tss_points','cashback','is_block','is_disabled'):
            if name in self.customer:user[name]=self.customer[name]
        payload={name:value for name,value in req.context['data'].items() if name!='name'}
        if portable_hash(payload)!=cap['requestHash'] or req.params:fail()
        if (payload.get('is_pos') is not True or str(payload.get('store_id'))!=cap['storeId'] or
            str(payload.get('counter_id'))!=cap['counterId'] or payload.get('custom_created_at') or payload.get('custom_data') or
            str(payload.get('admin_user_id'))!=self.state['operatorCustomerId'] or
            payload.get('payment_method') not in ('coc','prepaid')):fail()
        snapshot=self.owner.project(req.context['cart'],user,req,req.params.get('platform'))
        if portable_hash(quote_snapshot(snapshot))!=cap['cartHash']:fail('SCREENING_WRITER_QUOTE_CHANGED')
        from controllers.cart.Cart import ItemTypes
        products=req.context['cart'].get(ItemTypes.PRODUCTS)
        exclusive=req.context['cart'].get_item(ItemTypes.META,{'name':'exclusive_user'})
        upgrade=self.owner.namespace['get_exclusive_upgrade_product'](req.context['cart'])
        if self.benefit_state is None and exclusive and not exclusive.get('store_exclusive',0) and (exclusive.get('cart') and not user.get('is_exclusive') or upgrade):
            fail('SCREENING_MEMBERSHIP_PROFILE_REQUIRED')
        if self.benefit_state is None and (req.context['cart'].get(ItemTypes.GIFT_VOUCHERS) or any(row.get('prod_type')==8 for row in products)):
            fail('SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED')
        if self.benefit_state is not None:
            if bool(user.get('is_exclusive'))!=bool(self.benefit_state.user['is_exclusive']):fail()
            self.benefit_state.admit(req.context['cart'],ItemTypes,payload)
        additional=[row for row in req.context['cart'].get(ItemTypes.COMPLEMENTARY_PRODUCTS) if row.get('is_valid')]
        count=sum(int(row.get('quantity',0)) for row in [*products,*additional]) if self.owner.line_items else len(products)+len(additional)
        if count<1 or count>1000:fail('SCREENING_WRITER_LINE_LIMIT')
        quantity=sum(int(row.get('quantity',0)) for row in products if str(row.get('prod_id'))=='390238')
        # Original ValidateCheckout and all source stock/pricing wrappers have
        # run. Retain the current native rows as well before source order writes.
        for row in sorted(products,key=lambda row:int(row['prod_id'])):
            product=rows(self.session,'SELECT stock,is_avail,is_del FROM product_store WHERE store_id=:store AND product_id=:product FOR UPDATE',
                         {'store':cap['storeId'],'product':str(row['prod_id'])},1)
            if (len(product)!=1 or product[0]['is_avail']!=1 or product[0]['is_del']!=0 or
                product[0]['stock']<int(row['quantity']) and row.get('jit_value')!='JIT'):fail('SCREENING_WRITER_STOCK_CHANGED')
        self.reservation=reserve(self.session,cap,self.owner.proof_key,quantity,self.owner.line_items,self.owner.clock())
        self.validated=True
    def finish(self,req,resp,succeeded):
        error=None
        try:
            if not succeeded or not str(resp.status).startswith('200') or not self.validated or self.tainted:
                fail(self.rejection_code or 'SCREENING_WRITER_RECONCILIATION_REQUIRED')
            result=json.loads(resp.body if resp.body else resp.text)
            now=self.owner.clock()
            # Native flag changes cannot race held rows; TTL is checked again
            # after every source/stock wait, immediately before native commit.
            if now>=self.cap['expiresAt']:fail('SCREENING_WRITER_EXPIRED')
            # Collector already bounds/serializes allowed source intents. Route
            # resolution may execute application code and is deferred to the
            # retained postcommit publication consumer, outside SQL locks.
            benefits_hash=None if self.benefit_state is None else self.benefit_state.capture(result['order'],now)
            effects_hash=hashlib.sha256(canonical(self.effects).encode()).hexdigest()
            proof,_=bind(self.session,self.cap,self.reservation,self.owner.proof_key,result,self.owner.controller_hash,effects_hash,now,benefits_hash)
            from sqlalchemy import text
            self.session.execute(text("INSERT INTO pos_rewrite_public_screening_effects(operation_id,payload,effects_hash,status,deliveries,created_at_ms,updated_at_ms) VALUES(:op,:payload,:hash,'pending','[]',:now,:now)"),
                {'op':self.cap['operationId'],'payload':seal_effects(self.owner.proof_key,'public-screening:'+self.cap['operationId'],self.effects),
                 'hash':effects_hash,'now':now})
            self.exit_source(True)
            if self.owner.clock()>=self.cap['expiresAt']:fail('SCREENING_WRITER_EXPIRED')
            self.savepoint.commit()
            self.transaction.commit()
            resp.set_header('X-POS-Screening-Writer-Contract',CONTRACT)
        except Exception as caught:
            error=caught
            # Unknown SQL/driver/COMMIT outcomes are never native negatives.
            # Only explicit native business denials can take this branch, and
            # only before a physical commit was attempted.
            eligible=(isinstance(caught,ScreeningWriterError) and caught.code in NEGATIVE_CODES and
                      self.savepoint.is_active and self.transaction.is_active and not self.tainted and not VIOLATION.get())
            if eligible:
                try:
                    self.exit_source(False)
                    self.savepoint.rollback()
                    seal_negative(self.session,self.cap,self.state,self.owner.proof_key,caught.code,self.owner.clock())
                    self.transaction.commit()
                except Exception:
                    try:self.exit_source(False)
                    finally:self.rollback()
                    error=ScreeningWriterError('SCREENING_WRITER_RECONCILIATION_REQUIRED')
            else:
                try:self.exit_source(False)
                finally:self.rollback()
        finally:
            try:
                self.exit_source(error is None)
            finally:
                for variable,token in reversed(self.tokens):variable.reset(token)
                self.tokens=[]
                self.session.close()
        if error is not None:
            if isinstance(error,ScreeningWriterError):raise error from None
            # An ambiguous native COMMIT is reconciled from the original receipt;
            # neither SQL exceptions nor a no-effects assertion cross this edge.
            fail('SCREENING_WRITER_RECONCILIATION_REQUIRED')


class NodePosWriterMiddleware:
    def __init__(self,sessions,root,secret,proof_key,contracts,order_namespace,tasks,line_items,clock=None,benefits=None,counter_scope=None,counter_refused=NoCounterReadRefused):
        from screening_profile import CONTRACT as PROFILE,SCHEMA,WRITERS
        if contracts!={'node':CONTRACT,'profile':PROFILE,'schema':SCHEMA,'writers':WRITERS}:fail('SCREENING_WRITER_UNAVAILABLE')
        self.sessions,self.secret,self.proof_key=sessions,secret,proof_key
        self.root=Path(root).resolve()
        from writer_protocol import key
        key(secret);digest(proof_key,'public-screening-ready',None)
        if secret==proof_key:fail('SCREENING_WRITER_UNAVAILABLE')
        Receiver.assert_publisher(SimpleNamespace(pipeline=SimpleNamespace(tasks=tasks)))
        self.clock=clock or (lambda:int(time.time()*1000))
        self.project=projection(root,order_namespace)
        self.namespace=order_namespace
        self.tasks=tasks;self.line_items=bool(line_items)
        self.benefits,self.counter_scope=benefits,counter_scope
        self.counter_refused=counter_refused
        from source_refunds import CORRECTED_CONTROLLER_SHA256
        self.controller_hash=CORRECTED_CONTROLLER_SHA256
        self.paths={order_namespace['settings'].POS_API_PREFIX+'/order'}
    def process_request(self,req,resp):
        header=req.get_header(HEADER)
        if header is None:return
        if req.method!='POST' or req.path not in self.paths:fail()
        cap=verify(header,self.secret,self.clock())
        frame=_Frame(self,req,cap)
        try:frame.open()
        except self.counter_refused:
            frame.abort()
            raise
        except Exception:
            frame.abort()
            raise
        req.context[CONTEXT]=frame
    def process_response(self,req,resp,resource,req_succeeded):
        frame=req.context.get(CONTEXT)
        if frame is not None:frame.finish(req,resp,req_succeeded)


def qualify_source(root):
    for name in PINS:checked_source(root,name)
    return Path(root).resolve()


def route_exports(root,modules):
    """After controller imports: route actual cache/task/logger references."""
    root=Path(root).resolve()
    for module in modules:
        filename=getattr(module,'__file__',None)
        if not filename:continue
        try:inside=Path(filename).resolve().is_relative_to(root)
        except (ValueError,OSError):inside=False
        if not inside:continue
        for alias in SOURCE_REDIS_ALIASES:
            if hasattr(module,alias) and not isinstance(getattr(module,alias),RoutedCache):
                setattr(module,alias,RoutedCache(getattr(module,alias)))
        if hasattr(module,'tasks') and not isinstance(module.tasks,RoutedTasks):module.tasks=RoutedTasks(module.tasks)
        if hasattr(module,'logger') and not isinstance(module.logger,RoutedLogger):module.logger=RoutedLogger(module.logger)
