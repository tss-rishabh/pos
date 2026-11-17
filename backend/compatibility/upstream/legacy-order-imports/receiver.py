"""Native once-only source order creation and source producer delivery.

The private receiver never returns success from an HTTP200 or a paid flag.
Its committed SQL receipts are the only authority consumed by the Node adapter.
"""
import base64
import hashlib
import json
import os
import re
import time
import sys
from pathlib import Path
from datetime import datetime,date
from zoneinfo import ZoneInfo
from sqlalchemy import text
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from protocol import SOURCE_CONTRACT,PUBLICATION_CONTRACT,SOURCE_COMMIT,ImportReview,canonical,digest,verify_capability
from native import lock_command,fresh_authority,native_order,rows,one,json_value
from transaction import private_session
from effects import CAPTURE,publish_once,prepared_calls
from tracing import TRUSTED_ACTOR
from screening_transaction import owned,mark_customer
from membership_profile import additional_lines as member_additions, replaced_lines as member_replacements, receipt as membership_receipt
from correction_profile import CalculatedImportReview,selected as selected_correction

sys.path.insert(0,str(Path(__file__).resolve().parent/'benefit-profile'))


def seal_effects(key,operation_id,intents):
    raw=canonical(intents).encode()
    if len(raw)>1000000:
        raise ImportReview('ORDER_IMPORT_EFFECTS_TOO_LARGE')
    nonce=os.urandom(12)
    secret=hashlib.sha256(('pos-import-effects-v1:'+key).encode()).digest()
    return base64.urlsafe_b64encode(nonce+AESGCM(secret).encrypt(nonce,raw,operation_id.encode())).decode().rstrip('=')


def open_effects(key,operation_id,payload,expected_hash):
    try:
        if len(payload)>1400000:
            raise ValueError()
        raw=base64.urlsafe_b64decode(payload+'='*((4-len(payload)%4)%4))
        secret=hashlib.sha256(('pos-import-effects-v1:'+key).encode()).digest()
        clear=AESGCM(secret).decrypt(raw[:12],raw[12:],operation_id.encode())
        if hashlib.sha256(clear).hexdigest()!=expected_hash:
            raise ValueError()
        value=json.loads(clear)
        if not isinstance(value,list) or len(value)>20:
            raise ValueError()
        return value
    except Exception:
        raise ImportReview('ORDER_IMPORT_EFFECT_PROOF_INVALID') from None


def record(session,operation_id,kind,request_hash,status,proof,key,time_ms):
    session.execute(text("INSERT INTO pos_rewrite_import_financial_source_receipts(id,operation_id,kind,request_hash,status,proof,proof_hash,created_at_ms) VALUES(:id,:op,:kind,:hash,:status,:proof,:seal,:now)"),
        {'id':operation_id+':'+kind,'op':operation_id,'kind':kind,'hash':request_hash,'status':status,
         'proof':canonical(proof),'seal':digest(key,'rejection' if status=='rejected' else kind,proof),'now':time_ms})


def prior(session,operation_id,kind):
    values=rows(session,'SELECT status,proof,proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind=:kind FOR UPDATE',{'op':operation_id,'kind':kind},2)
    return values[0] if values else None


def assert_period(session,capability,plan,now_ms,zone,required_reason=None):
    day=plan['createdAt'][:10]
    created=datetime.strptime(plan['createdAt'],'%Y-%m-%d %H:%M:%S').replace(tzinfo=ZoneInfo(zone))
    now=datetime.fromtimestamp(now_ms/1000,ZoneInfo(zone))
    if created>now:
        raise ImportReview('ORDER_IMPORT_FUTURE_DATE')
    latest=rows(session,'SELECT id,version,status FROM store_day_close WHERE store_id=:store AND close_date=:day ORDER BY version DESC LIMIT 1 FOR UPDATE',{'store':capability['scope']['storeId'],'day':day},2)
    close=None if not latest else {'id':str(latest[0]['id']),'version':latest[0]['version'],'status':latest[0]['status']}
    if close!=capability['authority']['close']:
        raise ImportReview('ORDER_IMPORT_APPROVAL_REQUIRED')
    approval_id=capability['authority']['approvalId']
    if required_reason is not None or day!=now.strftime('%Y-%m-%d') or close is not None:
        if not approval_id:
            raise ImportReview('ORDER_IMPORT_APPROVAL_REQUIRED')
        approval=one(session,'SELECT operation_id,plan_hash,data,authority FROM pos_rewrite_import_financial_approvals WHERE id=:id FOR SHARE',{'id':approval_id})
        grant=json_value(approval['data'])
        authority={**capability['authority'],'approvalId':None}
        if (approval['operation_id']!=capability['operationId'] or approval['plan_hash']!=capability['planHash'] or
            json_value(approval['authority'])!=authority or grant['expiresAt']<=now_ms or grant['issuedAt']>now_ms or
            grant['close']!=close or grant['businessDate']!=day or grant['status']!='approved' or
            (required_reason is not None and
             (grant['reason']!=required_reason or grant['operationId']!=capability['operationId'] or
              grant['actorId']!=capability['scope']['actorId'] or grant['approverId']!=capability['scope']['actorId'] or
              grant['storeId']!=capability['scope']['storeId'] or grant['counterId']!=capability['scope']['counterId'] or
              grant['planHash']!=capability['planHash'] or grant['expiresAt']-grant['issuedAt']!=3600000))):
            raise ImportReview('ORDER_IMPORT_APPROVAL_REQUIRED')


