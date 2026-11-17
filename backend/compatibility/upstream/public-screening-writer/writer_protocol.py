"""Node-origin POS writer capability/quote codec. No database/provider access."""
import base64
import hashlib
import hmac
import json
import math
import re
import struct

CONTRACT='pos-node-screening-writer-v1'
HEADER='X-POS-Screening-Writer'
SQL_MAX=9223372036854775807
SAFE=9007199254740991
FIELDS={'v','contract','operationId','checkoutId','checkoutVersion','actorId','actorVersion','actorEpoch',
        'customerId','contact','storeId','counterId','cartHash','requestHash','issuedAt','expiresAt'}


class ScreeningWriterError(Exception):
    def __init__(self,code='SCREENING_WRITER_SCOPE_CHANGED'):
        self.code=code
        super().__init__('The source sale needs verification.')


def fail(code='SCREENING_WRITER_SCOPE_CHANGED'):
    raise ScreeningWriterError(code) from None


def key(value):
    if not isinstance(value,str) or not re.fullmatch(r'[!-~]{32,4096}',value):fail('SCREENING_WRITER_UNAVAILABLE')
    return hmac.new(value.encode(),(CONTRACT+'.capability-key').encode(),hashlib.sha256).digest()


def _unique(pairs):
    result={}
    for name,value in pairs:
        if name in result:fail()
        result[name]=value
    return result


def validate_saved(cap):
    """Bounded immutable shape only; not authorization or a renewed capability."""
    try:
        if (not isinstance(cap,dict) or not FIELDS.issubset(cap) or set(cap)-FIELDS-{'benefitsContract','membershipHistoryHash'}
                or type(cap['v']) is not int or cap['v']!=1 or cap['contract']!=CONTRACT):fail()
        if 'benefitsContract' in cap and cap['benefitsContract']!='pos-node-screening-benefits-v1':fail()
        if 'membershipHistoryHash' in cap and (cap.get('benefitsContract')!='pos-node-screening-benefits-v1'
                or not isinstance(cap['membershipHistoryHash'],str) or not re.fullmatch(r'[a-f0-9]{64}',cap['membershipHistoryHash'])):fail()
        for name in ('operationId','checkoutId'):
            if not isinstance(cap[name],str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',cap[name]):fail()
        for name in ('actorId','customerId','storeId','counterId'):
            if not isinstance(cap[name],str) or not re.fullmatch(r'[1-9][0-9]{0,18}',cap[name]) or int(cap[name])>SQL_MAX:fail()
        for name in ('actorVersion','cartHash','requestHash'):
            if not isinstance(cap[name],str) or not re.fullmatch(r'[a-f0-9]{64}',cap[name]):fail()
        if not isinstance(cap['contact'],dict) or set(cap['contact'])!={'revision','digest'}:fail()
        if not isinstance(cap['contact']['digest'],str) or not re.fullmatch(r'[a-f0-9]{64}',cap['contact']['digest']):fail()
        for number in (cap['actorEpoch'],cap['contact']['revision']):
            if not isinstance(number,str) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,19})',number) or int(number)>18446744073709551615:fail()
        for name in ('checkoutVersion','issuedAt','expiresAt'):
            if type(cap[name]) is not int or not 0<=cap[name]<=SAFE:fail()
        if cap['issuedAt']<1 or cap['expiresAt']<=cap['issuedAt'] or cap['expiresAt']>cap['issuedAt']+60000:fail()
        return cap
    except ScreeningWriterError:raise
    except Exception:fail()


def verify(value,secret,now):
    derived=key(secret)
    try:
        if not isinstance(value,str) or len(value)>4096:fail()
        parts=value.split('.')
        if len(parts)!=2 or not re.fullmatch(r'[A-Za-z0-9_-]+',parts[0]) or not re.fullmatch(r'[a-f0-9]{64}',parts[1]):fail()
        raw=base64.urlsafe_b64decode(parts[0]+'='*((4-len(parts[0])%4)%4))
        if base64.urlsafe_b64encode(raw).decode().rstrip('=')!=parts[0]:fail()
        signature=hmac.new(derived,(CONTRACT+'\n'+parts[0]).encode(),hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature,parts[1]):fail()
        cap=validate_saved(json.loads(raw.decode('utf-8'),object_pairs_hook=_unique))
        if cap['issuedAt']>now or cap['expiresAt']<=now:fail()
        return cap
    except ScreeningWriterError:raise
    except Exception:fail()


def portable_hash(value):
    nodes=0;size=0
    def utf8(value):
        nonlocal size
        try:encoded=value.encode('utf-8')
        except UnicodeError:fail()
        size+=len(encoded)
        if size>2000000:fail()
        return encoded
    def visit(value,depth):
        nonlocal nodes
        nodes+=1
        if nodes>100000 or depth>24:fail()
        if value is None:return ['null']
        if type(value) is bool:return ['bool',value]
        if type(value) is str:utf8(value);return ['str',value]
        if type(value) is int and abs(value)>SAFE:return visit(str(value),depth+1)
        if type(value) in (int,float):
            if not math.isfinite(value) or type(value) is float and value.is_integer() and abs(value)>SAFE:fail()
            return ['f64',struct.pack('>d',float(0 if value==0 else value)).hex()]
        if type(value) is list:return ['list',[visit(item,depth+1) for item in value]]
        if type(value) is not dict or any(type(name) is not str for name in value):fail()
        names=sorted(value,key=lambda name:name.encode('utf-8'))
        result=[]
        for name in names:utf8(name);result.append([name,visit(value[name],depth+1)])
        return ['map',result]
    try:normalized=visit(value,0)
    except ScreeningWriterError:raise
    except Exception:fail()
    raw=json.dumps(normalized,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def quote_snapshot(value):
    try:
        if not isinstance(value,dict) or not isinstance(value['products']['items'],list) or len(value['products']['items'])>500:fail()
        meta=value['meta']['items']
        if not isinstance(meta,list) or len(meta)>1000:fail()
        names=set();rows=[]
        for row in meta:
            if not isinstance(row,dict) or not isinstance(row.get('name'),str) or row['name'] in names:fail()
            names.add(row['name'])
            if row['name']!='payment_details':rows.append(row)
        if 'calculations' not in names:fail()
        rows.sort(key=lambda row:row['name'].encode('utf-8'))
        def items(name,maximum):
            values=value.get(name,{}).get('items',[])
            if not isinstance(values,list) or len(values)>maximum or any(not isinstance(item,dict) for item in values):fail()
            return [{name:entry for name,entry in item.items() if name not in ('stock','variant','images')} for item in values]
        return {'products':items('products',500),'giftvouchers':items('giftvouchers',100),
                'complementary_products':items('complementary_products',500),'meta':rows,
                'selected_products':value.get('selected_products')}
    except ScreeningWriterError:raise
    except Exception:fail()
