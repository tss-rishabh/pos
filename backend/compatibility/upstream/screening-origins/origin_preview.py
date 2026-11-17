"""Authenticated pre-command source cart rehearsal and atomic current-cart CAS.

No Order command is fabricated. Missing member/coupon facts leave this owned
rollback transaction before HTTP. The successful rehearsal captures original
cart persists and source effects; only after guards close are current-cart
writes and their independent journal committed together.
"""
import copy
import hashlib
import hmac
import json
import re
import ssl
from contextlib import ExitStack,contextmanager
from contextvars import ContextVar
from types import SimpleNamespace
from uuid import uuid4
from urllib.parse import urlsplit
from urllib.request import Request,build_opener,HTTPSHandler
from sqlalchemy import event,text
from origin_contracts import canonical,digest,fingerprint,fail,unsafe
from preview_contracts import preview as validate
from native import one,rows,json_value
from transaction import private_session,VIOLATION
from origin_effects import ACTIVE as EFFECTS,seal_effects,open_effects

ACTIVE=ContextVar('genuine_origin_preview',default=None)
TABLE='pos_rewrite_screening_origin_cart_previews'


def context(owner,principal,name,cart_hash,request_hash,purpose):
    from origin_auth import authority_hash
    now=owner.clock()
    return validate({'contract':'pos-screening-origin-preview-v1','previewId':str(uuid4()),'purpose':purpose,
        **{field:principal[field] for field in ('origin','customerId','actorId','storeId','counterId')},
        'authorityHash':authority_hash(owner.key,principal),'namespaceHash':fingerprint(owner.key,'namespace',name),
        'requestHash':request_hash,'cartHash':cart_hash,'issuedAt':now,'expiresAt':now+60000})


def drain_request(req):
    """Release the original request read sessions before any history HTTP."""
    for name in ('session','session_r'):
        session=req.context.get(name)
        if session is None:continue
        actual=getattr(session,'original',session)
        if any(getattr(actual,field,()) for field in ('new','dirty','deleted')):fail('SCREENING_ORIGIN_PREVIEW_DIRTY_REQUEST')
        if callable(getattr(actual,'rollback',None)):actual.rollback()
        if callable(getattr(actual,'remove',None)):actual.remove()
        elif callable(getattr(actual,'close',None)):actual.close()


@contextmanager
def read_only(session):
    connection=session.connection()
    def guard(_connection,_cursor,statement,_parameters,_context,_many):
        sql=re.sub(r'/\*.*?\*/',' ',statement,flags=re.S).lstrip()
        if not re.match(r'^SELECT\b',sql,re.I):unsafe('SCREENING_ORIGIN_PREVIEW_WRITE_FORBIDDEN')
    event.listen(connection,'before_cursor_execute',guard)
    try:
        yield
        if session.new or session.dirty or session.deleted or VIOLATION.get():unsafe('SCREENING_ORIGIN_PREVIEW_WRITE_FORBIDDEN')
    finally:
        if event.contains(connection,'before_cursor_execute',guard):event.remove(connection,'before_cursor_execute',guard)


class PreviewFrame:
    def __init__(self,owner,req,session,value,name,native):
        self.owner,self.req,self.session,self.preview,self.namespace=owner,req,session,value,name
        self.order_id=None;self.effects=[];self.persists={};self.native=native;self.admitted=False
    def capture(self,name,customer,value,active=False):
        expected='active_cart_'+self.preview['customerId'] if active else self.namespace
        if name!=expected or (customer is not None and str(customer)!=self.preview['customerId']):unsafe('SCREENING_ORIGIN_PREVIEW_CART_SCOPE')
        copied=json.loads(canonical(value))
        if len(canonical(copied).encode())>500000:unsafe('SCREENING_ORIGIN_CART_TOO_LARGE')
        self.persists[name]={'value':copied,'active':active}


def install_persistence():
    from database.mysqlCart import MySQLCart
    if getattr(MySQLCart,'__origin_preview__',False):return
    original=MySQLCart.save_cart;active=MySQLCart.save_active_cart
    def save(instance,name,customer,value):
        frame=ACTIVE.get()
        return original(instance,name,customer,value) if frame is None else frame.capture(name,customer,value)
    def save_active(instance,name,value):
        frame=ACTIVE.get()
        return active(instance,name,value) if frame is None else frame.capture(name,None,value,True)
    MySQLCart.save_cart=save;MySQLCart.save_active_cart=save_active;MySQLCart.__origin_preview__=True