def assert_source_customer(session,capability,plan):
    matches=rows(session,'SELECT id FROM users WHERE email=:email ORDER BY id LIMIT 2 FOR UPDATE',{'email':plan['email']},3) if plan['email'] else []
    if len(matches)>1:
        raise ImportReview('ORDER_IMPORT_CUSTOMER_AMBIGUOUS')
    if not matches and plan['kind']=='offline':
        matches=rows(session,"SELECT id FROM users WHERE pos_admin_id=:id AND user_type='8' ORDER BY id LIMIT 2 FOR UPDATE",{'id':capability['scope']['actorId']},3)
    if len(matches)!=1 or str(matches[0]['id'])!=capability['authority']['customerId']:
        raise ImportReview('ORDER_IMPORT_CUSTOMER_UNAVAILABLE')


def source_user(native,customer_id,exclusive):
    """Exact pinned AuthHandler projection, without its stale Redis cache.

    Its cache serializes DATE with default=str; preserve that JSON-safe source
    representation on the fresh private path. Native credentials/metadata are
    authority inputs only, never coupon/cart payload fields.
    """
    names=('firstname','lastname','email','telephone','tss_money','cashback','tss_points',
           'is_cod_enable','fb_id','gender','birthdate')
    projected={name:native.get(name) for name in names}
    if isinstance(projected['birthdate'],date):projected['birthdate']=str(projected['birthdate'])
    projected.update(user_id=int(customer_id),is_exclusive=bool(exclusive),batch='A')
    try:json.dumps(projected,allow_nan=False)
    except (TypeError,ValueError):raise ImportReview('ORDER_IMPORT_CUSTOMER_UNAVAILABLE') from None
    return projected


