"""Real CSK prefix capture and rollback-only pre-command cart construction."""
import copy
import hashlib
import hmac
from contextlib import ExitStack
from sqlalchemy import text
from origin_contracts import canonical,digest,fail
from origin_auth import authority_hash
from native import one,rows,json_value
from origin_effects import seal_effects,open_effects
from system_preparation import copied,assert_attempt

TABLE='pos_rewrite_screening_origin_system_cart_prefixes'


def saved(session,command,key,lock=True):
    found=rows(session,'SELECT customer_id,data,proof_hash,payload,payload_hash FROM '+TABLE+' WHERE command_id=:id AND OCTET_LENGTH(data)<=16000 AND OCTET_LENGTH(payload)<=1400000'+(' FOR SHARE' if lock else ''),{'id':command},2)
    if not found:
        if rows(session,'SELECT command_id FROM '+TABLE+' WHERE command_id=:id',{'id':command},1):fail('SCREENING_ORIGIN_PREPARATION_INVALID')
        return None
    row=found[0];body=json_value(row['data'])
    if (not isinstance(body,dict) or set(body)!={'contract','commandId','customerId','authorityHash','requestHash','referenceHash','payloadHash','createdAt'}
            or body['contract']!='pos-screening-system-cart-prefix-v1' or body['commandId']!=command or body['customerId']!=str(row['customer_id'])
            or body['payloadHash']!=row['payload_hash'] or not hmac.compare_digest(digest(key,'system-cart-prefix',body),row['proof_hash'])):fail()
    payload=open_effects(key,'system-cart-prefix:'+command,row['payload'],row['payload_hash'])
    if len(payload)!=1:fail()
    return body,payload[0]


def customer_hint(session,command,key):
    """Authenticated unlocked hint only; caller locks/rechecks before acting."""
    hints=rows(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command},2)
    prefix=saved(session,command,key,lock=False)
    customer=str(hints[0]['customer_id']) if hints else (prefix[0]['customerId'] if prefix is not None else None)
    if prefix is not None and customer!=prefix[0]['customerId']:fail()
    return customer


def freeze(context,cart,products,address):
    owner=context.owner.runtime;req=context.req
    prefix=req.context['session']
    if any(getattr(model,'__tablename__',None) in ('orders','has_products','spiderman_screening_orders') for model in list(prefix.new)+list(prefix.dirty)):fail()
    # The actual original customer/address prefix finishes before history I/O.
    prefix.commit();prefix.close()
    payload=copied({'user':req.context['user'],'data':req.context['data'],'cart':cart.get_snapshot(),
                    'products':products,'address':address,'accessRoute':req.access_route})
    checksum=hashlib.sha256(canonical([payload]).encode()).hexdigest()
    with owner.sessions() as session,session.begin():
        session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        _native,current,_grant=context.authorize(session,req)
        state=assert_attempt(session,context)
        prior=saved(session,context.command_id,owner.key)
        if prior is not None:
            if prior[0]['authorityHash']!=authority_hash(owner.key,current) or prior[0]['requestHash']!=state['requestHash']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
            return prior
        body={'contract':'pos-screening-system-cart-prefix-v1','commandId':context.command_id,'customerId':current['customerId'],
              'authorityHash':authority_hash(owner.key,current),'requestHash':state['requestHash'],'referenceHash':context.reference_hash,
              'payloadHash':checksum,'createdAt':owner.clock()}
        encrypted=seal_effects(owner.key,'system-cart-prefix:'+context.command_id,[payload])
        if len(encrypted)>1400000:fail('SCREENING_ORIGIN_PREPARATION_INVALID')
        session.execute(text('INSERT INTO '+TABLE+'(command_id,customer_id,data,proof_hash,payload,payload_hash) VALUES(:id,:customer,:data,:proof,:payload,:hash)'),
            {'id':context.command_id,'customer':current['customerId'],'data':canonical(body),'proof':digest(owner.key,'system-cart-prefix',body),'payload':encrypted,'hash':checksum})
        return body,payload


