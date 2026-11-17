"""Private corrected-tender authority and qualified rollback calculations.

Only the Node-signed order capability can select a retained correction. Neither
the browser nor a plan field can replace historical tender. The original source
calculator, products, prices, refunds and order constructor remain unchanged.
"""
import hmac
from contextlib import contextmanager
from contextvars import ContextVar

from protocol import ImportReview,amount,canonical,digest

CONTRACT='pos-import-manager-correction-v1'
REVIEW_CONTRACT='pos-import-rejection-calculation-v1'
_SELECTED=ContextVar('pos_import_correction',default=None)


class CalculatedImportReview(ImportReview):
    """Raised only after every selected source profile guard has succeeded."""
    def __init__(self,payable):
        super().__init__('ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH')
        self.payable=amount(payable)

    def sealed_review(self,capability,key,rejected_at):
        body={'operationId':capability['operationId'],'requestHash':capability['requestHash'],
              'namespace':capability['namespace'],'planHash':capability['planHash'],
              'stageNonce':capability['nonce'],'rejectedAt':rejected_at,
              'payable':self.payable,'profileQualified':True,'profileCode':None}
        return {'contract':REVIEW_CONTRACT,'planHash':capability['planHash'],
                'stageNonce':capability['nonce'],'rejectedAt':rejected_at,
                'calculation':{'payable':self.payable,'profileQualified':True,'profileCode':None,
                               'calculationHash':digest(key,'calculation',body)}}


def fail():
    raise ImportReview('ORDER_IMPORT_CORRECTION_EVIDENCE_INVALID')


def _same(left,right):
    return hmac.compare_digest(canonical(left).encode(),canonical(right).encode())


