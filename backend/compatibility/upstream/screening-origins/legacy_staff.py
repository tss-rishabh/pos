"""Purpose-specific grants from real legacy Django/MPos authentication.

This module runs in the legacy POS process. It does not import the API-v2
runtime, mint a customer JWT, or authorize a Node checkout/operator capability.
"""
import hmac
import json
import os
import re
import time
from uuid import uuid4,UUID as NativeUUID
from origin_contracts import CONTRACT,UUID,canonical,digest,identifier,fail
from writer_protocol import portable_hash

COOKIE='tss_screening_mpos'
LOGIN_EPOCH='_screening_original_auth_epoch'


def database():
    from django.db import connections
    alias=os.environ.get('POS_SCREENING_ORIGIN_DJANGO_ALIAS','mysql_db')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',alias):fail('SCREENING_ORIGIN_UNAVAILABLE')
    return alias,connections[alias]


def key():
    if os.environ.get('POS_SCREENING_ORIGIN_CONTRACT')!=CONTRACT:fail('SCREENING_ORIGIN_UNAVAILABLE')
    value=os.environ.get('POS_SCREENING_ORIGIN_PROOF_KEY','');digest(value,'ready',None)
    others=('POS_LEGACY_IMPORT_PROOF_KEY','POS_PUBLIC_SCREENING_NEGATIVE_KEY','POS_MEMBERSHIP_PROOF_KEY',
            'TSS_POS_CUSTOMER_CONTEXT_KEY','POS_LEGACY_IMPORT_KEY','POS_PUBLIC_SCREENING_PUBLICATION_KEY',
            'POS_SCREENING_ORIGIN_HISTORY_CAPTURE_KEY','POS_SCREENING_ORIGIN_HISTORY_PUBLICATION_KEY')
    if any(value==os.environ.get(name) for name in others):fail('SCREENING_ORIGIN_KEY_REQUIRED')
    from django.conf import settings
    if value in (settings.SECRET_KEY,getattr(settings,'SECRET_KEY_512',None)):fail('SCREENING_ORIGIN_KEY_REQUIRED')
    return value


def rows(cursor,sql,params=()):
    cursor.execute(sql,params);names=[field[0] for field in cursor.description]
    values=[dict(zip(names,row)) for row in cursor.fetchmany(1002)]
    if len(values)>1001:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
    return values


def one(cursor,sql,params=()):
    values=rows(cursor,sql,params)
    if len(values)!=1:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
    return values[0]


def actor(cursor,actor_id,secret):
    value=one(cursor,'SELECT id,password,role,user_type,is_active FROM pos_user WHERE id=%s FOR SHARE',(identifier(actor_id),))
    if value['is_active']!=1 or int(value['role']) not in (1,2,3,4,5) or int(value['user_type']) not in (1,2):fail('SCREENING_ORIGIN_STAFF_REVOKED')
    epochs=rows(cursor,'SELECT CAST(epoch AS CHAR) AS epoch FROM pos_rewrite_operator_auth_epochs WHERE operator_id=%s FOR SHARE',(str(value['id']),))
    epoch='0' if not epochs else epochs[0]['epoch']
    if not isinstance(epoch,str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}',epoch) or int(epoch)>18446744073709551615:fail('SCREENING_ORIGIN_STAFF_REVOKED')
    value['authEpoch']=epoch
    return value,digest(secret,'staff-identity',{name:value[name] for name in ('id','password','role','user_type','is_active','authEpoch')})


def assert_request_epoch(request,native,origin):
    if origin=='legacy-django' and request.session.get(LOGIN_EPOCH)!=native['authEpoch']:fail('SCREENING_ORIGIN_LOGIN_REFRESH_REQUIRED')


def record_login(sender,request,user,**_kwargs):
    # Called only by Django's real successful login signal. Rotate its genuine
    # session so a fresh login cannot collide with an old revoked native grant.
    from django.db import transaction
    secret=key();alias,connection=database()
    with transaction.atomic(using=alias),connection.cursor() as cursor:
        native,_identity=actor(cursor,user.id,secret)
        if not hmac.compare_digest(native['password'],user.password):fail('SCREENING_ORIGIN_AUTH_NAMESPACE_CHANGED')
    request.session.cycle_key();request.session[LOGIN_EPOCH]=native['authEpoch']


