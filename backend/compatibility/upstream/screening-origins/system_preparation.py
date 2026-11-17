"""Owned CSK prefix recovery; no registration/order/payment replay heuristic.

Only an append-only native no-dispatch fence can rearm the same command. A
wall-clock expiry alone never authorizes retry or releases pending credit.
"""
import hashlib
import hmac
import json
from uuid import uuid4
from sqlalchemy import text
from origin_contracts import canonical,digest,fail
from origin_effects import seal_effects,open_effects
from origin_ledger import read,save
from native import one,rows,json_value


def copied(value):
    from libs.db import dateConvertor
    try:return json.loads(json.dumps(value,default=dateConvertor,ensure_ascii=False,allow_nan=False))
    except Exception:fail('SCREENING_ORIGIN_PREPARATION_INVALID')


def job(session,command,key):
    row=one(session,'SELECT data,proof_hash,payload,payload_hash FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id FOR UPDATE',{'id':command})
    value=json_value(row['data'])
    if value.get('commandId')!=command or not hmac.compare_digest(digest(key,'system-job',value),row['proof_hash']):fail()
    return row,value


def save_job(session,value,key):
    session.execute(text('UPDATE pos_rewrite_screening_origin_system_jobs SET data=:data,proof_hash=:proof WHERE command_id=:id'),
                    {'id':value['commandId'],'data':canonical(value),'proof':digest(key,'system-job',value)})


def no_dispatch(session,value):
    # The caller owns global customer/command and then this original job. An
    # original source commit must acquire these same locks before any Order.
    if value is not None and (value['phase']!='PREPARED' or value['orderId'] is not None):return False
    return True


def assert_absent(session,command):
    for table in ('pos_rewrite_screening_origin_creations','pos_rewrite_screening_origin_payments','pos_rewrite_screening_origin_effects',
                  'pos_rewrite_screening_origin_assets','pos_rewrite_screening_origin_system_metadata','pos_rewrite_screening_origin_payment_attempts'):
        if rows(session,'SELECT command_id FROM '+table+' WHERE command_id=:id FOR SHARE',{'id':command},2):fail('SCREENING_ORIGIN_ALREADY_DISPATCHED')


def frozen(session,command,key):
    found=rows(session,'SELECT customer_id,data,proof_hash,payload,payload_hash FROM pos_rewrite_screening_origin_system_preparations WHERE command_id=:id FOR SHARE',{'id':command},2)
    if not found:return None
    row=found[0];value=json_value(row['data'])
    if value.get('commandId')!=command or str(row['customer_id'])!=value.get('customerId') or digest(key,'system-preparation',value)!=row['proof_hash']:fail()
    payload=open_effects(key,'system-preparation:'+command,row['payload'],row['payload_hash'])
    if len(payload)!=1 or hashlib.sha256(canonical(payload).encode()).hexdigest()!=value['payloadHash']:fail()
    return value,payload[0]


