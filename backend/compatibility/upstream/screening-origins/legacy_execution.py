"""Original legacy request fence and atomic cash-completion receipt.

The original creation/Go HTTP calls run without native transaction locks. The
native cash helper and its receipt commit together; its HTTP producers are
retained separately. Unknown original source work is never blindly replayed.
"""
import base64
import functools
import hashlib
import hmac
import json
import os
import time
from contextvars import ContextVar
from contextlib import contextmanager
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from origin_contracts import UUID,canonical,digest,fail
from legacy_staff import key,database,authenticated,actor,scope,one,rows,assert_request_epoch
from writer_protocol import portable_hash

ACTIVE=ContextVar('screening_legacy_original_request',default=None)
NATIVE=ContextVar('screening_legacy_native_cash',default=None)


def seal(secret,identity,value):
    nonce=os.urandom(12);cipher=AESGCM(hashlib.sha256(('screening-origin-legacy-response.v1:'+secret).encode()).digest())
    return base64.urlsafe_b64encode(nonce+cipher.encrypt(nonce,value,identity.encode())).decode().rstrip('=')


def opened(secret,identity,value):
    try:
        raw=base64.urlsafe_b64decode(value+'='*((4-len(value)%4)%4))
        return AESGCM(hashlib.sha256(('screening-origin-legacy-response.v1:'+secret).encode()).digest()).decrypt(raw[:12],raw[12:],identity.encode())
    except Exception:fail('SCREENING_ORIGIN_RECONCILIATION_REQUIRED')


def work(cursor,command,secret,lock=True):
    found=rows(cursor,'SELECT data,proof_hash,response_payload FROM pos_rewrite_screening_origin_legacy_work WHERE command_id=%s'+(' FOR UPDATE' if lock else ''),(command,))
    if not found:return None
    row=found[0];value=json.loads(row['data']) if isinstance(row['data'],str) else row['data']
    if (not isinstance(value,dict) or set(value)!={'contract','commandId','origin','actorId','sessionHash','requestHash','state','orderId','updatedAt'}
            or value['contract']!='pos-screening-legacy-request-v1' or value['commandId']!=command
            or value['state'] not in ('RUNNING','UNCERTAIN','COMPLETE')
            or not hmac.compare_digest(digest(secret,'legacy-request',value),row['proof_hash'])):fail()
    return row,value


def save(cursor,value,secret,response_payload=None):
    cursor.execute('UPDATE pos_rewrite_screening_origin_legacy_work SET data=%s,proof_hash=%s,response_payload=COALESCE(%s,response_payload) WHERE command_id=%s',
                   (canonical(value),digest(secret,'legacy-request',value),response_payload,value['commandId']))


def request_digest(request):
    # Store only a digest; no customer JWT/form/address/message in metadata.
    body={name:request.POST.getlist(name) for name in request.POST if name not in ('csrfmiddlewaretoken','screening_command')}
    return portable_hash(body)