def scope(cursor,value,store_id,counter_id):
    store_id,counter_id=identifier(store_id),identifier(counter_id)
    store=one(cursor,'SELECT id,is_active,type,category FROM stores WHERE id=%s FOR UPDATE',(store_id,))
    counter=one(cursor,'SELECT id,store_id,is_active FROM store_counters WHERE id=%s FOR SHARE',(counter_id,))
    if store['is_active']!=1 or store['type'] not in ('STORE','CORE_WAREHOUSE') or counter['is_active']!=1 or str(counter['store_id'])!=store_id:fail('SCREENING_ORIGIN_STAFF_REVOKED')
    if int(value['user_type'])==2 and store['category']!='FRANCHISE':fail('SCREENING_ORIGIN_STAFF_REVOKED')
    if not (int(value['role'])==1 and int(value['user_type'])==1):
        if not rows(cursor,'SELECT id FROM user_stores WHERE django_user_id=%s AND store_id=%s FOR SHARE',(value['id'],store_id)):fail('SCREENING_ORIGIN_STAFF_REVOKED')


def authenticated(request,secret,now):
    # Django's original AuthenticationMiddleware/session backend performed the
    # actual password/MFA login. A client actorId is never an input here.
    user=getattr(request,'user',None)
    if user is not None and bool(getattr(user,'is_authenticated',False)):
        session=getattr(request,'session',None)
        if (session is None or not session.session_key or str(session.get('_auth_user_id'))!=str(user.id)
                or not hmac.compare_digest(str(session.get('_auth_user_hash','')),user.get_session_auth_hash())):fail('SCREENING_ORIGIN_AUTH_REQUIRED')
        return 'legacy-django',identifier(user.id),digest(secret,'django-session',session.session_key),None
    token=request.COOKIES.get(COOKIE,'')
    if not isinstance(token,str) or not UUID.fullmatch(token):fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    _alias,connection=database()
    with connection.cursor() as cursor:
        row=one(cursor,'SELECT actor_id,data,proof_hash,revoked FROM pos_rewrite_screening_origin_sessions WHERE id=%s',(token,))
    value=json.loads(row['data']) if isinstance(row['data'],str) else row['data']
    fields={'contract','id','origin','actorId','identityHash','sessionHash','issuedAt','expiresAt'}
    if (not isinstance(value,dict) or set(value)!=fields or value['contract']!='pos-screening-mpos-session-v1'
            or value['origin']!='mpos' or value['id']!=token or str(row['actor_id'])!=value['actorId'] or row['revoked']!=0
            or type(value['issuedAt']) is not int or type(value['expiresAt']) is not int
            or not value['issuedAt']<=now<value['expiresAt']<=value['issuedAt']+3600000
            or not hmac.compare_digest(digest(secret,'mpos-session',value),row['proof_hash'])):fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    if value['sessionHash']!=digest(secret,'mpos-session-reference',token):fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    return 'mpos',value['actorId'],value['sessionHash'],value


def after_mpos_authentication(request,response,user):
    """Called ONLY by the literal successful password/TOTP branches.
    The caller passes the real authenticated User, never email/boolean/body ID.
    """
    if user is None or getattr(user,'pk',None) is None:fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    from django.db import transaction
    alias,connection=database()
    secret=key();now=int(time.time()*1000)
    with transaction.atomic(using=alias),connection.cursor() as cursor:
        value,identity=actor(cursor,str(user.pk),secret)
        if not hmac.compare_digest(value['password'],user.password):fail('SCREENING_ORIGIN_AUTH_NAMESPACE_CHANGED')
        session_id=str(uuid4())
        record={'contract':'pos-screening-mpos-session-v1','id':session_id,'origin':'mpos','actorId':str(value['id']),
                'sessionHash':digest(secret,'mpos-session-reference',session_id),'identityHash':identity,'issuedAt':now,'expiresAt':now+3600000}
        cursor.execute('INSERT INTO pos_rewrite_screening_origin_sessions(id,origin,actor_id,session_hash,data,proof_hash,revoked) VALUES(%s,%s,%s,%s,%s,%s,0)',
                       (record['id'],'mpos',record['actorId'],record['sessionHash'],canonical(record),digest(secret,'mpos-session',record)))
    response.set_cookie(COOKIE,record['id'],max_age=3600,secure=True,httponly=True,samesite='Strict',path='/')
    original=json.loads(response.content)
    original['screeningActorId']=record['actorId']
    response.content=json.dumps(original)
    response['Cache-Control']='no-store'
    return response


