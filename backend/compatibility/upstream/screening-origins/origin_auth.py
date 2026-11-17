"""After-original-auth native authority for each source origin.

Customer JWTs remain issued/verified by the original application. Staff source
grants are additional purpose-specific proofs, never customer/login tokens.
"""
import copy
import hashlib
import hmac
import json
from sqlalchemy import text
from origin_contracts import digest,canonical,identifier,fail,UUID,HASH,point
from native import one,rows,json_value
from receiver import source_user

STAFF_HEADER='X-TSS-Screening-Staff-Grant'

def source_customer(req,session,key,now):
    from utils.auth import decodeJwt,decodeJwt512
    token=req.auth
    if not isinstance(token,str) or not 1<=len(token)<=16000:fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    try:claims=decodeJwt512(token) if token.startswith('2f.') else decodeJwt(token)
    except Exception:fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    if (not isinstance(claims,dict) or type(claims.get('exp')) not in (int,float) or claims['exp']*1000<=now
            or not isinstance(req.context.get('user'),dict)):fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    customer=identifier(claims.get('sub'))
    if str(req.context['user'].get('user_id'))!=customer:fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    native=one(session,'SELECT id,firstname,lastname,email,telephone,status,is_block,is_disabled,is_two_fa,tss_money,tss_points,cashback,is_cod_enable,fb_id,gender,birthdate FROM users WHERE id=:id FOR UPDATE',{'id':customer})
    if (native['status']!=1 or native['is_block'] not in (None,0) or native['is_disabled'] not in (None,0)
            or bool(native['is_two_fa'])!=token.startswith('2f.')):fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    # Source auth_required also runs independently. Its cache is never the
    # authority for current balances, block state or customer identity here.
    from utils.hooks import auth_required
    original_session=req.context['session'];req.context['session']=session
    try:auth_required(req,None,None)
    finally:req.context['session']=original_session
    credential=digest(key,'customer-credential',token)
    identity=digest(key,'customer-identity',{'id':customer,'status':native['status'],'isBlock':native['is_block'],'isDisabled':native['is_disabled'],
        'isTwoFa':native['is_two_fa'],'email':native['email'],'telephone':native['telephone']})
    return native,{'origin':'customer','customerId':customer,'actorId':None,'storeId':None,'counterId':None,'credentialHash':credential,'identityHash':identity}

def staff_identity(session,actor_id,key):
    actor=one(session,'SELECT id,password,role,user_type,is_active FROM pos_user WHERE id=:id FOR SHARE',{'id':identifier(actor_id)})
    if actor['is_active']!=1 or int(actor['role']) not in (1,2,3,4,5) or int(actor['user_type']) not in (1,2):fail('SCREENING_ORIGIN_STAFF_REVOKED')
    return actor,digest(key,'staff-identity',{name:actor[name] for name in ('id','password','role','user_type','is_active')})

def staff_scope(session,actor,store_id,counter_id):
    store_id,counter_id=identifier(store_id),identifier(counter_id)
    store=one(session,'SELECT id,is_active,type,category FROM stores WHERE id=:id FOR UPDATE',{'id':store_id})
    counter=one(session,'SELECT id,store_id,is_active FROM store_counters WHERE id=:id FOR SHARE',{'id':counter_id})
    if store['is_active']!=1 or store['type'] not in ('STORE','CORE_WAREHOUSE') or str(counter['store_id'])!=store_id or counter['is_active']!=1:fail('SCREENING_ORIGIN_STAFF_REVOKED')
    if int(actor['user_type'])==2 and store['category']!='FRANCHISE':fail('SCREENING_ORIGIN_STAFF_REVOKED')
    if not (int(actor['role'])==1 and int(actor['user_type'])==1):
        assigned=rows(session,'SELECT id FROM user_stores WHERE django_user_id=:actor AND store_id=:store LIMIT 2 FOR SHARE',{'actor':actor['id'],'store':store_id},2)
        if not assigned:fail('SCREENING_ORIGIN_STAFF_REVOKED')
    return store,counter

