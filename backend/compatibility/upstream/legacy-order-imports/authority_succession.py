"""Manager-delegated future authority; original import identity never changes.

No source dispatch, principal fabrication, eligibility or history fallback here.
"""
import hmac
import json
import os
import re
from protocol import ImportReview,digest,identifier,uuid,canonical
CONTRACT='pos-import-authority-succession-v1'
_FIELDS={'contract','id','sequence','previous','originalScope','requestHash','planHash','namespace',
         'originalAuthorityHash','orderId','sourceReceiptHash','headerHash','lineHash','evidenceHash',
         'managerId','requestId','sessionHash','sessionDigest','authority','businessDate','reason','reviewedAt','issuedAt','expiresAt'}


def reference(envelope):
    data=envelope['data']
    return {'id':data['id'],'sequence':data['sequence'],'hash':envelope['sourceHash']}


def verify_envelope(key,cap,phase,now_ms):
    envelope=cap.get('succession')
    if envelope is None:return None
    if (phase not in ('confirmation','publication') or os.environ.get('POS_LEGACY_IMPORT_AUTHORITY_SUCCESSION_CONTRACT')!=CONTRACT
            or not isinstance(envelope,dict) or set(envelope)!={'data','sourceHash'}):
        raise ImportReview('ORDER_IMPORT_SUCCESSION_PROOF_INVALID')
    data=envelope['data']
    if (not isinstance(data,dict) or set(data)!=_FIELDS or data['contract']!=CONTRACT
            or uuid(data['id'])!=data['id'] or type(data['sequence']) is not int or not 1<=data['sequence']<=100
            or data['originalScope']!=cap['scope'] or data['requestHash']!=cap['requestHash']
            or data['planHash']!=cap['planHash'] or data['namespace']!=cap['namespace']
            or data['orderId']!=cap['orderId'] or identifier(data['managerId'])!=data['managerId']
            or not isinstance(data['authority'],dict) or set(data['authority'])!=set(cap['authority'])
            or data['authority']['customerId']!=cap['authority']['customerId']
            or data['authority']['approvalId'] is not None
            or type(data['issuedAt']) is not int or type(data['expiresAt']) is not int
            or type(data['reviewedAt']) is not int or not data['reviewedAt']<=data['issuedAt']<=now_ms<data['expiresAt']
            or data['expiresAt']!=data['issuedAt']+3600000 or cap['expiresAt']>data['expiresAt']
            or not isinstance(envelope['sourceHash'],str)
            or not hmac.compare_digest(envelope['sourceHash'],digest(key,'authority-succession',data))
            or data['originalAuthorityHash']!=digest(key,'succession-original-authority',cap['authority'])):
        raise ImportReview('ORDER_IMPORT_SUCCESSION_PROOF_INVALID')
    return envelope


def actor_hint(cap):
    value=cap.get('succession')
    return value['data']['managerId'] if value else cap['scope']['actorId']


def effective(cap):
    value=cap.get('succession')
    return {**cap,'scope':{**cap['scope'],'actorId':value['data']['managerId']},'authority':value['data']['authority']} if value else cap


def verify_native(session,cap,state,phase,key=None,factual=False):
    from native import rows,one,json_value
    heads=rows(session,'SELECT grant_id,sequence_no,source_hash,active_command_id FROM pos_rewrite_import_authority_heads WHERE operation_id=:op FOR SHARE',{'op':cap['operationId']},2)
    if not heads:
        if state.get('authoritySuccession') is not None or cap.get('succession') is not None:
            raise ImportReview('ORDER_IMPORT_SUCCESSION_PROOF_INVALID')
        return None
    envelope=cap.get('succession')
    if envelope is None:raise ImportReview('ORDER_IMPORT_SUCCESSION_REQUIRED')
    data=envelope['data'];head=heads[0]
    if (state.get('authoritySuccession')!=reference(envelope) or head['grant_id']!=data['id']
            or head['sequence_no']!=data['sequence'] or head['source_hash']!=envelope['sourceHash']
            or not head['active_command_id']):
        raise ImportReview('ORDER_IMPORT_SUCCESSION_PROOF_INVALID')
    grant=one(session,'SELECT data,manager_id,manager_session_id,sequence_no,operation_id FROM pos_rewrite_import_authority_successions WHERE id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE',{'id':data['id']})
    if (json_value(grant['data'])!=envelope or grant['manager_id']!=data['managerId']
            or grant['sequence_no']!=data['sequence'] or grant['operation_id']!=cap['operationId']):
        raise ImportReview('ORDER_IMPORT_SUCCESSION_PROOF_INVALID')
    import hashlib
    if hashlib.sha256(grant['manager_session_id'].encode()).hexdigest()!=data['sessionDigest']:
        raise ImportReview('ORDER_IMPORT_SUCCESSION_PROOF_INVALID')
    if not factual:
        one(session,'SELECT id FROM pos_rewrite_sessions WHERE id=:id AND user_id=:actor AND auth_version=:version AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3) FOR SHARE',{'id':grant['manager_session_id'],'actor':data['managerId'],'version':data['authority']['actorVersion']})
    claim=one(session,'SELECT data,source_hash FROM pos_rewrite_import_authority_stage_claims WHERE operation_id=:op AND stage=:stage AND grant_id=:grant FOR SHARE',{'op':cap['operationId'],'stage':phase,'grant':data['id']})
    value=json_value(claim['data'])
    if (not isinstance(value,dict) or set(value)!={'contract','operationId','stage','nonce','stageRequestHash','grant','commandId','claimedAt'}
            or value['contract']!=CONTRACT or value['operationId']!=cap['operationId']
            or value['stage']!=phase or value['nonce']!=cap['nonce'] or value['grant']!=reference(envelope)
            or value['commandId']!=head['active_command_id']):
        raise ImportReview('ORDER_IMPORT_SUCCESSION_PROOF_INVALID')
    if key is None:key=os.environ.get('POS_LEGACY_IMPORT_KEY','')
    if not hmac.compare_digest(claim['source_hash'],digest(key,'succession-stage',value)):
        raise ImportReview('ORDER_IMPORT_SUCCESSION_PROOF_INVALID')
    source=one(session,"SELECT proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind='order' AND status='completed' FOR SHARE",{'op':cap['operationId']})
    if source['proof_hash']!=data['sourceReceiptHash']:
        raise ImportReview('ORDER_IMPORT_SUCCESSION_PROOF_INVALID')
    return envelope