def _source_scope(frame,stack,coupon_snapshot,coupon_documents,member_document,cart_meta=None):
    from origin_frame import CURRENT_ORIGIN,CounterReplay
    from origin_auth import fresh_source_user
    import origin_history
    from screening_counter import read_current
    from origin_ledger import all_pending
    owner,session,value=frame.owner,frame.session,frame.preview
    snapshot=read_current(session,value['customerId'])
    pending=all_pending(session,value['customerId'],owner.legacy_key,owner.key)
    # Both current controls are read while the genuine global customer is held.
    if owner.coupons is not None:
        from origin_coupon_preview import coupon_preview_scope
        stack.enter_context(coupon_preview_scope(owner.coupons,session,value,digest(owner.key,'preview-context',value),
            'pos' if value['origin'] in ('legacy-django','mpos') else 'customer',frame.namespace,
            coupon_snapshot,coupon_documents,cart_meta=cart_meta))
    if owner.membership is not None:
        frame.membership=stack.enter_context(owner.membership.before(session,value,member_document,preview=True))
    source=CounterReplay(session,snapshot,pending)
    frame.source=stack.enter_context(private_session(source))
    stack.enter_context(origin_history.guard_source(session,frame))
    stack.enter_context(read_only(session))
    active=rows(session,"SELECT id FROM user_eav WHERE entity=:email AND attribute='EXCLUSIVE_MEMBER' AND is_active=1 LIMIT 2 FOR SHARE",{'email':frame.native['email']},3)
    if len(active)>1:unsafe('SCREENING_ORIGIN_MEMBERSHIP_AMBIGUOUS')
    req=frame.req
    req.context['session']=frame.source;req.context['session_r']=frame.source
    req.context['user']=fresh_source_user(frame.native,bool(active))
    token=CURRENT_ORIGIN.set(frame);effects=EFFECTS.set(frame.effects);preview=ACTIVE.set(frame)
    stack.callback(ACTIVE.reset,preview);stack.callback(EFFECTS.reset,effects);stack.callback(CURRENT_ORIGIN.reset,token)


def _commit_cart(session,frame):
    from origin_delivery import FlushOnly
    from origin_frame import cart_native_hash
    from database.mysqlCart import MySQLCart
    from controllers.cart.cart_serializer import CartSerializer
    value=frame.preview
    # Serialization is under the customer prefix used by source Order. Exact
    # current namespace CAS also catches nonparticipating ordinary cart writers.
    for name in sorted((frame.namespace,'active_cart_'+value['customerId'])):
        for table,column in (('cart_items','prod_id'),('cart_meta','name')):
            if len(rows(session,'SELECT '+column+' FROM '+table+' WHERE cart_id=:id ORDER BY '+column+' LIMIT 2001 FOR UPDATE',{'id':name},2002))>2000:fail()
    if cart_hash(session,frame.namespace,value['customerId'])!=value['cartHash']:fail('SCREENING_ORIGIN_CART_CHANGED')
    helper=MySQLCart(FlushOnly(session))
    for name,entry in sorted(frame.persists.items()):
        if entry['active']:
            helper.save_active_cart(name,entry['value'])
        else:
            helper.save_cart_items(name,int(value['customerId']),CartSerializer.products_to_db_payload(entry['value']))
            helper.save_cart_meta(name,entry['value'])
    session.flush()
    final_hash=cart_hash(session,frame.namespace,value['customerId'])
    effects_hash=hashlib.sha256(canonical(frame.effects).encode()).hexdigest()
    body={'contract':'pos-screening-origin-cart-preview-receipt-v1','preview':value,'finalCartHash':final_hash,
          'effectsHash':effects_hash,'createdAt':frame.owner.clock()}
    payload=seal_effects(frame.owner.key,'cart-preview:'+value['previewId'],frame.effects)
    session.execute(text('INSERT INTO '+TABLE+"(preview_id,customer_id,data,proof_hash,payload,effects_hash,phase,deliveries,updated_at_ms) VALUES(:id,:customer,:data,:proof,:payload,:hash,'PENDING','[]',:now)"),
        {'id':value['previewId'],'customer':value['customerId'],'data':canonical(body),'proof':digest(frame.owner.key,'cart-preview-receipt',body),
         'payload':payload,'hash':effects_hash,'now':frame.owner.clock()})
    return body