def claim(owner,command,details):
    from origin_system import current_service
    key=owner.runtime.key
    with owner.runtime.sessions() as session,session.begin():
        session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        service=current_service(session,key,details)
        hint=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id',{'id':command})
        hinted=json_value(hint['data'])
        if hinted.get('commandId')!=command or digest(key,'system-job',hinted)!=hint['proof_hash']:fail()
        if hinted.get('state') not in ('PREPARED','SOURCE_READY'):return None
        hints=rows(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command},2)
        if hints:
            one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':hints[0]['customer_id']})
            value=read(session,command,str(hints[0]['customer_id']),key)
        else:value=None
        from system_successor import assert_active
        assert_active(session,hinted['referenceHash'],command,key)
        row,state=job(session,command,key)
        if state['state'] not in ('PREPARED','SOURCE_READY'):return None
        if state.get('serviceHash')!=digest(key,'system-service',service):
            save_job(session,{**state,'state':'AUTHORITY_PAUSED','updatedAt':owner.clock()},key)
            return None
        if not no_dispatch(session,value):return None
        assert_absent(session,command)
        prior=frozen(session,command,key)
        if state['state']=='SOURCE_READY' and prior is None and value is not None:fail()
        payload=open_effects(key,'system-job:'+command,row['payload'],row['payload_hash'])
        if len(payload)!=1:fail()
        now=owner.clock();attempt={'contract':'pos-screening-system-attempt-v1','id':str(uuid4()),'commandId':command,
            'requestHash':state['requestHash'],'referenceHash':state['referenceHash'],'serviceHash':state['serviceHash'],
            'authorityHash':None if value is None else value['authorityHash'],'phase':'RUNNING','createdAt':now,'expiresAt':now+120000}
        session.execute(text("INSERT INTO pos_rewrite_screening_origin_system_attempts(id,command_id,phase,data,proof_hash) VALUES(:id,:command,'RUNNING',:data,:proof)"),
            {'id':attempt['id'],'command':command,'data':canonical(attempt),'proof':digest(key,'system-attempt',attempt)})
        state={**state,'state':'SOURCE_RUNNING','attemptId':attempt['id'],'attemptExpiresAt':attempt['expiresAt'],'updatedAt':now}
        save_job(session,state,key)
        return state,payload[0],prior


def assert_attempt(session,context):
    key=context.owner.runtime.key
    from system_successor import assert_active
    assert_active(session,context.reference_hash,context.command_id,key)
    _row,state=job(session,context.command_id,key)
    if (state.get('state')!='SOURCE_RUNNING' or state.get('attemptId')!=context.attempt_id
            or state.get('attemptExpiresAt',0)<=context.owner.clock()):fail('SCREENING_ORIGIN_SOURCE_DISPATCH_CLOSED')
    row=one(session,'SELECT phase,data,proof_hash FROM pos_rewrite_screening_origin_system_attempts WHERE id=:id AND command_id=:command FOR UPDATE',{'id':context.attempt_id,'command':context.command_id})
    value=json_value(row['data'])
    if (row['phase']!='RUNNING' or value.get('phase')!='RUNNING' or value.get('id')!=context.attempt_id or value.get('commandId')!=context.command_id
            or value.get('expiresAt')!=state['attemptExpiresAt'] or digest(key,'system-attempt',value)!=row['proof_hash']):fail()
    if rows(session,'SELECT attempt_id FROM pos_rewrite_screening_origin_system_no_dispatch WHERE attempt_id=:id FOR SHARE',{'id':context.attempt_id},2):fail('SCREENING_ORIGIN_SOURCE_DISPATCH_CLOSED')
    return state


def pause(owner,command,details,attempt_id,expired_only=False):
    from origin_system import current_service
    key=owner.runtime.key
    with owner.runtime.sessions() as session,session.begin():
        session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        current_service(session,key,details)
        hints=rows(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command},2)
        value=None
        if hints:
            one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':hints[0]['customer_id']})
            value=read(session,command,str(hints[0]['customer_id']),key)
        _row,state=job(session,command,key)
        if state.get('attemptId')!=attempt_id or state.get('state')!='SOURCE_RUNNING':return False
        if expired_only and state.get('attemptExpiresAt',0)>owner.clock():return False
        if not no_dispatch(session,value):return False
        assert_absent(session,command)
        attempt=one(session,'SELECT phase,data,proof_hash FROM pos_rewrite_screening_origin_system_attempts WHERE id=:id FOR UPDATE',{'id':attempt_id})
        original=json_value(attempt['data'])
        if attempt['phase']!='RUNNING' or digest(key,'system-attempt',original)!=attempt['proof_hash']:fail()
        proof={'contract':'pos-screening-system-no-dispatch-v1','commandId':command,'attemptId':attempt_id,
            'requestHash':state['requestHash'],'referenceHash':state['referenceHash'],'serviceHash':state['serviceHash'],
            'authorityHash':None if value is None else value['authorityHash'],'noOrderDispatch':True,'noFinancialEffects':True,'createdAt':owner.clock()}
        session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_no_dispatch(attempt_id,command_id,data,proof_hash) VALUES(:id,:command,:data,:proof)'),
                        {'id':attempt_id,'command':command,'data':canonical(proof),'proof':digest(key,'system-no-dispatch',proof)})
        closed={**original,'phase':'CLOSED_NO_DISPATCH'}
        session.execute(text("UPDATE pos_rewrite_screening_origin_system_attempts SET phase='CLOSED_NO_DISPATCH',data=:data,proof_hash=:proof WHERE id=:id"),
                        {'id':attempt_id,'data':canonical(closed),'proof':digest(key,'system-attempt',closed)})
        save_job(session,{**state,'state':'PREPARATION_PAUSED','noDispatchHash':digest(key,'system-no-dispatch',proof),'updatedAt':owner.clock()},key)
        return True


