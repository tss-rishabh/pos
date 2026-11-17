"""Explicit genuine-CSK authority succession before any source order exists.

The reference has one active head. A successor cannot transfer an order, money,
stock, provider attempt or an unknown source/customer prefix to a new principal.
"""
import copy
import hashlib
import hmac
import json
from types import SimpleNamespace
from sqlalchemy import text
from native import one,rows,json_value
from origin_contracts import PROOF,UUID,canonical,digest,identifier,fail
from origin_ledger import read,insert,save
from origin_effects import seal_effects,open_effects
from origin_auth import authority_hash
from system_preparation import job,save_job,frozen,assert_absent

CONTRACT='pos-screening-system-authority-successor-v1'
HEAD='pos-screening-system-reference-head-v1'
REASONS=('customer-contact-changed','service-rotation','source-reconciliation')


def head(session,reference,key,lock=True):
    found=rows(session,'SELECT * FROM pos_rewrite_screening_origin_system_reference_heads WHERE reference_hash=:id'+(' FOR UPDATE' if lock else ' FOR SHARE'),{'id':reference},2)
    if not found:return None
    row=found[0];value=json_value(row['data'])
    if (value.get('contract')!=HEAD or value.get('referenceHash')!=reference or row['reference_hash']!=reference
            or value.get('originalCommandId')!=row['original_command_id'] or value.get('activeCommandId')!=row['active_command_id']
            or type(value.get('version')) is not int or value['version']<1 or value['version']!=row['version']
            or not hmac.compare_digest(digest(key,'system-reference-head',value),row['proof_hash'])):fail()
    return value


def initialize(session,reference,command,key,now):
    current=head(session,reference,key)
    if current is not None:return current
    value={'contract':HEAD,'referenceHash':reference,'originalCommandId':command,'activeCommandId':command,'version':1,'updatedAt':now}
    session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_reference_heads(reference_hash,original_command_id,active_command_id,version,data,proof_hash) VALUES(:reference,:original,:active,1,:data,:proof)'),
                    {'reference':reference,'original':command,'active':command,'data':canonical(value),'proof':digest(key,'system-reference-head',value)})
    return value


def assert_active(session,reference,command,key):
    current=head(session,reference,key,lock=False)
    if current is None or current['activeCommandId']!=command:fail('SCREENING_ORIGIN_SOURCE_DISPATCH_CLOSED')
    return current


def public(value):return {'commandId':value['successorId'],'parentCommandId':value['parentCommandId'],'referenceVersion':value['headVersion'],'phase':'SOURCE_READY' if value['customerId'] is not None else 'PREPARED'}

