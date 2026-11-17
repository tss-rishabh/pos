"""Once-only ordinary cache invalidation for a genuinely completed public sale.

Broker input is an operation UUID and source descriptor hash. No email, cache
key, callback or source session is serialized or logged. Lost outcomes remain
processing/uncertain; neither broker redelivery nor GET executes Redis again.
"""
import hmac
import re
import time
from sqlalchemy import text
from protocol import digest,canonical
from native_authority import one,rows,value_json
from public_benefits import read as benefits
from public_effects import _hint,_prefix,_completed
from writer_protocol import fail
from transaction import CURRENT

TASK='pos_public_invalidate_membership'
CONTRACT='pos-public-screening-membership-cache-v1'
UUID=re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')


def install_kind():
    from effects import KINDS
    previous=KINDS.get(TASK)
    if previous not in (None,'membership-cache'):fail('SCREENING_BENEFIT_CACHE_UNAVAILABLE')
    KINDS[TASK]='membership-cache'


def pending(session,operation,benefit_hash,key,now):
    value={'contract':CONTRACT,'operationId':operation,'benefitHash':benefit_hash,
        'completionHash':None,'status':'pending','createdAt':now,'updatedAt':now}
    session.execute(text('INSERT INTO pos_rewrite_public_screening_benefit_cache(operation_id,data,proof_hash,status) VALUES(:id,:data,:proof,:status)'),
        {'id':operation,'data':canonical(value),'proof':digest(key,'public-screening-benefit-cache',value),'status':'pending'})


def read(session,creation,key):
    evidence=benefits(session,creation,key)
    if evidence is None or evidence['membership'] is None:return None
    row=one(session,'SELECT data,proof_hash,status FROM pos_rewrite_public_screening_benefit_cache WHERE operation_id=:id AND OCTET_LENGTH(data)<=2000 FOR UPDATE',{'id':creation['operationId']})
    value=value_json(row['data'])
    if (not isinstance(value,dict) or set(value)!={'contract','operationId','benefitHash','completionHash','status','createdAt','updatedAt'}
            or value['contract']!=CONTRACT or value['operationId']!=creation['operationId'] or value['benefitHash']!=creation['benefitsHash']
            or value['status']!=row['status'] or value['status'] not in ('pending','processing','uncertain','completed','cancelled')
            or type(value['createdAt']) is not int or value['createdAt']!=creation['createdAt']
            or type(value['updatedAt']) is not int or not creation['createdAt']<=value['updatedAt']<=9007199254740991
            or (value['status'] in ('pending','cancelled') and value['completionHash'] is not None)
            or (value['status'] in ('processing','uncertain','completed') and
                (not isinstance(value['completionHash'],str) or not re.fullmatch(r'[a-f0-9]{64}',value['completionHash'])))
            or not hmac.compare_digest(digest(key,'public-screening-benefit-cache',value),row['proof_hash'])):
        fail('SCREENING_BENEFIT_CACHE_UNAVAILABLE')
    return value


def write(session,value,key):
    session.execute(text('UPDATE pos_rewrite_public_screening_benefit_cache SET data=:data,proof_hash=:proof,status=:status WHERE operation_id=:id'),
        {'data':canonical(value),'proof':digest(key,'public-screening-benefit-cache',value),'status':value['status'],'id':value['operationId']})


def invalidate(sessions,operation,benefit_hash,key,callback,clock=None):
    if (CURRENT.get() is not None or not isinstance(operation,str) or not UUID.fullmatch(operation)
            or not isinstance(benefit_hash,str) or not re.fullmatch(r'[a-f0-9]{64}',benefit_hash)):fail()
    now=clock or (lambda:int(time.time()*1000))
    hint=_hint(sessions,operation,key)
    with sessions() as session:
        with session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _prefix(session,hint)
            creation=_completed(session,hint,key)
            if creation.get('benefitsHash')!=benefit_hash:fail()
            value=read(session,creation,key)
            if value is None:fail()
            if value['status']=='completed':return value
            if value['status']!='pending':fail('SCREENING_BENEFIT_CACHE_UNCERTAIN')
            member=benefits(session,creation,key)['membership']
            customer=one(session,'SELECT id,email FROM users WHERE id=:id FOR UPDATE',{'id':creation['customerId']})
            from public_membership import ordinary_producer
            adapter=ordinary_producer();member_key,_=adapter.config()
            if (not customer['email'] or member['provenance']['entityDigest']!=adapter._hash(
                    'pending-cancellation.membership-entity.v1',customer['email'],member_key)):fail()
            completion=one(session,'SELECT proof_hash FROM pos_rewrite_public_screening_completions WHERE operation_id=:id FOR SHARE',{'id':operation})
            claim={**value,'completionHash':completion['proof_hash'],'status':'processing','updatedAt':now()}
            write(session,claim,key)
        # Source cache callback receives only internally reconstituted current
        # identity, after the durable claim COMMIT and without any native lock.
        try:callback(session,int(customer['id']),customer['email'])
        except Exception:status='uncertain'
        else:status='completed'
        session.rollback()
        with session.begin():
            final={**claim,'status':status,'updatedAt':now()}
            write(session,final,key)
        if status!='completed':fail('SCREENING_BENEFIT_CACHE_UNCERTAIN')
        return final


def register_task(tasks,sessions,proof_key,environment=None,emit=None):
    import os
    env=os.environ if environment is None else environment
    queue=env.get('POS_PUBLIC_SCREENING_MEMBERSHIP_CACHE_QUEUE','')
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',queue):fail('SCREENING_BENEFIT_CACHE_UNAVAILABLE')
    install_kind()
    if TASK in tasks.app.tasks:fail('SCREENING_BENEFIT_CACHE_UNAVAILABLE')
    from controllers.user import userDal
    def original(session,customer_id,email):
        userDal.cache.region_invalidate(userDal.get_exclusive_token,None,'exclusive_user',session,customer_id,email)
    def execute(task,operation,benefit_hash):
        actor=None;state='review'
        opaque=operation if isinstance(operation,str) and UUID.fullmatch(operation) else None
        try:
            if opaque is None:fail()
            actor=_hint(sessions,operation,proof_key)['actorId']
            value=invalidate(sessions,operation,benefit_hash,proof_key,original)
            state='completed'
            return value
        except Exception:fail('SCREENING_BENEFIT_CACHE_UNCERTAIN')
        finally:
            if emit is not None:
                request=getattr(getattr(task,'request',None),'id',None)
                request=request if isinstance(request,str) and UUID.fullmatch(request) else None
                try:emit({'module':'public-screening','resource':'membership-cache','eventId':'public-screening.membership-cache.'+state,
                    'requestId':request,'userId':actor,'operationId':opaque})
                except Exception:pass
    task=tasks.app.task(name=TASK,queue=queue,bind=True,acks_late=False,ignore_result=True,autoretry_for=(),max_retries=0)(execute)
    setattr(tasks,TASK,task)
    return task