def resume(owner,command,details):
    from origin_system import current_service,Context,Request,Response
    from origin_auth import authority_hash
    from types import SimpleNamespace
    key=owner.runtime.key
    with owner.runtime.sessions() as session,session.begin():
        session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        service=current_service(session,key,details)
        hints=rows(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command},2)
        value=None
        if hints:
            one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':hints[0]['customer_id']})
            value=read(session,command,str(hints[0]['customer_id']),key)
        _row,state=job(session,command,key)
        if state['state']=='SOURCE_READY':return {'commandId':command,'phase':'SOURCE_READY','orderId':None}
        if state['state']!='PREPARATION_PAUSED' or not no_dispatch(session,value):fail('SCREENING_ORIGIN_CANNOT_RESUME')
        if state.get('serviceHash')!=digest(key,'system-service',service):fail('SCREENING_ORIGIN_AUTHORITY_SUCCESSOR_REQUIRED')
        proof_row=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_no_dispatch WHERE attempt_id=:id AND command_id=:command FOR SHARE',{'id':state['attemptId'],'command':command})
        proof=json_value(proof_row['data'])
        if (proof.get('commandId')!=command or proof.get('attemptId')!=state['attemptId'] or proof.get('noOrderDispatch') is not True
                or proof.get('noFinancialEffects') is not True or proof_row['proof_hash']!=state.get('noDispatchHash')
                or any(proof.get(name)!=state.get(name) for name in ('requestHash','referenceHash','serviceHash'))
                or proof.get('authorityHash')!=(None if value is None else value['authorityHash'])
                or digest(key,'system-no-dispatch',proof)!=proof_row['proof_hash']):fail()
        original=one(session,'SELECT phase,data,proof_hash FROM pos_rewrite_screening_origin_system_attempts WHERE id=:id FOR SHARE',{'id':state['attemptId']})
        closed=json_value(original['data'])
        if original['phase']!='CLOSED_NO_DISPATCH' or closed.get('phase')!='CLOSED_NO_DISPATCH' or digest(key,'system-attempt',closed)!=original['proof_hash']:fail()
        assert_absent(session,command)
        prior=frozen(session,command,key)
        if value is not None:
            if prior is None:fail()
            _metadata,payload=prior
            request=Request(SimpleNamespace(access_route=payload['accessRoute']),{'user':payload['user']})
            context=Context(owner,command,state['referenceHash'],payload['originalPayload'],details,request,Response(),state['attemptId'])
            # Current authority alone is checked. A changed contact/service
            # needs an explicit successor; it cannot adopt the old reference.
            from origin_system import ACTIVE
            token=ACTIVE.set(context)
            try:_native,principal,_grant=context.authorize(session,request)
            finally:ACTIVE.reset(token)
            if authority_hash(key,principal)!=value['authorityHash']:fail('SCREENING_ORIGIN_AUTHORITY_SUCCESSOR_REQUIRED')
            now=owner.clock()
            save(session,{**value,'createdAt':now,'expiresAt':now+600000},key,now)
        save_job(session,{**state,'state':'SOURCE_READY','updatedAt':owner.clock()},key)
        return {'commandId':command,'phase':'SOURCE_READY','orderId':None}