def staff_grant(session,req,customer_id,key,now):
    supplied=req.get_header(STAFF_HEADER)
    if not isinstance(supplied,str) or not UUID.fullmatch(supplied):fail('SCREENING_ORIGIN_STAFF_REQUIRED')
    hint=one(session,'SELECT actor_id,data,proof_hash,revoked FROM pos_rewrite_screening_origin_staff_grants WHERE id=:id AND OCTET_LENGTH(data)<=16000',{'id':supplied})
    grant=json_value(hint['data'])
    fields={'contract','id','origin','actorId','customerId','storeId','counterId','sessionHash','identityHash','credentialHash','requestHash','cartHash','issuedAt','expiresAt'}
    if (not isinstance(grant,dict) or set(grant)!=fields or grant['contract']!='pos-screening-origin-staff-grant-v1'
            or grant['id']!=supplied or grant['origin'] not in ('legacy-django','mpos') or str(hint['actor_id'])!=grant['actorId']
            or grant['customerId']!=customer_id or not point(grant['issuedAt']) or not point(grant['expiresAt'])
            or not grant['issuedAt']<=now<grant['expiresAt']<=grant['issuedAt']+60000
            or not hmac.compare_digest(digest(key,'staff-grant',grant),hint['proof_hash'])):fail('SCREENING_ORIGIN_STAFF_REQUIRED')
    # Ordered prefix is actor -> Store -> current assignment/counter -> grant.
    actor,identity=staff_identity(session,grant['actorId'],key)
    staff_scope(session,actor,grant['storeId'],grant['counterId'])
    current=one(session,'SELECT origin,actor_id,session_hash,data,proof_hash,revoked FROM pos_rewrite_screening_origin_sessions WHERE session_hash=:hash AND OCTET_LENGTH(data)<=16000 FOR SHARE',{'hash':grant['sessionHash']})
    record=json_value(current['data'])
    session_fields={'contract','id','origin','actorId','identityHash','sessionHash','issuedAt','expiresAt'}
    purpose='mpos-session' if grant['origin']=='mpos' else 'legacy-session'
    expected='pos-screening-mpos-session-v1' if grant['origin']=='mpos' else 'pos-screening-legacy-session-v1'
    if (not isinstance(record,dict) or set(record)!=session_fields or record['contract']!=expected or record['origin']!=grant['origin']
            or record['actorId']!=grant['actorId'] or record['sessionHash']!=grant['sessionHash'] or record['identityHash']!=identity
            or current['origin']!=record['origin'] or str(current['actor_id'])!=record['actorId'] or current['session_hash']!=record['sessionHash'] or current['revoked']!=0
            or not point(record['issuedAt']) or not point(record['expiresAt']) or not record['issuedAt']<=now<record['expiresAt']<=record['issuedAt']+3600000
            or not hmac.compare_digest(digest(key,purpose,record),current['proof_hash'])):fail('SCREENING_ORIGIN_STAFF_REVOKED')
    locked=one(session,'SELECT data,proof_hash,revoked FROM pos_rewrite_screening_origin_staff_grants WHERE id=:id FOR UPDATE',{'id':supplied})
    if locked['revoked']!=0 or json_value(locked['data'])!=grant or locked['proof_hash']!=hint['proof_hash'] or identity!=grant['identityHash']:fail('SCREENING_ORIGIN_STAFF_REVOKED')
    return grant

def authority_hash(key,value):return digest(key,'authority',value)

def source_origin(req,session,key,now,origin):
    # A staff token never substitutes for the customer's original source JWT.
    # Staff locks precede the global customer. Decode only to locate that ID;
    # source_customer performs full original verification after the prefix.
    if origin in ('legacy-django','mpos'):
        from utils.auth import decodeJwt,decodeJwt512
        try:claims=decodeJwt512(req.auth) if req.auth.startswith('2f.') else decodeJwt(req.auth)
        except Exception:fail('SCREENING_ORIGIN_AUTH_REQUIRED')
        customer=identifier(claims.get('sub') if isinstance(claims,dict) else None)
        grant=staff_grant(session,req,customer,key,now)
        if grant['origin']!=origin:fail('SCREENING_ORIGIN_STAFF_REQUIRED')
        native,principal=source_customer(req,session,key,now)
        if principal['credentialHash']!=grant['credentialHash']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
        principal.update(origin=origin,actorId=grant['actorId'],storeId=grant['storeId'],counterId=grant['counterId'],
                         sessionHash=grant['sessionHash'],staffIdentityHash=grant['identityHash'],grantId=grant['id'])
        return native,principal,grant
    if origin!='customer':fail('SCREENING_ORIGIN_AUTH_REQUIRED')
    native,principal=source_customer(req,session,key,now)
    data=req.context.get('data',{})
    if data.get('is_pos_order') or data.get('pos_store_id') or data.get('pos_user_id'):fail('SCREENING_ORIGIN_STAFF_REQUIRED')
    return native,principal,None

def fresh_source_user(native,member=False):
    # Use the pinned AuthHandler projection, including its source date shape.
    return source_user(native,str(native['id']),member)