def _validate(session,state,capability,plan,auth_key,proof_key,contract):
    from native import one,rows,json_value
    binding=state.get('correction')
    supplied=capability.get('correctionHash')
    if binding is None:
        if supplied is not None:fail()
        return None
    if contract!=CONTRACT:
        raise ImportReview('ORDER_IMPORT_CORRECTION_DISABLED')
    # The financial core revalidates the immutable correction before issuing
    # this short-lived capability. The source receives no Node encryption key.
    if not isinstance(supplied,str) or not hmac.compare_digest(digest(auth_key,'correction',binding),supplied):
        fail()
    scope=capability['scope']
    original=binding['original']
    target=binding['successor']
    boundary=original['boundary']
    calculation=boundary['calculation']
    if (binding['contract']!=CONTRACT or binding['reason']!='historical-correction' or
        plan['kind']!='offline' or binding['businessDateTime']!=plan['createdAt'] or
        binding['payment']!=plan['payment'] or binding['manager']['id']!=scope['actorId'] or
        binding['manager']['confirmHistoricalTender'] is not True or
        original['actorId']!=scope['actorId'] or
        {key:target[key] for key in scope}!=scope or
        boundary['scope']!={**scope,'operationId':original['operationId']} or
        original['operationId']==scope['operationId'] or boundary['planHash']!=original['planHash'] or
        boundary['customerId']!=capability['authority']['customerId'] or
        boundary['noFinancialEffects'] is not True or not calculation or
        calculation['profileQualified'] is not True or calculation['profileCode'] is not None or
        amount(binding['historicalTenderAmount'])!=binding['historicalTenderAmount'] or
        calculation['payable']!=binding['historicalTenderAmount']):
        fail()
    retained=one(session,"SELECT id,original_job_id,original_operation_id,successor_job_id,successor_operation_id,manager_id,plan_hash,body,receipt,created_at_ms FROM pos_rewrite_import_corrections WHERE id=:id AND OCTET_LENGTH(body)<=16000 AND OCTET_LENGTH(receipt)<=4000 FOR SHARE",{'id':binding['id']})
    receipt=json_value(retained['receipt'])
    if (not _same(json_value(retained['body']),binding) or
        retained['original_job_id']!=original['jobId'] or retained['original_operation_id']!=original['operationId'] or
        retained['successor_job_id']!=target['jobId'] or retained['successor_operation_id']!=scope['operationId'] or
        retained['manager_id']!=scope['actorId'] or retained['plan_hash']!=capability['planHash'] or
        retained['created_at_ms']!=binding['manager']['attestedAt'] or
        receipt['id']!=binding['id'] or receipt['originalJobId']!=original['jobId'] or
        receipt['originalOperationId']!=original['operationId'] or receipt['successorJobId']!=target['jobId'] or
        receipt['successorOperationId']!=scope['operationId'] or receipt['managerId']!=scope['actorId'] or
        receipt['recordedAt']!=retained['created_at_ms'] or
        receipt['originalLineValue']!=receipt['correctedLineValue'] or
        receipt['historicalTenderAmount']!=binding['historicalTenderAmount']):
        fail()
    parent=one(session,"SELECT actor_id,store_id,counter_id,request_hash,plan_hash,namespace,state FROM pos_rewrite_import_financial_operations WHERE id=:id AND OCTET_LENGTH(state)<=16000 FOR UPDATE",{'id':original['operationId']})
    prior=json_value(parent['state'])
    if (parent['actor_id']!=scope['actorId'] or parent['store_id']!=scope['storeId'] or
        parent['counter_id']!=scope['counterId'] or parent['plan_hash']!=original['planHash'] or
        parent['request_hash']!=boundary['financialRequestHash'] or parent['namespace']!=boundary['namespace'] or
        prior['scope']!=boundary['scope'] or prior['status']!='rejected' or prior['orderId'] is not None or
        prior['authority']['customerId']!=boundary['customerId'] or
        not _same(prior['authority']['contact'],boundary['contact']) or
        prior['errorCode']!=boundary['rejectionCode'] or prior['planHash']!=parent['plan_hash'] or
        prior['requestHash']!=parent['request_hash'] or prior['namespace']!=parent['namespace']):
        fail()
    stages=rows(session,"SELECT kind,nonce,request_hash,status,(proof IS NOT NULL AND JSON_TYPE(proof)<>'NULL') AS has_proof,proof_hash FROM pos_rewrite_import_financial_stages WHERE operation_id=:id LIMIT 2 FOR SHARE",{'id':original['operationId']},3)
    if (len(stages)!=1 or stages[0]['kind']!='order' or stages[0]['status']!='dispatched' or
        stages[0]['nonce']!=boundary['stageNonce'] or stages[0]['request_hash']!=boundary['stageRequestHash'] or
        stages[0]['has_proof'] or stages[0]['proof_hash'] is not None):
        fail()
    metadata=rows(session,"SELECT kind,status,OCTET_LENGTH(proof) AS size FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:id LIMIT 2 FOR SHARE",{'id':original['operationId']},3)
    if len(metadata)!=1 or metadata[0]['kind']!='order' or metadata[0]['status']!='rejected' or not 0<metadata[0]['size']<=16000:
        fail()
    negative=one(session,"SELECT request_hash,proof,proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:id AND kind='order' AND status='rejected' AND OCTET_LENGTH(proof)<=16000 FOR SHARE",{'id':original['operationId']})
    proof=json_value(negative['proof'])
    review=proof.get('review')
    if (proof['contract']!='pos-legacy-order-import-source-v1' or proof['status']!='rejected' or
        proof['operationId']!=original['operationId'] or proof['requestHash']!=boundary['financialRequestHash'] or
        proof['namespace']!=boundary['namespace'] or proof['code']!=boundary['rejectionCode'] or
        proof['noFinancialEffects'] is not True or negative['request_hash']!=proof['requestHash'] or
        not hmac.compare_digest(digest(proof_key,'rejection',proof),negative['proof_hash']) or
        negative['proof_hash']!=boundary['rejectionHash'] or not review or
        review['contract']!=REVIEW_CONTRACT or review['planHash']!=original['planHash'] or
        review['stageNonce']!=boundary['stageNonce'] or review['rejectedAt']!=boundary['rejectedAt'] or
        not _same(review['calculation'],calculation)):
        fail()
    calculated={'operationId':original['operationId'],'requestHash':boundary['financialRequestHash'],
                'namespace':boundary['namespace'],'planHash':original['planHash'],
                'stageNonce':boundary['stageNonce'],'rejectedAt':boundary['rejectedAt'],
                'payable':calculation['payable'],'profileQualified':True,'profileCode':None}
    if not hmac.compare_digest(digest(proof_key,'calculation',calculated),calculation['calculationHash']):
        fail()
    for table in ('pos_rewrite_import_financial_order_bindings','pos_rewrite_import_financial_proofs',
                  'pos_rewrite_import_financial_source_effects','pos_rewrite_import_financial_close_impacts'):
        if rows(session,'SELECT operation_id FROM '+table+' WHERE operation_id=:id LIMIT 1 FOR SHARE',{'id':original['operationId']},2):
            fail()
    return binding


@contextmanager
def selected(session,state,capability,plan,auth_key,proof_key,contract):
    if _SELECTED.get() is not None:fail()
    binding=_validate(session,state,capability,plan,auth_key,proof_key,contract)
    token=_SELECTED.set(binding)
    try:yield binding
    finally:_SELECTED.reset(token)


def effective_tender(plan):
    binding=_SELECTED.get()
    return plan['originalTenderAmount'] if binding is None else binding['historicalTenderAmount']
