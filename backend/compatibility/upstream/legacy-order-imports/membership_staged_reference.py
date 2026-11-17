"""Read authentic staged-reference/Go transition facts; never mutate EAV."""
import hmac
import os
from datetime import datetime, timedelta
from native import one, json_value
from protocol import digest
from membership_reference import _fail, validate_transfers

STAGED = 'pos-csv-membership-staged-reference-v1'
ACTIVATED = 'pos-csv-membership-reference-activation-v1'


def reference(session,key,proof,membership_hash,source_hash=None):
    if source_hash is None:
        head=one(session,'SELECT grant_id FROM pos_rewrite_import_authority_heads WHERE operation_id=:op FOR SHARE',{'op':proof['operationId']})
        row=one(session,'SELECT id,data FROM pos_rewrite_import_membership_staged_references WHERE operation_id=:op AND grant_id=:grant AND OCTET_LENGTH(data)<=262144 FOR SHARE',{'op':proof['operationId'],'grant':head['grant_id']})
    else:
        row=one(session,'SELECT id,data FROM pos_rewrite_import_membership_staged_references WHERE id=:id AND operation_id=:op AND OCTET_LENGTH(data)<=262144 FOR SHARE',{'id':source_hash,'op':proof['operationId']})
    envelope=json_value(row['data'])
    data=envelope['data']
    fields={'contract','operationId','requestHash','planHash','namespace','orderId','customerId','sourceReceiptHash',
            'original','currentEntity','currentRevision','currentRows','transfers','grantId','managerId','approvedAt'}
    if (set(envelope)!={'data','sourceHash'} or set(data)!=fields or data['contract']!=STAGED
            or row['id']!=envelope['sourceHash']
            or not hmac.compare_digest(envelope['sourceHash'],digest(key,'membership-staged-reference',data))
            or any(data[name]!=proof[name] for name in ('operationId','requestHash','planHash','namespace','orderId','customerId'))
            or data['sourceReceiptHash']!=membership_hash or data['original']!=proof['provenance']):
        _fail()
    approval=one(session,'SELECT data,manager_id,operation_id FROM pos_rewrite_import_authority_successions WHERE id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE',{'id':data['grantId']})
    grant=json_value(approval['data'])
    auth_key=os.environ.get('POS_LEGACY_IMPORT_KEY','')
    if (not auth_key or not hmac.compare_digest(grant['sourceHash'],digest(auth_key,'authority-succession',grant['data']))
            or approval['operation_id']!=data['operationId'] or approval['manager_id']!=data['managerId']
            or grant['data']['id']!=data['grantId'] or grant['data']['orderId']!=data['orderId']
            or grant['data']['authority']['customerId']!=data['customerId']
            or grant['data']['issuedAt']!=data['approvedAt']):
        _fail()
    validate_transfers(session,key,data,data['original']['entityDigest'])
    return envelope


def pending(session,key,proof,membership_hash,current,customer,adapter):
    envelope=reference(session,key,proof,membership_hash)
    data=envelope['data']
    member_key,_=adapter.config()
    revision=one(session,'SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=:id FOR SHARE',{'id':proof['customerId']})
    if (current!=proof['provenance'] or current['contract']!='pos-cancellation-membership-staged-v2'
            or data['currentEntity']!=adapter._hash('pending-cancellation.membership-entity.v1',customer['email'],member_key)
            or data['currentRows']!=adapter.current(session,customer['email'])
            or data['currentRevision']!=str(revision['revision'])):
        _fail()
    return envelope


def activated(session,key,proof,membership_hash,current,adapter):
    row=one(session,"SELECT proof,proof_hash,status,request_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind='member-reference' AND OCTET_LENGTH(proof)<=262144 FOR SHARE",{'op':proof['operationId']})
    value=json_value(row['proof'])
    fields={'contract','operationId','requestHash','planHash','orderId','customerId','nonce','sourceReceiptHash',
            'referenceHash','originalStageHash','confirmationHash','sourceMutation','activation','confirmedAt'}
    if (set(value)!=fields or row['status']!='completed' or row['request_hash']!=proof['requestHash']
            or value['contract']!=ACTIVATED
            or not hmac.compare_digest(row['proof_hash'],digest(key,'membership-reference-activation',value))
            or any(value[name]!=proof[name] for name in ('operationId','requestHash','planHash','orderId','customerId'))
            or value['sourceReceiptHash']!=membership_hash or value['originalStageHash']!=proof['provenance']['proofHash']
            or value['activation']!=current or current['contract']!='pos-cancellation-membership-provenance-v2'):
        _fail()
    envelope=reference(session,key,proof,membership_hash,value['referenceHash'])
    data=envelope['data']
    member_key,_=adapter.config()
    if (current['entityDigest']!=data['currentEntity'] or current['before']!=data['original']['before']
            or current['proofHash']!=adapter.proof_hash(current,member_key)):
        _fail()
    mutation=value['sourceMutation']
    if (mutation['kind']!=('upgrade' if proof['kind']=='upgrade' else 'activate')
            or mutation['productId']!=proof['memberLines'][0]['productId']
            or mutation['delta'] not in (0,270,330,365)):
        _fail()
    old_expiry=next(item['value'] for item in data['currentRows'] if item['attribute']=='EXCLUSIVE_EXPIRY')
    old_member=next(item['value'] for item in data['currentRows'] if item['attribute']=='EXCLUSIVE_MEMBER')
    expected_expiry=old_expiry if mutation['kind']=='activate' else (datetime.fromisoformat(old_expiry)+timedelta(days=mutation['delta'])).isoformat(timespec='microseconds')
    expected_member=old_member if mutation['kind']=='activate' else {330:'4',270:'5',365:'6'}.get(mutation['delta'],'1')
    if (mutation['expiryBefore']!=old_expiry or mutation['expiryAfter']!=expected_expiry
            or mutation['memberValue']!=expected_member or (mutation['kind']=='activate' and mutation['delta']!=0)):
        _fail()
    for row in current['confirmed']:
        original=next((item for item in data['currentRows'] if item['attribute']==row['attribute']),None)
        expected=expected_expiry if row['attribute']=='EXCLUSIVE_EXPIRY' else expected_member
        if (original is None or expected!=row['value'] or original['createdAt']!=row['createdAt'] or row['active']!=1
                or (mutation['kind']=='upgrade' and original['active']!=row['active'])):
            _fail()
    confirmation=one(session,"SELECT proof,proof_hash,status,request_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op AND kind='confirmation' AND OCTET_LENGTH(proof)<=16000 FOR SHARE",{'op':proof['operationId']})
    confirmed=json_value(confirmation['proof'])
    if (confirmation['status']!='completed' or confirmation['request_hash']!=proof['requestHash']
            or confirmation['proof_hash']!=value['confirmationHash']
            or not hmac.compare_digest(confirmation['proof_hash'],digest(key,'confirmation',confirmed))
            or confirmed['nonce']!=value['nonce'] or confirmed['orderId']!=proof['orderId']
            or confirmed['operationId']!=proof['operationId'] or confirmed.get('succession',{}).get('id')!=data['grantId']):
        _fail()
    return envelope