def original_request(function):
    @functools.wraps(function)
    def wrapped(view,request,*args,**kwargs):
        command=request.META.get('HTTP_X_TSS_SCREENING_COMMAND') or request.POST.get('screening_command')
        if command is None:return function(view,request,*args,**kwargs)
        if ACTIVE.get() is not None:return function(view,request,*args,**kwargs)
        if not isinstance(command,str) or not UUID.fullmatch(command):fail('SCREENING_ORIGIN_REQUEST_INVALID')
        from django.db import transaction
        from django.http import HttpResponse,JsonResponse
        secret=key();alias,connection=database();now=int(time.time()*1000)
        origin,actor_id,session_hash,_mpos=authenticated(request,secret,now)
        if request.META.get('HTTP_X_TSS_SCREENING_ACTOR')!=actor_id:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
        with transaction.atomic(using=alias),connection.cursor() as cursor:
            native,_identity=actor(cursor,actor_id,secret);assert_request_epoch(request,native,origin)
            # If the original order already exists, its genuine current Store
            # authority precedes the request-row lock on replay as on payment.
            hints=rows(cursor,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_creations WHERE command_id=%s',(command,))
            if hints:
                existing=json.loads(hints[0]['data']) if isinstance(hints[0]['data'],str) else hints[0]['data']
                if (existing.get('actorId')!=actor_id or existing.get('origin')!=origin
                        or not hmac.compare_digest(digest(secret,'creation',existing),hints[0]['proof_hash'])):fail()
                scope(cursor,native,existing['storeId'],existing['counterId'])
            prior=work(cursor,command,secret)
            if prior is not None:
                row,value=prior
                if any(value[name]!=expected for name,expected in (('actorId',actor_id),('origin',origin),('sessionHash',session_hash),('requestHash',request_digest(request)))):fail('SCREENING_ORIGIN_SCOPE_CHANGED')
                if value['state']=='COMPLETE' and row['response_payload']:
                    result=HttpResponse(opened(secret,command,row['response_payload']),content_type='application/json')
                    result['Cache-Control']='no-store';return result
                # A lost original response recovers through GET. No second
                # original view, source order, Go submit or cash helper runs.
                return JsonResponse({'status':202,'commandId':command,'state':'reconciling','message':'Check the original command outcome.'},status=202)
            value={'contract':'pos-screening-legacy-request-v1','commandId':command,'origin':origin,'actorId':actor_id,
                   'sessionHash':session_hash,'requestHash':request_digest(request),'state':'RUNNING','orderId':None,'updatedAt':now}
            cursor.execute('INSERT INTO pos_rewrite_screening_origin_legacy_work(command_id,data,proof_hash,response_payload) VALUES(%s,%s,%s,NULL)',
                           (command,canonical(value),digest(secret,'legacy-request',value)))
        current={'value':value,'request':request,'secret':secret,'effects':[]}
        token=ACTIVE.set(current)
        try:
            result=function(view,request,*args,**kwargs)
            content=bytes(result.content)
            if len(content)>500000:fail('SCREENING_ORIGIN_RESPONSE_TOO_LARGE')
            with transaction.atomic(using=alias),connection.cursor() as cursor:
                _row,saved=work(cursor,command,secret)
                # Original response and atomic native cash proof are retained;
                # body encryption does not make a paid/HTTP flag authoritative.
                updated={**saved,'state':'COMPLETE','updatedAt':int(time.time()*1000)}
                save(cursor,updated,secret,seal(secret,command,content))
            result['Cache-Control']='no-store';return result
        except Exception:
            with transaction.atomic(using=alias),connection.cursor() as cursor:
                prior=work(cursor,command,secret)
                if prior and prior[1]['state']!='COMPLETE':save(cursor,{**prior[1],'state':'UNCERTAIN','updatedAt':int(time.time()*1000)},secret)
            return JsonResponse({'status':202,'commandId':command,'state':'reconciling','message':'Check the original command outcome.'},status=202)
        finally:ACTIVE.reset(token)
    return wrapped


def command_created(command_id,order_id):
    current=ACTIVE.get()
    if current is None or current['value']['commandId']!=command_id:fail()
    from django.db import transaction
    alias,connection=database()
    with transaction.atomic(using=alias),connection.cursor() as cursor:
        _row,value=work(cursor,command_id,current['secret'])
        if value['orderId'] not in (None,str(order_id)):fail()
        value={**value,'orderId':str(order_id),'updatedAt':int(time.time()*1000)}
        save(cursor,value,current['secret']);current['value']=value


@contextmanager
def counter_entry(cursor,customer_id,order_id):
    names=[]
    def acquire(kind,identity):
        name=one(cursor,"SELECT CONCAT('pos-screening:',LEFT(SHA2(DATABASE(),256),16),':',%s,':',%s) AS name",(kind,str(identity)))['name']
        if one(cursor,'SELECT GET_LOCK(%s,0) AS acquired',(name,))['acquired']!=1:fail('SCREENING_ORIGIN_WRITER_BUSY')
        names.append(name)
    try:
        acquire('u',customer_id);acquire('o',order_id)
        lines=rows(cursor,'SELECT id FROM has_products WHERE order_id=%s ORDER BY id LIMIT 1001 FOR UPDATE',(order_id,))
        if len(lines)>1000:fail()
        for line in lines:acquire('p',line['id'])
        yield
    finally:
        for name in reversed(names):cursor.execute('SELECT RELEASE_LOCK(%s)',(name,));cursor.fetchone()


def cash_completion(original):
    """Wrap the literal Helpers.complete_order; no cash arithmetic is replaced."""
    @functools.wraps(original)
    def completed(order_id,transaction_id,message,cash,cash_recieved,amount,store_id,user_id,*args,**kwargs):
        current=ACTIVE.get()
        if current is None:return original(order_id,transaction_id,message,cash,cash_recieved,amount,store_id,user_id,*args,**kwargs)
        if args or kwargs.get('custom_date') or kwargs.get('others') or kwargs.get('is_terminal'):fail('SCREENING_ORIGIN_CASH_PROFILE_UNQUALIFIED')
        from django.db import transaction,router
        from order.models import Order,HasProduct,OrderStore
        secret=current['secret'];alias,connection=database();value=current['value']
        if any(router.db_for_write(model)!=alias for model in (Order,HasProduct,OrderStore)):fail('SCREENING_ORIGIN_AUTH_NAMESPACE_CHANGED')
        if str(user_id)!=value['actorId'] or value['orderId']!=str(order_id):fail('SCREENING_ORIGIN_SCOPE_CHANGED')
        signature=digest(secret,'legacy-cash-input',{'commandId':value['commandId'],'orderId':str(order_id),'transactionId':transaction_id,
            'message':message,'cash':cash,'received':cash_recieved,'amount':amount,'storeId':str(store_id),'actorId':str(user_id)})
        if connection.in_atomic_block:fail('SCREENING_ORIGIN_TRANSACTION_REQUIRED')
        with connection.cursor() as cursor:cursor.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        with transaction.atomic(using=alias),connection.cursor() as cursor:
            native,_identity=actor(cursor,user_id,secret)
            origin=one(cursor,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_creations WHERE command_id=%s',(value['commandId'],))
            creation=json.loads(origin['data']) if isinstance(origin['data'],str) else origin['data']
            if (creation.get('orderId')!=str(order_id) or creation.get('actorId')!=str(user_id) or creation.get('storeId')!=str(store_id)
                    or not hmac.compare_digest(digest(secret,'creation',creation),origin['proof_hash'])):fail()
            scope(cursor,native,store_id,creation['counterId'])
            now=int(time.time()*1000)
            actual_origin,actual_actor,session_hash,session_record=authenticated(current['request'],secret,now)
            assert_request_epoch(current['request'],native,actual_origin)
            if (actual_origin!=value['origin'] or actual_actor!=value['actorId'] or session_hash!=value['sessionHash']
                    or session_record is not None and session_record.get('identityHash')!=_identity):fail('SCREENING_ORIGIN_STAFF_REVOKED')
            retained=one(cursor,'SELECT data,proof_hash,revoked FROM pos_rewrite_screening_origin_sessions WHERE session_hash=%s FOR SHARE',(session_hash,))
            record=json.loads(retained['data']) if isinstance(retained['data'],str) else retained['data']
            if (retained['revoked']!=0 or record.get('actorId')!=actual_actor or record.get('origin')!=actual_origin
                    or record.get('identityHash')!=_identity or record.get('expiresAt',0)<=now
                    or not hmac.compare_digest(digest(secret,'mpos-session' if actual_origin=='mpos' else 'legacy-session',record),retained['proof_hash'])):fail('SCREENING_ORIGIN_STAFF_REVOKED')
            from helpers.helpers import Helpers
            checked=Helpers.get_checkin_data(actual_actor)
            if not checked or str(checked[0])!=str(store_id):fail('SCREENING_ORIGIN_STAFF_REVOKED')
            one(cursor,'SELECT id FROM users WHERE id=%s FOR UPDATE',(creation['customerId'],))
            from legacy_assets import NativeSession
            from origin_ledger import read as read_origin,payment as verified_payment
            source_command=read_origin(NativeSession(cursor),value['commandId'],creation['customerId'],secret)
            if (source_command is None or source_command['phase'] not in ('BOUND','COUNTED') or source_command['creationHash']!=origin['proof_hash']
                    or source_command['orderId']!=str(order_id)):fail('SCREENING_ORIGIN_PAYMENT_PROOF_REQUIRED')
            _row,saved=work(cursor,value['commandId'],secret)
            prior=rows(cursor,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_legacy_cash WHERE command_id=%s FOR UPDATE',(value['commandId'],))
            if prior:
                proof=json.loads(prior[0]['data']) if isinstance(prior[0]['data'],str) else prior[0]['data']
                if proof.get('inputHash')!=signature or not hmac.compare_digest(digest(secret,'legacy-cash',proof),prior[0]['proof_hash']):fail()
                return True
            payment=one(cursor,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_payments WHERE command_id=%s AND order_id=%s FOR SHARE',(value['commandId'],order_id))
            paid=json.loads(payment['data']) if isinstance(payment['data'],str) else payment['data']
            if (paid.get('status')!='CONFIRMED' or paid.get('creationHash')!=origin['proof_hash'] or
                not hmac.compare_digest(digest(secret,'payment',paid),payment['proof_hash'])):fail('SCREENING_ORIGIN_PAYMENT_PROOF_REQUIRED')
            if verified_payment(NativeSession(cursor),source_command,secret)!=paid:fail('SCREENING_ORIGIN_PAYMENT_PROOF_REQUIRED')
            from legacy_assets import prepare as prepare_assets,lock_order_assets,finish as finish_assets
            asset_state=prepare_assets(cursor,creation,origin['proof_hash'],paid,payment['proof_hash'],secret)
            from native import HEADER,LINE
            order=one(cursor,'SELECT user_id,payment_status,order_status,'+HEADER+' AS hash FROM orders WHERE id=%s FOR UPDATE',(order_id,))
            if (str(order['user_id'])!=creation['customerId'] or order['hash']!=creation['headerHash']
                    or order['order_status']!=paid.get('after',{}).get('orderStatus') or order['payment_status']!=paid.get('after',{}).get('paymentStatus')
                    or order['order_status'] in (0,4,17)):fail('SCREENING_ORIGIN_CASH_RECONCILIATION_REQUIRED')
            if order['payment_status']==4 and (cash!=0 or amount!=0):fail('SCREENING_ORIGIN_CASH_ALREADY_FUNDED')
            lines=rows(cursor,'SELECT id,prod_id,qty,'+LINE+' AS hash FROM has_products WHERE order_id=%s ORDER BY id LIMIT 1001 FOR UPDATE',(order_id,))
            expected=[{'id':str(line['id']),'productId':str(line['prod_id']),'quantity':line['qty'],'inputHash':line['hash']} for line in lines]
            if expected!=creation['lines']:fail('SCREENING_ORIGIN_CASH_RECONCILIATION_REQUIRED')
            lock_order_assets(cursor,creation,asset_state)
            native_effects=[];token=NATIVE.set(native_effects)
            try:
                with counter_entry(cursor,creation['customerId'],order_id):
                    result=original(order_id,transaction_id,message,cash,cash_recieved,amount,store_id,user_id,*args,**kwargs)
                if result is not True:fail('SCREENING_ORIGIN_CASH_RECONCILIATION_REQUIRED')
                final=one(cursor,"SELECT LOWER(SHA2(CAST(JSON_OBJECT('orderId',o.id,'paymentStatus',o.payment_status,'orderStatus',o.order_status,'method',o.payment_method,'payable',o.pay_amt,'store',s.store_id,'counter',s.counter_id,'manual',s.is_manually_paid,'cash',s.offline_payment,'received',s.offline_payment_recieved,'online',s.online_payment,'other',s.online_other_payment,'transaction',s.transaction_id) AS CHAR CHARACTER SET utf8mb4),256)) AS hash FROM orders o JOIN order_stores s ON s.order_id=o.id WHERE o.id=%s FOR SHARE",(order_id,))
                proof={'contract':'pos-screening-legacy-cash-v1','commandId':value['commandId'],'orderId':str(order_id),'actorId':str(user_id),
                    'storeId':str(store_id),'inputHash':signature,'creationHash':origin['proof_hash'],'paymentHash':payment['proof_hash'],
                    'nativeFinalHash':final['hash'],'effectsHash':hashlib.sha256(canonical(native_effects).encode()).hexdigest(),'createdAt':int(time.time()*1000)}
                final_assets=finish_assets(cursor,creation,origin['proof_hash'],asset_state,proof,secret,proof['createdAt'])
                if final_assets is not None:proof['assetFinalizationHash']=final_assets
                cursor.execute('INSERT INTO pos_rewrite_screening_origin_legacy_cash(command_id,order_id,data,proof_hash,effects,phase) VALUES(%s,%s,%s,%s,%s,%s)',
                    (value['commandId'],order_id,canonical(proof),digest(secret,'legacy-cash',proof),canonical(native_effects),'PENDING'))
                return True
            finally:NATIVE.reset(token)
    return completed


def defer_helper(name,original):
    @functools.wraps(original)
    def called(*args,**kwargs):
        target=NATIVE.get()
        if target is None:return original(*args,**kwargs)
        if kwargs or len(args)!=1 or name not in ('push_order_kinesis','push_for_em'):fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
        target.append({'name':name,'orderId':str(args[0])})
        return None
    return called


def install(namespace):
    from django.contrib.auth.signals import user_logged_in
    from legacy_staff import record_login
    user_logged_in.connect(record_login,dispatch_uid='screening-origin.original-django-login',weak=False)
    for name in ('AjaxOrderView','AjaxFastCheckoutView'):
        namespace[name].post=original_request(namespace[name].post)
    helpers=namespace['Helpers']
    helpers.complete_order=staticmethod(cash_completion(helpers.complete_order))
    for name in ('push_order_kinesis','push_for_em'):setattr(helpers,name,staticmethod(defer_helper(name,getattr(helpers,name))))
    import requests
    request=requests.sessions.Session.request
    def controlled(instance,*args,**kwargs):
        if NATIVE.get() is not None:fail('SCREENING_ORIGIN_HTTP_UNQUALIFIED')
        return request(instance,*args,**kwargs)
    requests.sessions.Session.request=controlled
