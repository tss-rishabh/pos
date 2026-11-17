"""Independent source-origin commands. No POS operator/customer token issuer."""
import hashlib
import hmac
import json
import re
from writer_protocol import portable_hash

CONTRACT='pos-screening-origins-v1'
PROOF='pos-screening-origin-command-v1'
ORIGINS=('customer','legacy-django','mpos','external-system')
PHASES=('PREPARED','RESERVED','BOUND','COUNTED','REJECTED')
FIELDS={'contract','id','origin','customerId','actorId','storeId','counterId','namespaceHash',
        'requestHash','cartHash','referenceHash','authorityHash','quantity','markerRows','lineItemsEnabled',
        'phase','orderId','lines','markers','creationHash','closureHash','version','createdAt','updatedAt','expiresAt'}
UUID=re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
HASH=re.compile(r'[a-f0-9]{64}')

class OriginReview(Exception):
    def __init__(self,code='SCREENING_ORIGIN_RECONCILIATION_REQUIRED'):
        self.code=code
        super().__init__('The original screening command requires verification.')

def fail(code='SCREENING_ORIGIN_RECONCILIATION_REQUIRED'):raise OriginReview(code) from None
def unsafe(code='SCREENING_ORIGIN_RECONCILIATION_REQUIRED'):
    # Refusals swallowed by a literal source except block must still roll back.
    from transaction import VIOLATION
    VIOLATION.set(True)
    fail(code)
def identifier(value):
    if type(value) not in (str,int) or not re.fullmatch(r'[1-9][0-9]{0,18}',str(value)) or int(value)>9223372036854775807:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
    return str(value)
def canonical(value):
    try:return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)
    except Exception:fail()
def digest(key,purpose,value):
    if not isinstance(key,str) or not re.fullmatch(r'[!-~]{32,4096}',key):fail('SCREENING_ORIGIN_KEY_REQUIRED')
    return hmac.new(key.encode(),('{"kind":"screening-origin.'+purpose+'.v1","input":'+canonical(value)+'}').encode(),hashlib.sha256).hexdigest()
def fingerprint(key,purpose,value):return digest(key,purpose,portable_hash(value))
def point(value):return type(value) is int and 0<value<=9007199254740991
def command(value):
    if not isinstance(value,dict) or set(value)!=FIELDS or value['contract']!=PROOF or value['origin'] not in ORIGINS or value['phase'] not in PHASES:fail()
    if not isinstance(value['id'],str) or not UUID.fullmatch(value['id']):fail()
    identifier(value['customerId'])
    staff=value['origin'] in ('legacy-django','mpos')
    if staff:
        for name in ('actorId','storeId','counterId'):identifier(value[name])
    elif any(value[name] is not None for name in ('actorId','storeId','counterId')):fail()
    for name in ('namespaceHash','requestHash','cartHash','referenceHash','authorityHash'):
        if not isinstance(value[name],str) or not HASH.fullmatch(value[name]):fail()
    if (type(value['quantity']) is not int or value['quantity'] not in (1,2) or type(value['lineItemsEnabled']) is not bool
            or type(value['markerRows']) is not int or value['markerRows'] not in (1,2)
            or value['markerRows']!=(value['quantity'] if value['lineItemsEnabled'] else 1)
            or any(not point(value[name]) for name in ('version','createdAt','updatedAt','expiresAt'))
            or value['updatedAt']<value['createdAt'] or not value['createdAt']<value['expiresAt']<=value['createdAt']+600000):fail()
    bound=value['phase'] in ('BOUND','COUNTED')
    if bound:identifier(value['orderId'])
    elif value['orderId'] is not None:fail()
    if (not isinstance(value['lines'],list) or not isinstance(value['markers'],list)
            or len(value['lines'])!=(value['markerRows'] if bound else 0) or len(value['markers'])!=(value['markerRows'] if bound else 0)):fail()
    for line in value['lines']:
        if not isinstance(line,dict) or set(line)!={'id','quantity'} or type(line['quantity']) is not int or line['quantity'] not in (1,2):fail()
        identifier(line['id'])
    for marker in value['markers']:
        if not isinstance(marker,dict) or set(marker)!={'id','lineId'}:fail()
        identifier(marker['id']);identifier(marker['lineId'])
    if (len({line['id'] for line in value['lines']})!=len(value['lines']) or len({row['id'] for row in value['markers']})!=len(value['markers'])
            or len({row['lineId'] for row in value['markers']})!=len(value['markers'])
            or any(row['lineId'] not in {line['id'] for line in value['lines']} for row in value['markers'])
            or bound and sum(line['quantity'] for line in value['lines'])!=value['quantity']):fail()
    for name in ('creationHash','closureHash'):
        if value[name] is not None and (not isinstance(value[name],str) or not HASH.fullmatch(value[name])):fail()
    if bound!=(value['creationHash'] is not None) or (value['phase']=='REJECTED')!=(value['closureHash'] is not None):fail()
    return value

def checked(row,key):
    try:value=json.loads(row['data']) if isinstance(row['data'],(str,bytes)) else row['data']
    except Exception:fail()
    value=command(value)
    if (str(row['id'])!=value['id'] or str(row['customer_id'])!=value['customerId'] or row['origin']!=value['origin']
            or row['phase']!=value['phase'] or (None if row['order_id'] is None else str(row['order_id']))!=value['orderId']
            or not isinstance(row['proof_hash'],str) or not hmac.compare_digest(digest(key,'command',value),row['proof_hash'])):fail()
    return value