def cart_hash(session,name,customer):
    from origin_frame import cart_native_hash
    from writer_protocol import portable_hash
    return portable_hash({'cart':cart_native_hash(session,name),'active':cart_native_hash(session,'active_cart_'+customer)})


def check_grant(owner,session,req,name,grant):
    if grant is None:return
    from origin_frame import request_hash,cart_native_hash
    if (grant['requestHash']!=request_hash(req) or grant['cartHash']!=cart_native_hash(session,name)
            or grant['expiresAt']<=owner.clock()):fail('SCREENING_ORIGIN_SCOPE_CHANGED')


def cart(owner,req,resp,call,hydrate):
    """Run the actual original responder, with bounded rollback/history retries."""
    from origin_frame import request_hash,namespace,cart_native_hash
    from origin_auth import source_origin,authority_hash
    from origin_membership_history import NeedOriginMembershipHistory
    if owner.coupons is not None:
        from origin_coupon_preview import NeedCouponPreview
    else:
        class NeedCouponPreview(BaseException):pass
    original=dict(req.context);data=copy.deepcopy(req.context.get('data'));member_document=None;coupon_documents={}
    original_response=(getattr(resp,'text',None),getattr(resp,'status',None))
    origin=req.get_header('X-TSS-Screening-Origin') or 'customer'
    drain_request(req)
    with owner.sessions() as session,session.begin():
        session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        _native,principal,grant=source_origin(req,session,owner.key,owner.clock(),origin)
        name=namespace(principal,req)
        check_grant(owner,session,req,name,grant)
        value=context(owner,principal,name,cart_hash(session,name,principal['customerId']),request_hash(req),'cart-mutation')
    coupon_snapshot=owner.coupons.snapshot(value['customerId']) if owner.coupons is not None else None
    try:
        for _round in range(6):
            needed=None
            req.context.clear();req.context.update(original);req.context['data']=copy.deepcopy(data)
            if hasattr(resp,'text'):resp.text=original_response[0]
            if original_response[1] is not None:resp.status=original_response[1]
            try:
                with owner.sessions() as session,session.begin():
                    session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                    native,current,grant=source_origin(req,session,owner.key,owner.clock(),origin)
                    check_grant(owner,session,req,name,grant)
                    if (owner.clock()>=value['expiresAt'] or authority_hash(owner.key,current)!=value['authorityHash']
                            or namespace(current,req)!=name or cart_hash(session,name,value['customerId'])!=value['cartHash']
                            or request_hash(req)!=value['requestHash']):fail('SCREENING_ORIGIN_PREVIEW_CHANGED')
                    frame=PreviewFrame(owner,req,session,value,name,native)
                    with ExitStack() as stack:
                        _source_scope(frame,stack,coupon_snapshot,coupon_documents,member_document)
                        hydrate(req,resp)
                        result=call()
                        succeeded=str(resp.status).split()[0] in ('200','201','204')
                    if not succeeded:
                        session.rollback();return result
                    _commit_cart(session,frame)
                    resp.set_header('X-TSS-Screening-Preview',value['previewId'])
                    return result
            except (NeedOriginMembershipHistory,NeedCouponPreview) as missing:needed=missing
            # The with-block has closed/rolled back every source connection.
            if isinstance(needed,NeedOriginMembershipHistory):
                if owner.membership_history_provider is None:fail('SCREENING_ORIGIN_MEMBERSHIP_REQUIRED')
                member_document=owner.membership_history_provider.preview(value,needed.scope,needed.head)
            elif isinstance(needed,NeedCouponPreview):
                if owner.coupon_preview_provider is None:fail('SCREENING_ORIGIN_COUPON_PREVIEW_REQUIRED')
                identity=digest(owner.key,'coupon-preview-request',needed.request)
                if identity in coupon_documents:fail('SCREENING_ORIGIN_COUPON_PREVIEW_CHANGED')
                coupon_documents[identity]=owner.coupon_preview_provider.read(needed.request)
            else:fail('SCREENING_ORIGIN_PREVIEW_REQUIRED')
        fail('SCREENING_ORIGIN_PREVIEW_REQUIRED')
    finally:
        req.context.clear();req.context.update(original);req.context['data']=data