def receipt(owner,parent,identity):
    with owner.runtime.sessions() as session:
        found=rows(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_successors WHERE successor_id=:id AND parent_command_id=:parent',{'id':identity,'parent':parent},2)
        if not found:return None
        record=json_value(found[0]['data'])
        if (record.get('contract')!=CONTRACT or record.get('parentCommandId')!=parent or record.get('successorId')!=identity
                or digest(owner.runtime.key,'system-successor',record)!=found[0]['proof_hash']):fail()
        return public(record)


def successor(owner,parent,details,input):
    if (not isinstance(input,dict) or set(input)!={'successorId','expectedHeadVersion','reason'}
            or not isinstance(input['successorId'],str) or not UUID.fullmatch(input['successorId']) or input['successorId']==parent
            or type(input['expectedHeadVersion']) is not int or not 1<=input['expectedHeadVersion']<=9007199254740991 or input['reason'] not in REASONS):fail('SCREENING_ORIGIN_REQUEST_INVALID')
    from origin_system import current_service,Context,Request,Response,ACTIVE,AUTHORITY
    key=owner.runtime.key;now=owner.clock()
    with owner.runtime.sessions() as session,session.begin():
        session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        service=current_service(session,key,details)
        replay=rows(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_successors WHERE successor_id=:id',{'id':input['successorId']},2)
        if replay:
            record=json_value(replay[0]['data'])
            if (record.get('contract')!=CONTRACT or record.get('parentCommandId')!=parent or record.get('successorId')!=input['successorId']
                    or record.get('reason')!=input['reason'] or record.get('expectedHeadVersion')!=input['expectedHeadVersion']
                    or digest(key,'system-successor',record)!=replay[0]['proof_hash']):fail('SCREENING_ORIGIN_SUCCESSOR_CONFLICT')
            return public(record)
        hint=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id',{'id':parent})
        hint_value=json_value(hint['data'])
        if hint_value.get('commandId')!=parent or digest(key,'system-job',hint_value)!=hint['proof_hash']:fail()
        from origin_system_preview import customer_hint,saved as saved_cart_prefix,TABLE as CART_PREFIX_TABLE
        customer=customer_hint(session,parent,key)
        old=None
        if customer is not None:
            one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':customer})
            # Consistent ID order when a same-customer successor races another
            # genuine command writer. There is no child-to-parent Order lock.
            for command in sorted((parent,input['successorId'])):
                if command==parent:old=read(session,parent,customer,key)
                elif rows(session,'SELECT id FROM pos_rewrite_screening_origin_commands WHERE id=:id FOR UPDATE',{'id':command},2):fail('SCREENING_ORIGIN_SUCCESSOR_CONFLICT')
        reference=hint_value['referenceHash'];current=head(session,reference,key)
        if current is None:current=initialize(session,reference,parent,key,now)
        if current['activeCommandId']!=parent or current['version']!=input['expectedHeadVersion']:fail('SCREENING_ORIGIN_REFERENCE_CHANGED')
        row,state=job(session,parent,key)
        if state.get('state') not in ('PREPARATION_PAUSED','AUTHORITY_PAUSED'):fail('SCREENING_ORIGIN_CANNOT_TRANSFER')
        if old is not None and (old['phase']!='PREPARED' or old['orderId'] is not None):fail('SCREENING_ORIGIN_ALREADY_DISPATCHED')
        assert_absent(session,parent)
        if rows(session,'SELECT command_id FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id FOR UPDATE',{'id':input['successorId']},2):fail('SCREENING_ORIGIN_SUCCESSOR_CONFLICT')
        prior=frozen(session,parent,key)
        prefix=saved_cart_prefix(session,parent,key)
        if state.get('attemptId') is not None:
            closed=one(session,'SELECT phase,data,proof_hash FROM pos_rewrite_screening_origin_system_attempts WHERE id=:id FOR SHARE',{'id':state['attemptId']})
            attempt=json_value(closed['data'])
            receipt=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_no_dispatch WHERE attempt_id=:id FOR SHARE',{'id':state['attemptId']})
            negative=json_value(receipt['data'])
            if (closed['phase']!='CLOSED_NO_DISPATCH' or attempt.get('phase')!='CLOSED_NO_DISPATCH' or digest(key,'system-attempt',attempt)!=closed['proof_hash']
                    or negative.get('commandId')!=parent or negative.get('attemptId')!=state['attemptId'] or negative.get('noFinancialEffects') is not True
                    or negative.get('noOrderDispatch') is not True or digest(key,'system-no-dispatch',negative)!=receipt['proof_hash']
                    or state.get('noDispatchHash')!=receipt['proof_hash']
                    or any(negative.get(name)!=state.get(name) for name in ('requestHash','referenceHash','serviceHash'))
                    or negative.get('authorityHash')!=(None if old is None else old['authorityHash'])):fail('SCREENING_ORIGIN_NO_DISPATCH_PROOF_REQUIRED')
            if (old is None or prior is None) and prefix is None:fail('SCREENING_ORIGIN_ORIGINAL_CUSTOMER_UNQUALIFIED')
        principal=None
        if old is not None:
            if prior is None:fail('SCREENING_ORIGIN_ORIGINAL_CUSTOMER_UNQUALIFIED')
            _metadata,snapshot=prior
            request=Request(SimpleNamespace(access_route=snapshot['accessRoute']),{'user':snapshot['user']})
            context=Context(owner,parent,reference,snapshot['originalPayload'],details,request,Response(),state.get('attemptId'))
            token=ACTIVE.set(context)
            try:_native,principal,_grant=context.authorize(session,request)
            finally:ACTIVE.reset(token)
        elif prefix is not None:
            _metadata,snapshot=prefix
            request=Request(SimpleNamespace(access_route=snapshot['accessRoute']),{'user':snapshot['user']})
            context=Context(owner,parent,reference,{},details,request,Response(),state.get('attemptId'))
            token=ACTIVE.set(context)
            try:_native,principal,_grant=context.authorize(session,request)
            finally:ACTIVE.reset(token)
            if principal['customerId']!=prefix[0]['customerId']:fail('SCREENING_ORIGIN_ORIGINAL_CUSTOMER_UNQUALIFIED')
        new_authority=None if principal is None else authority_hash(key,principal)
        record={'contract':CONTRACT,'successorId':input['successorId'],'parentCommandId':parent,'referenceHash':reference,
                'requestHash':state['requestHash'],'customerId':customer,
                'originalAuthorityHash':old['authorityHash'] if old is not None else (prefix[0]['authorityHash'] if prefix is not None else None),'newAuthorityHash':new_authority,
                'originalServiceHash':state.get('serviceHash'),'newServiceHash':digest(key,'system-service',service),
                'expectedHeadVersion':input['expectedHeadVersion'],'headVersion':current['version']+1,'reason':input['reason'],
                'noFinancialEffects':True,'createdAt':now}
        proof=digest(key,'system-successor',record)
        if old is not None:
            negative={'contract':'pos-screening-origin-closure-v1','commandId':parent,'origin':'external-system','customerId':old['customerId'],
                'requestHash':old['requestHash'],'cartHash':old['cartHash'],'authorityHash':old['authorityHash'],
                'code':'SCREENING_ORIGIN_AUTHORITY_SUPERSEDED','noFinancialEffects':True,'createdAt':now}
            closure=digest(key,'closure',negative)
            session.execute(text('INSERT INTO pos_rewrite_screening_origin_closures(command_id,data,proof_hash) VALUES(:id,:data,:proof)'),{'id':parent,'data':canonical(negative),'proof':closure})
            save(session,{**old,'phase':'REJECTED','closureHash':closure},key,now)
            value={**old,'id':input['successorId'],'authorityHash':new_authority,'phase':'PREPARED','version':1,
                   'orderId':None,'lines':[],'markers':[],'creationHash':None,'closureHash':None,'createdAt':now,'updatedAt':now,'expiresAt':now+600000}
            insert(session,value,key)
            authority={'contract':AUTHORITY,'commandId':value['id'],'customerId':value['customerId'],'requestHash':value['requestHash'],
                'referenceHash':reference,'serviceId':'csk','serviceRevision':service['revision'],'credentialHash':service['credentialHash'],'configurationHash':service['configurationHash']}
            session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_authorities(command_id,data,proof_hash) VALUES(:id,:data,:proof)'),
                            {'id':value['id'],'data':canonical(authority),'proof':digest(key,'system-authority',authority)})
            metadata={**prior[0],'commandId':value['id'],'authorityHash':new_authority,'createdAt':now}
            payload=[copy.deepcopy(prior[1])];payload_hash=hashlib.sha256(canonical(payload).encode()).hexdigest()
            if payload_hash!=metadata['payloadHash']:fail()
            session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_preparations(command_id,customer_id,data,proof_hash,payload,payload_hash) VALUES(:id,:customer,:data,:proof,:payload,:hash)'),
                {'id':value['id'],'customer':value['customerId'],'data':canonical(metadata),'proof':digest(key,'system-preparation',metadata),
                 'payload':seal_effects(key,'system-preparation:'+value['id'],payload),'hash':payload_hash})
        if prefix is not None:
            metadata={**prefix[0],'commandId':input['successorId'],'authorityHash':new_authority,'createdAt':now}
            payload=[copy.deepcopy(prefix[1])]
            if hashlib.sha256(canonical(payload).encode()).hexdigest()!=metadata['payloadHash']:fail()
            session.execute(text('INSERT INTO '+CART_PREFIX_TABLE+'(command_id,customer_id,data,proof_hash,payload,payload_hash) VALUES(:id,:customer,:data,:proof,:payload,:hash)'),
                {'id':input['successorId'],'customer':customer,'data':canonical(metadata),'proof':digest(key,'system-cart-prefix',metadata),
                 'payload':seal_effects(key,'system-cart-prefix:'+input['successorId'],payload),'hash':metadata['payloadHash']})
        original_payload=open_effects(key,'system-job:'+parent,row['payload'],row['payload_hash'])
        new_job={'contract':'pos-screening-system-job-v1','commandId':input['successorId'],'serviceId':'csk','referenceHash':reference,
            'requestHash':state['requestHash'],'serviceHash':record['newServiceHash'],'state':'SOURCE_READY' if customer is not None else 'PREPARED',
            'orderId':None,'parentCommandId':parent,'successionHash':proof,'updatedAt':now}
        session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_jobs(command_id,data,proof_hash,payload,payload_hash) VALUES(:id,:data,:proof,:payload,:hash)'),
            {'id':input['successorId'],'data':canonical(new_job),'proof':digest(key,'system-job',new_job),
             'payload':seal_effects(key,'system-job:'+input['successorId'],original_payload),'hash':row['payload_hash']})
        save_job(session,{**state,'state':'SUPERSEDED','successorId':input['successorId'],'successionHash':proof,'updatedAt':now},key)
        session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_successors(successor_id,parent_command_id,reference_hash,data,proof_hash) VALUES(:id,:parent,:reference,:data,:proof)'),
                        {'id':input['successorId'],'parent':parent,'reference':reference,'data':canonical(record),'proof':proof})
        active={**current,'activeCommandId':input['successorId'],'version':record['headVersion'],'updatedAt':now}
        session.execute(text('UPDATE pos_rewrite_screening_origin_system_reference_heads SET active_command_id=:active,version=:version,data=:data,proof_hash=:proof WHERE reference_hash=:reference'),
                        {'reference':reference,'active':input['successorId'],'version':active['version'],'data':canonical(active),'proof':digest(key,'system-reference-head',active)})
        return public(record)