class Receiver:
    def __init__(self,session_factory,pipeline,auth_key,proof_key,clock=None,zone='Asia/Kolkata',correction_contract=None):
        self.session_factory=session_factory
        self.pipeline=pipeline
        self.auth_key=auth_key
        self.proof_key=proof_key
        self.clock=clock or (lambda:int(time.time()*1000))
        self.zone=zone
        self.correction_contract=correction_contract
        benefits=getattr(pipeline,'benefits',None)
        if benefits is not None:
            benefits.clock=self.clock;benefits.zone=self.zone

    def preparation(self,operation_id,body):
        from order_preparation import prepare
        return prepare(self,operation_id,body)

    def order(self,operation_id,body):
        if (not isinstance(body,dict) or not {'capability','plan'}.issubset(body)
                or set(body)-{'capability','plan','membershipHistory','couponHistory'}):
            raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
        plan=body['plan']
        cap=verify_capability(self.auth_key,body['capability'],operation_id,'order',plan,self.clock())
        if ('membershipHistory' in body)!=('membershipHistoryHash' in cap):
            raise ImportReview('ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID')
        if ('couponHistory' in body)!=('couponHistoryHash' in cap):
            raise ImportReview('ORDER_IMPORT_COUPON_PREFETCH_INVALID')
        history_key=os.environ.get('POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY','')
        if 'membershipHistory' in body:
            from membership_profile import selected
            if (body['membershipHistory'] is None or not selected()
                    or history_key in (self.auth_key,self.proof_key)):
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID')
        from membership_handoff import prepared_history
        member_ids=[]
        if 'membershipHistory' in body:
            try:
                member_ids=json.loads(os.environ.get('POS_MEMBERSHIP_PRODUCT_IDS','[]'))
                if (not isinstance(member_ids,list) or not 1<=len(member_ids)<=1000
                        or len(set(member_ids))!=len(member_ids)
                        or any(not isinstance(value,str) or not re.fullmatch(r'[1-9][0-9]{0,18}',value)
                               or int(value)>9223372036854775807 for value in member_ids)):
                    raise ValueError()
            except Exception:
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID') from None
        # All parsing/signature/time checks finish before session construction.
        # Scope remains local to this invocation when WSGI threads overlap.
        from coupon_handoff import prepared_coupon_history
        coupon_key=os.environ.get('POS_LEGACY_IMPORT_COUPON_HISTORY_KEY','')
        guard_key=os.environ.get('POS_LEGACY_IMPORT_COUPON_GUARD_KEY','')
        if 'couponHistory' in body and (body['couponHistory'] is None or coupon_key==history_key and history_key):
            raise ImportReview('ORDER_IMPORT_COUPON_PREFETCH_INVALID')
        with prepared_history(body.get('membershipHistory'),cap,self.auth_key,history_key,
                              member_ids,self.zone,self.clock), prepared_coupon_history(body.get('couponHistory'),
                              cap,self.auth_key,coupon_key,self.proof_key,guard_key,self.zone,self.clock):
            return self._order(operation_id,body,plan,cap)

    def _order(self,operation_id,body,plan,cap):
        from authority_succession import actor_hint
        TRUSTED_ACTOR.set(actor_hint(cap))
        self.assert_publisher()
        failure=None
        calculation_review=None
        with self.session_factory() as session:
            try:
                with owned(session,cap):
                    state=lock_command(session,cap,'order',self.auth_key)
                    if state.get('preparationContract')!=cap.get('preparationContract'):
                        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
                    if state.get('benefitContracts')!=cap.get('benefitContracts'):
                        raise ImportReview('ORDER_IMPORT_BENEFIT_CONFIGURATION_REQUIRED')
                    verify_capability(self.auth_key,body['capability'],operation_id,'order',plan,self.clock())
                    existing=prior(session,operation_id,'order')
                    if existing:
                        return {'recorded':True}
                    user=fresh_authority(session,cap)
                    mark_customer(session,cap,str(user['id']))
                    assert_period(session,cap,plan,self.clock(),self.zone,
                                  'historical-correction' if state.get('correction') is not None else None)
                    assert_source_customer(session,cap,plan)
                    # Retain each exact SKU row before source stock checks. No
                    # cached stock result can authorize the final writer.
                    for line in sorted(plan['lines'],key=lambda row:int(row['productId'])):
                        stock=one(session,'SELECT stock,is_avail,is_del FROM product_store WHERE store_id=:store AND product_id=:product FOR UPDATE',{'store':cap['scope']['storeId'],'product':line['productId']})
                        benefits=getattr(self.pipeline,'benefits',None)
                        quantity=benefits.stock_quantity(session,plan,line,cap) if benefits is not None else line['quantity']
                        if stock['stock']<quantity or stock['is_avail']!=1 or stock['is_del']!=0:
                            raise ImportReview('ORDER_IMPORT_STOCK_SHORTAGE')
                    member=rows(session,"SELECT entity FROM user_eav WHERE entity=:email AND attribute='EXCLUSIVE_MEMBER' AND is_active=1 LIMIT 1 FOR SHARE",{'email':user['email']},2)
                    user=source_user(user,cap['authority']['customerId'],bool(member))
                    effects=[]
                    token=CAPTURE.set(effects)
                    try:
                        from contextlib import nullcontext
                        benefits=getattr(self.pipeline,'benefits',None)
                        # Set the authenticated, invocation-local tracking owner
                        # before CURRENT. Cleanup runs after private_session has
                        # reset CURRENT; the late validator guards actual COMMIT.
                        with (benefits.head_scope(session,cap) if benefits is not None else nullcontext()), selected_correction(session,state,cap,plan,self.auth_key,self.proof_key,self.correction_contract), private_session(session) as source_session:
                            order_id,cart=self.pipeline.order_pipeline(source_session,user,plan,cap)
                            session.flush()
                            if benefits is not None:
                                header,lines,line_hash,payable=benefits.native(session,int(order_id),plan,cap,cart,member_additions(cart),member_replacements(cart))
                            else:
                                header,lines,line_hash,payable=native_order(session,int(order_id),plan,cap,member_additions(cart),member_replacements(cart))
                            member_proof=membership_receipt(cart,cap,plan,order_id,header,lines,line_hash)
                            if member_proof:
                                record(session,operation_id,'membership',cap['requestHash'],'completed',member_proof,self.proof_key,self.clock())
                                if member_proof['cacheInvalidations']:
                                    from effects import collector_record
                                    from membership_cache import journal_options
                                    collector_record({'call':{'name':'pos_import_invalidate_membership',
                                        'args':[operation_id,digest(self.proof_key,'membership',member_proof)],
                                        'kwargs':{},'options':journal_options()}})
                            if benefits is not None:
                                benefits.capture(session,state,plan,cap,cart,{
                                    'orderId':order_id,'method':14 if plan['kind']=='offline' else 15,
                                    'headerHash':header['native_hash'],'lineHash':line_hash,
                                    'lineItemsEnabled':bool(self.pipeline.settings.IS_LINE_ITEM_ENABLED),
                                    'lines':lines,'payable':payable})
                    finally:
                        CAPTURE.reset(token)
                    effects.extend(self.pipeline.publication_intents(order_id))
                    for intent in effects:prepared_calls(self.pipeline.tasks,intent)
                    effects_hash=hashlib.sha256(canonical(effects).encode()).hexdigest()
                    proof={'contract':SOURCE_CONTRACT,'operationId':operation_id,'requestHash':cap['requestHash'],
                        'namespace':cap['namespace'],'customerId':cap['authority']['customerId'],
                        'storeId':cap['scope']['storeId'],'counterId':cap['scope']['counterId'],
                        'createdAt':plan['createdAt'],'orderId':order_id,'headerHash':header['native_hash'],
                        'lineHash':line_hash,'method':14 if plan['kind']=='offline' else 15,'payable':payable,
                        'refundAllocationContract':'pos-refund-per-hp-v1',
                        'refundSourcePatchHash':'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
                        'sourceCommit':SOURCE_COMMIT,'sourceControllerHash':self.pipeline.controller_hash,
                        'lineItemsEnabled':bool(self.pipeline.settings.IS_LINE_ITEM_ENABLED),'lines':lines,'effectsHash':effects_hash}
                    verify_capability(self.auth_key,body['capability'],operation_id,'order',plan,self.clock())
                    record(session,operation_id,'order',cap['requestHash'],'completed',proof,self.proof_key,self.clock())
                    session.execute(text("INSERT INTO pos_rewrite_import_financial_order_bindings(order_id,operation_id,request_hash,proof_hash,status) VALUES(:order,:op,:hash,:seal,'held')"),
                        {'order':order_id,'op':operation_id,'hash':cap['requestHash'],'seal':digest(self.proof_key,'order',proof)})
                    session.execute(text("INSERT INTO pos_rewrite_import_financial_source_effects(operation_id,payload,effects_hash,status,deliveries,created_at_ms,updated_at_ms) VALUES(:op,:payload,:hash,'pending','[]',:now,:now)"),
                        {'op':operation_id,'payload':seal_effects(self.proof_key,operation_id,effects),'hash':effects_hash,'now':self.clock()})
                return {'recorded':True}
            except Exception as error:
                # Transaction rollback is complete before a permanent negative
                # receipt is written. It owns the same operation lock, so a
                # delayed duplicate cannot later create a supposedly absent order.
                failure=error.code if isinstance(error,ImportReview) else 'ORDER_IMPORT_SOURCE_REVIEW'
                calculation_review=error if type(error) is CalculatedImportReview else None
            with owned(session,cap):
                lock_command(session,cap,'order',self.auth_key)
                if prior(session,operation_id,'order'):
                    return {'recorded':True}
                bound=rows(session,'SELECT order_id FROM pos_rewrite_import_financial_order_bindings WHERE operation_id=:op FOR UPDATE',{'op':operation_id},2)
                if bound:
                    raise ImportReview('ORDER_IMPORT_ORIGINAL_STAGE_UNCERTAIN')
                proof={'contract':SOURCE_CONTRACT,'operationId':operation_id,'requestHash':cap['requestHash'],
                       'namespace':cap['namespace'],'status':'rejected','code':failure,'noFinancialEffects':True}
                rejected_at=self.clock()
                if calculation_review is not None:
                    proof['review']=calculation_review.sealed_review(cap,self.proof_key,rejected_at)
                record(session,operation_id,'order',cap['requestHash'],'rejected',proof,self.proof_key,rejected_at)
            return {'recorded':True}

    def publication(self,operation_id,body):
        if not isinstance(body,dict) or set(body)!={'capability','orderId'}:
            raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
        cap=verify_capability(self.auth_key,body['capability'],operation_id,'publication',None,self.clock())
        from authority_succession import actor_hint
        TRUSTED_ACTOR.set(actor_hint(cap))
        if body['orderId']!=cap['orderId']:
            raise ImportReview('ORDER_IMPORT_NATIVE_SCOPE_INVALID')
        self.assert_publisher()
        with self.session_factory() as session:
            with owned(session,cap):
                lock_command(session,cap,'publication',self.auth_key)
                if prior(session,operation_id,'publication'):
                    return {'recorded':True}
                user=fresh_authority(session,cap)
                mark_customer(session,cap,str(user['id']))
                source=prior(session,operation_id,'order')
                if not source or source['status']!='completed':
                    raise ImportReview('ORDER_IMPORT_ORDER_UNCONFIRMED')
                order=json_value(source['proof'])
                if (source['proof_hash']!=digest(self.proof_key,'order',order) or order['orderId']!=cap['orderId'] or order['requestHash']!=cap['requestHash']):
                    raise ImportReview('ORDER_IMPORT_ORDER_UNCONFIRMED')
                settled=one(session,"SELECT status FROM pos_rewrite_import_financial_stages WHERE operation_id=:op AND kind='settlement' FOR SHARE",{'op':operation_id})
                effects=one(session,'SELECT payload,effects_hash,status,deliveries FROM pos_rewrite_import_financial_source_effects WHERE operation_id=:op AND OCTET_LENGTH(payload)<=1400000 FOR UPDATE',{'op':operation_id})
                if settled['status']!='confirmed' or effects['status']!='pending' or effects['effects_hash']!=order['effectsHash']:
                    raise ImportReview('ORDER_IMPORT_ORIGINAL_STAGE_UNCERTAIN')
                intents=open_effects(self.proof_key,operation_id,effects['payload'],effects['effects_hash'])
                session.execute(text("UPDATE pos_rewrite_import_financial_source_effects SET status='processing',updated_at_ms=:now WHERE operation_id=:op"),{'op':operation_id,'now':self.clock()})
        deliveries=[]
        try:
            for intent in intents:
                delivery=publish_once(self.pipeline.tasks,intent)
                deliveries.append(delivery)
                with self.session_factory() as session, session.begin():
                    session.execute(text('UPDATE pos_rewrite_import_financial_source_effects SET deliveries=:jobs,updated_at_ms=:now WHERE operation_id=:op'),{'jobs':canonical(deliveries),'now':self.clock(),'op':operation_id})
        except Exception:
            with self.session_factory() as session, session.begin():
                session.execute(text("UPDATE pos_rewrite_import_financial_source_effects SET status='uncertain',updated_at_ms=:now WHERE operation_id=:op"),{'now':self.clock(),'op':operation_id})
            raise ImportReview('ORDER_IMPORT_PUBLICATION_UNCONFIRMED') from None
        with self.session_factory() as session, owned(session,cap,factual=True):
            lock_command(session,cap,'publication',self.auth_key,factual=True)
            proof={'contract':PUBLICATION_CONTRACT,'operationId':operation_id,'orderId':cap['orderId'],
                'requestHash':cap['requestHash'],'sourceHash':effects['effects_hash'],'acceptedAt':self.clock(),
                'delivery':'durable-queue-accepted','jobs':deliveries}
            if cap.get('succession'):
                from authority_succession import reference
                proof['succession']=reference(cap['succession'])
            record(session,operation_id,'publication',cap['requestHash'],'completed',proof,self.proof_key,self.clock())
            session.execute(text("UPDATE pos_rewrite_import_financial_source_effects SET status='accepted',updated_at_ms=:now WHERE operation_id=:op"),{'now':self.clock(),'op':operation_id})
        return {'recorded':True}

    def assert_publisher(self):
        ready=getattr(self.pipeline.tasks,'assert_ready',None)
        if callable(ready):ready()
        conf=self.pipeline.tasks.app.conf
        if (not str(conf.broker_url).startswith('amqps://') or
            conf.broker_transport_options.get('confirm_publish') is not True or conf.task_publish_retry is not False or
            conf.task_default_delivery_mode not in (2,'persistent')):
            raise ImportReview('ORDER_IMPORT_PUBLISHER_UNQUALIFIED')