class CouponPreviewHistory:
    """Separate, expiring private HTTP purpose; the stable replay key is pure."""
    def __init__(self,url,key,clock,ca_file=None):
        value=urlsplit(url)
        if (value.scheme!='https' or not value.hostname or value.username or value.password or value.query or value.fragment
                or value.path!='/internal/screening-origins/coupon-preview'):fail('SCREENING_ORIGIN_COUPON_CONFIGURATION')
        self.url,self.key,self.clock,self.ca_file=url,key,clock,ca_file
    def read(self,request):
        from transaction import CURRENT
        from origin_coupon_http import NoRedirect
        if CURRENT.get() is not None or ACTIVE.get() is not None:fail('SCREENING_ORIGIN_COUPON_SQL_SCOPE')
        if not isinstance(request,dict) or set(request)!={'preview','previewProof','selection','witness'}:fail()
        value=validate(request['preview']);now=self.clock()
        if not value['issuedAt']<=now<value['expiresAt']:fail('SCREENING_ORIGIN_PREVIEW_EXPIRED')
        data={**copy.deepcopy(request),'issuedAt':now,'expiresAt':min(now+30000,value['expiresAt'])}
        body=canonical({'data':data,'proofHash':digest(self.key,'coupon-preview-request',data)}).encode()
        if len(body)>32000:fail()
        try:
            opener=build_opener(NoRedirect(),HTTPSHandler(context=ssl.create_default_context(cafile=self.ca_file)))
            with opener.open(Request(self.url,data=body,headers={'Content-Type':'application/json','Cache-Control':'no-store'},method='POST'),timeout=20) as response:
                if response.status!=200:fail('SCREENING_ORIGIN_COUPON_PREVIEW_REQUIRED')
                raw=response.read(262145)
                if len(raw)>262144:fail('SCREENING_ORIGIN_COUPON_PREVIEW_REQUIRED')
            document=json.loads(raw)
            if not isinstance(document,dict):fail()
            return document
        except Exception:fail('SCREENING_ORIGIN_COUPON_PREVIEW_REQUIRED')


def install_middleware(owner):
    """Defer genuine selected carts before source MetaInitializer can run."""
    import importlib
    from origin_frame import CURRENT_ORIGIN,namespace
    from origin_auth import source_origin
    from transaction import CURRENT
    main=importlib.import_module('middleware.CartMiddleware')
    active=importlib.import_module('middleware.ActiveCartMiddleware')
    original=main.CartMiddleware.process_request;other=active.ActiveCartMiddleware.process_request
    if getattr(original,'__origin_preview__',False):fail('SCREENING_ORIGIN_ALREADY_INSTALLED')
    def hydrate(req,resp):
        original(main.CartMiddleware(),req,resp)
        other(active.ActiveCartMiddleware(),req,resp)
        if req.context.get('cart') is None or req.context.get('active_cart') is None:unsafe('SCREENING_ORIGIN_PREVIEW_CART_REQUIRED')
    owner.cart_hydrate=hydrate
    def any_ticket(value,depth=0):
        if depth>24:fail('SCREENING_ORIGIN_CART_TOO_LARGE')
        if isinstance(value,dict):
            if str(value.get('prod_id') or value.get('sku_id') or '')=='390238':return True
            return any(any_ticket(item,depth+1) for item in value.values())
        return isinstance(value,list) and any(any_ticket(item,depth+1) for item in value)
    def prepare(instance,req,resp):
        from writer_protocol import HEADER as POS_HEADER
        if req.method=='OPTIONS' or req.get_header(POS_HEADER) or CURRENT.get() is not None or CURRENT_ORIGIN.get() is not None:return original(instance,req,resp)
        path=req.path.rstrip('/')
        if not any(path==endpoint or path.startswith(endpoint+'/') for endpoint in main.settings.CART_REQUIRED_ENDPOINTS):return original(instance,req,resp)
        # An anonymous local cart retains its literal guest behavior. There is
        # no fabricated customer/actor ID or history scope for a guest.
        user=req.context.get('user')
        if not isinstance(user,dict) or not user.get('user_id'):return original(instance,req,resp)
        with owner.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _native,principal,_grant=source_origin(req,session,owner.key,owner.clock(),req.get_header('X-TSS-Screening-Origin') or 'customer')
            name=namespace(principal,req)
            present=rows(session,"SELECT prod_id FROM cart_items WHERE cart_id=:cart AND status='active' AND prod_id=390238 LIMIT 2 FOR SHARE",{'cart':name},3)
        if not present and not any_ticket(req.context.get('data') or {}):return original(instance,req,resp)
        req.context['_origin_deferred_cart']=True
    prepare.__origin_preview__=True
    def defer_active(instance,req,resp):
        if req.context.get('_origin_deferred_cart') is True:return
        return other(instance,req,resp)
    def bounded(instance,req,resp):
        from origin_bootstrap import static_error
        from origin_contracts import OriginReview
        try:return prepare(instance,req,resp)
        except OriginReview as error:static_error(error)
        except BaseException:static_error(OriginReview('SCREENING_ORIGIN_PREVIEW_REQUIRED'))
    bounded.__origin_preview__=True
    main.CartMiddleware.process_request=bounded;active.ActiveCartMiddleware.process_request=defer_active
    install_persistence()