def build(context,builder,prefix):
    """Only the pinned original cart-building body runs in this preview."""
    from origin_frame import LegacySession,request_hash
    from origin_preview import context as make_context,PreviewFrame,_source_scope
    from origin_membership_history import NeedOriginMembershipHistory
    from middleware.CartMiddleware import CartFactory
    from controllers.priceList.PricelistManager import PricelistManager
    from writer_protocol import portable_hash
    owner=context.owner.runtime;metadata,payload=prefix;req=context.req
    if owner.coupons is not None:
        from origin_coupon_preview import NeedCouponPreview
    else:
        class NeedCouponPreview(BaseException):pass
    req.context['user']=copy.deepcopy(payload['user']);req.context['data']=copy.deepcopy(payload['data'])
    with owner.sessions() as session,session.begin():
        session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        _native,current,_grant=context.authorize(session,req);assert_attempt(session,context)
        if authority_hash(owner.key,current)!=metadata['authorityHash']:fail('SCREENING_ORIGIN_AUTHORITY_SUCCESSOR_REQUIRED')
        preview=make_context(owner,current,context.namespace(),portable_hash(payload['cart']),request_hash(req),'csk-cart-build')
    snapshot=owner.coupons.snapshot(preview['customerId']) if owner.coupons is not None else None
    member_document=None;coupon_documents={}
    for _round in range(6):
        needed=None
        req.context['user']=copy.deepcopy(payload['user']);req.context['data']=copy.deepcopy(payload['data'])
        try:
            with owner.sessions() as session,session.begin():
                session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                native,current,_grant=context.authorize(session,req);assert_attempt(session,context)
                if (owner.clock()>=preview['expiresAt'] or authority_hash(owner.key,current)!=preview['authorityHash']
                        or saved(session,context.command_id,owner.key)!=prefix):fail('SCREENING_ORIGIN_PREVIEW_CHANGED')
                frame=PreviewFrame(owner,req,session,preview,context.namespace(),native)
                seed=CartFactory.empty_cart();seed.context=req.context;seed.restore(copy.deepcopy(payload['cart']))
                from controllers.cart.Cart import ItemTypes
                meta={'items':copy.deepcopy(seed.get(ItemTypes.META))}
                with ExitStack() as stack:
                    _source_scope(frame,stack,snapshot,coupon_documents,member_document,meta)
                    req.context['cart']=seed
                    req.context['pricelist_manager']=PricelistManager(req.context)
                    builder(req,seed,copy.deepcopy(payload['products']),copy.deepcopy(payload['address']),copy.deepcopy(context.payload))
                    if frame.effects or frame.persists:fail('SCREENING_ORIGIN_SYSTEM_PREVIEW_EFFECT_FORBIDDEN')
                    final=copied(seed.get_snapshot());user=copied(req.context['user']);data=copied(req.context['data'])
                # Source preview never commits a row, claim or effect receipt.
                session.rollback()
            prefix_session=owner.sessions();req.context['session']=LegacySession(prefix_session)
            req.context['user']=user;req.context['data']=data
            cart=CartFactory.empty_cart();cart.context=req.context;cart.restore(final)
            req.context['cart']=cart;req.context['pricelist_manager']=PricelistManager(req.context)
            req.context['pricelist_manager'].set_strict_pricelist([context.owner.namespace['settings'].CSK_PRICELIST])
            context.cart=cart
            return
        except (NeedOriginMembershipHistory,NeedCouponPreview) as missing:needed=missing
        if isinstance(needed,NeedOriginMembershipHistory):
            if owner.membership_history_provider is None:fail('SCREENING_ORIGIN_MEMBERSHIP_REQUIRED')
            member_document=owner.membership_history_provider.preview(preview,needed.scope,needed.head)
        elif isinstance(needed,NeedCouponPreview):
            if owner.coupon_preview_provider is None:fail('SCREENING_ORIGIN_COUPON_PREVIEW_REQUIRED')
            identity=digest(owner.key,'coupon-preview-request',needed.request)
            if identity in coupon_documents:fail('SCREENING_ORIGIN_COUPON_PREVIEW_CHANGED')
            coupon_documents[identity]=owner.coupon_preview_provider.read(needed.request)
        else:fail()
    fail('SCREENING_ORIGIN_PREVIEW_REQUIRED')