def cart_hash(cursor,cart_id):
    values=rows(cursor,"""SELECT 'item' AS record_type,prod_id,option_id,combo_parent_id,combo_price_fraction,`select`,quantity,print_name,NULL AS name,NULL AS value,added_at
FROM cart_items WHERE cart_id=%s AND status='active' UNION ALL SELECT 'meta' AS record_type,NULL,NULL,NULL,NULL,NULL,NULL,NULL,name,value,NULL
FROM cart_meta WHERE cart_id=%s ORDER BY added_at DESC""",(cart_id,cart_id))
    def scalar(value):return value if value is None or type(value) in (str,int,float,bool) else str(value)
    normalized=[{name:scalar(value) for name,value in row.items()} for row in values]
    normalized.sort(key=canonical)
    return portable_hash(normalized)


def issue(request,customer_token,payload,params=None,_creation=None):
    """Actual legacy caller hook; returns one short-lived grant UUID.
    Customer credentials remain only in the original Authorization header.
    """
    from django.conf import settings
    from django.db import transaction
    alias,connection=database()
    from helpers.helpers import Helpers
    import jwt
    secret=key();now=int(time.time()*1000)
    origin,actor_id,session_hash,session_record=authenticated(request,secret,now)
    captured=request.META.get('HTTP_X_TSS_SCREENING_ACTOR')
    if captured is None or str(captured)!=actor_id:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
    try:
        two=customer_token.startswith('2f.')
        claims=jwt.decode(customer_token[3:] if two else customer_token,
            settings.SECRET_KEY_512 if two else settings.SECRET_KEY,algorithms=['HS512' if two else 'HS256'],options={'verify_aud':False})
    except Exception:fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    customer=identifier(claims.get('sub'))
    if type(claims.get('exp')) not in (int,float) or claims['exp']*1000<=now:fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    store,counter=identifier(payload.get('store_id')),identifier(payload.get('counter_id'))
    # Preserve the actual legacy check-in store rather than requiring a fake
    # rewrite check-in row. Logout/check-in hooks revoke these native grants.
    checked=Helpers.get_checkin_data(actor_id)
    if not checked or str(checked[0])!=store:fail('SCREENING_ORIGIN_STAFF_REVOKED')
    with transaction.atomic(using=alias),connection.cursor() as cursor:
        native,identity=actor(cursor,actor_id,secret);scope(cursor,native,store,counter)
        assert_request_epoch(request,native,origin)
        if origin=='legacy-django' and not hmac.compare_digest(native['password'],request.user.password):fail('SCREENING_ORIGIN_AUTH_NAMESPACE_CHANGED')
        if origin=='legacy-django':
            session_id=str(NativeUUID(bytes=bytes.fromhex(session_hash[:32]),version=4))
            old=rows(cursor,'SELECT data,proof_hash,revoked FROM pos_rewrite_screening_origin_sessions WHERE id=%s FOR UPDATE',(session_id,))
            if old:
                session_record=json.loads(old[0]['data']) if isinstance(old[0]['data'],str) else old[0]['data']
                if (old[0]['revoked']!=0 or session_record.get('actorId')!=actor_id or session_record.get('identityHash')!=identity
                        or session_record.get('sessionHash')!=session_hash or session_record.get('expiresAt',0)<=now
                        or not hmac.compare_digest(digest(secret,'legacy-session',session_record),old[0]['proof_hash'])):fail('SCREENING_ORIGIN_STAFF_REVOKED')
            else:
                expiry=min(now+3600000,int(request.session.get_expiry_date().timestamp()*1000))
                if expiry<=now:fail('SCREENING_ORIGIN_AUTH_REQUIRED')
                session_record={'contract':'pos-screening-legacy-session-v1','id':session_id,'origin':origin,'actorId':actor_id,
                    'sessionHash':session_hash,'identityHash':identity,'issuedAt':now,'expiresAt':expiry}
                cursor.execute('INSERT INTO pos_rewrite_screening_origin_sessions(id,origin,actor_id,session_hash,data,proof_hash,revoked) VALUES(%s,%s,%s,%s,%s,%s,0)',
                    (session_id,origin,actor_id,session_hash,canonical(session_record),digest(secret,'legacy-session',session_record)))
        if session_record is not None:
            saved=one(cursor,'SELECT data,proof_hash,revoked FROM pos_rewrite_screening_origin_sessions WHERE id=%s FOR UPDATE',(session_record['id'],))
            purpose='mpos-session' if origin=='mpos' else 'legacy-session'
            if saved['revoked']!=0 or identity!=session_record['identityHash'] or not hmac.compare_digest(saved['proof_hash'],digest(secret,purpose,session_record)):fail('SCREENING_ORIGIN_STAFF_REVOKED')
        row=one(cursor,'SELECT id,status,is_block,is_disabled,is_two_fa FROM users WHERE id=%s FOR UPDATE',(customer,))
        if row['status']!=1 or row['is_block'] not in (None,0) or row['is_disabled'] not in (None,0) or bool(row['is_two_fa'])!=two:fail('SCREENING_ORIGIN_AUTH_REQUIRED')
        if _creation is not None:
            if (_creation['actorId']!=actor_id or _creation['storeId']!=store or _creation['counterId']!=counter or _creation['customerId']!=customer
                    or _creation['origin']!=origin):fail('SCREENING_ORIGIN_SCOPE_CHANGED')
        value={'contract':'pos-screening-origin-staff-grant-v1','id':str(uuid4()),'origin':origin,'actorId':actor_id,
            'customerId':customer,'storeId':store,'counterId':counter,'sessionHash':session_hash,'identityHash':identity,
            'credentialHash':digest(secret,'customer-credential',customer_token),
            'requestHash':_creation['requestHash'] if _creation else portable_hash({'data':{name:value for name,value in payload.items() if name!='name'},'params':params or {}}),
            'cartHash':_creation['cartHash'] if _creation else cart_hash(cursor,'cart_'+customer+'_'+store),'issuedAt':now,'expiresAt':now+60000}
        cursor.execute('INSERT INTO pos_rewrite_screening_origin_staff_grants(id,actor_id,session_hash,data,proof_hash,revoked) VALUES(%s,%s,%s,%s,%s,0)',
                       (value['id'],actor_id,session_hash,canonical(value),digest(secret,'staff-grant',value)))
    return {'X-TSS-Screening-Origin':origin,'X-TSS-Screening-Staff-Grant':value['id']}


def payment_grant(request,customer_token,command_id):
    secret=key();_alias,connection=database()
    with connection.cursor() as cursor:
        row=one(cursor,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_creations WHERE command_id=%s',(command_id,))
    creation=json.loads(row['data']) if isinstance(row['data'],str) else row['data']
    if creation.get('commandId')!=command_id or not hmac.compare_digest(digest(secret,'creation',creation),row['proof_hash']):fail()
    return issue(request,customer_token,{'store_id':creation['storeId'],'counter_id':creation['counterId']},_creation=creation),creation,row['proof_hash']


def revoke_actor(actor_id):
    """Invoke before an original logout/check-in transition becomes visible."""
    from django.db import transaction
    alias,connection=database()
    secret=key()
    with transaction.atomic(using=alias),connection.cursor() as cursor:
        cursor.execute('SELECT id FROM pos_user WHERE id=%s FOR UPDATE',(identifier(actor_id),));cursor.fetchall()
        cursor.execute('UPDATE pos_rewrite_screening_origin_staff_grants SET revoked=1 WHERE actor_id=%s',(actor_id,))
        cursor.execute('UPDATE pos_rewrite_screening_origin_sessions SET revoked=1 WHERE actor_id=%s',(actor_id,))