def load(session,preview_id,key,*,lock=True):
    row=one(session,'SELECT preview_id,customer_id,data,proof_hash,payload,effects_hash,phase,deliveries,updated_at_ms FROM '+TABLE+' WHERE preview_id=:id AND OCTET_LENGTH(data)<=16000 AND OCTET_LENGTH(payload)<=1400000'+(' FOR UPDATE' if lock else ''),{'id':preview_id})
    value=json_value(row['data'])
    if (not isinstance(value,dict) or set(value)!={'contract','preview','finalCartHash','effectsHash','createdAt'}
            or value['contract']!='pos-screening-origin-cart-preview-receipt-v1'
            or validate(value['preview'])['previewId']!=preview_id or str(row['customer_id'])!=value['preview']['customerId']
            or row['effects_hash']!=value['effectsHash'] or not hmac.compare_digest(digest(key,'cart-preview-receipt',value),row['proof_hash'])):fail()
    effects=open_effects(key,'cart-preview:'+preview_id,row['payload'],row['effects_hash'])
    deliveries=json_value(row['deliveries'])
    if not isinstance(deliveries,list) or len(deliveries)>len(effects):fail()
    return row,value,effects,deliveries


def dispatch(owner,preview_id,registry):
    from origin_effects import deliver
    while True:
        with owner.sessions() as session,session.begin():
            row,value,effects,deliveries=load(session,preview_id,owner.key)
            if row['phase'] in ('COMPLETE','UNCERTAIN'):return {'phase':row['phase'],'completed':len(deliveries),'actorId':value['preview']['actorId']}
            if row['phase']=='SENDING':
                if row['updated_at_ms']+120000>owner.clock():return {'phase':'SENDING','completed':len(deliveries),'actorId':value['preview']['actorId']}
                session.execute(text("UPDATE "+TABLE+" SET phase='UNCERTAIN',updated_at_ms=:now WHERE preview_id=:id"),{'id':preview_id,'now':owner.clock()})
                return {'phase':'UNCERTAIN','completed':len(deliveries),'actorId':value['preview']['actorId']}
            if row['phase']!='PENDING':fail()
            index=len(deliveries)
            if index==len(effects):
                session.execute(text("UPDATE "+TABLE+" SET phase='COMPLETE',updated_at_ms=:now WHERE preview_id=:id"),{'id':preview_id,'now':owner.clock()})
                return {'phase':'COMPLETE','completed':index,'actorId':value['preview']['actorId']}
            effect=copy.deepcopy(effects[index])
            effect_id=digest(owner.key,'cart-preview-effect-id',{'previewId':preview_id,'index':index,'effect':effect})
            effect.update(commandId=preview_id,ordinal=index,scopeKind='cart-preview')
            session.execute(text("UPDATE "+TABLE+" SET phase='SENDING',updated_at_ms=:now WHERE preview_id=:id"),{'id':preview_id,'now':owner.clock()})
        try:receipt=deliver(registry,effect,effect_id)
        except BaseException:
            with owner.sessions() as session,session.begin():
                session.execute(text("UPDATE "+TABLE+" SET phase='UNCERTAIN',updated_at_ms=:now WHERE preview_id=:id AND phase='SENDING'"),{'id':preview_id,'now':owner.clock()})
            return {'phase':'UNCERTAIN','completed':index,'actorId':value['preview']['actorId']}
        with owner.sessions() as session,session.begin():
            latest,_value,_effects,current=load(session,preview_id,owner.key)
            if latest['phase']!='SENDING' or current!=deliveries:fail()
            deliveries.append({'index':index,'effectId':effect_id,'receipt':receipt})
            session.execute(text("UPDATE "+TABLE+" SET phase='PENDING',deliveries=:deliveries,updated_at_ms=:now WHERE preview_id=:id"),
                {'id':preview_id,'deliveries':canonical(deliveries),'now':owner.clock()})
