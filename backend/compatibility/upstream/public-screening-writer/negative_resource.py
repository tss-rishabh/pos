"""Private, purpose-authenticated no-order closure; never a create retry."""
import hmac
import json
import re
import time
from writer_protocol import ScreeningWriterError,fail
from protocol import ImportReview
from negative import NegativeResource
from transaction import CURRENT

SELECTOR='pos-node-screening-negative-resource-v1'
PREFIX='/internal/pos/public-screening/no-order-receipts'
HEADER='HTTP_X_POS_PUBLIC_SCREENING_NEGATIVE_KEY'
UUID=re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')


def options(environment,proof_key,other_keys=()):
    contract=environment.get('POS_PUBLIC_SCREENING_NEGATIVE_CONTRACT')
    key=environment.get('POS_PUBLIC_SCREENING_NEGATIVE_KEY','')
    if contract in (None,'') and key in (None,''):return None
    if (contract not in (None,'',SELECTOR) or not isinstance(key,str) or not re.fullmatch(r'[!-~]{32,4096}',key)
            or key==proof_key or key in other_keys):fail('SCREENING_NEGATIVE_UNAVAILABLE')
    return {'key':key,'allowPost':contract==SELECTOR}


def _unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:fail('SCREENING_NEGATIVE_REQUEST_INVALID')
        result[key]=value
    return result


def private_application(resource,key,emit_stream,fallback=None,allow_post=True):
    """Mount only at private mTLS ingress. GET never creates a tombstone."""
    if not isinstance(key,str) or not re.fullmatch(r'[!-~]{32,4096}',key):fail('SCREENING_NEGATIVE_UNAVAILABLE')
    def application(environ,start_response):
        path=environ.get('PATH_INFO','')
        if path!=PREFIX and not path.startswith(PREFIX+'/') and fallback is not None:
            return fallback(environ,start_response)
        status='409 Conflict';actor=None;action='read'
        request_id=environ.get('HTTP_X_REQUEST_ID','')
        request_id=request_id if isinstance(request_id,str) and re.fullmatch(r'[A-Za-z0-9._:-]{1,128}',request_id) else None
        try:
            supplied=environ.get(HEADER,'')
            if not isinstance(supplied,str) or not re.fullmatch(r'[!-~]{32,4096}',supplied) or not hmac.compare_digest(key,supplied):
                status='401 Unauthorized';fail('SCREENING_NEGATIVE_UNAUTHORIZED')
            if CURRENT.get() is not None or environ.get('QUERY_STRING'):fail('SCREENING_NEGATIVE_REQUEST_INVALID')
            method=environ.get('REQUEST_METHOD')
            if method=='POST' and path==PREFIX:
                action='record'
                if not allow_post:fail('SCREENING_NEGATIVE_UNAVAILABLE')
                if environ.get('CONTENT_TYPE','').split(';')[0]!='application/json':fail('SCREENING_NEGATIVE_REQUEST_INVALID')
                length=int(environ.get('CONTENT_LENGTH','0'))
                if not 0<length<=128:fail('SCREENING_NEGATIVE_REQUEST_INVALID')
                raw=environ['wsgi.input'].read(length)
                if len(raw)!=length:fail('SCREENING_NEGATIVE_REQUEST_INVALID')
                body=json.loads(raw,object_pairs_hook=_unique)
                if not isinstance(body,dict) or set(body)!={'operationId'} or not isinstance(body['operationId'],str) or not UUID.fullmatch(body['operationId']):fail('SCREENING_NEGATIVE_REQUEST_INVALID')
                result=resource.post(body['operationId'])
            elif method=='GET' and path.startswith(PREFIX+'/') and UUID.fullmatch(path[len(PREFIX)+1:]):
                if environ.get('CONTENT_LENGTH','0') not in ('','0'):fail('SCREENING_NEGATIVE_REQUEST_INVALID')
                result=resource.read(path[len(PREFIX)+1:])
            else:fail('SCREENING_NEGATIVE_REQUEST_INVALID')
            if result is None:
                # This is absence of a receipt, never evidence of no effects.
                status='404 Not Found';body=b'{"code":"SCREENING_NEGATIVE_NOT_FOUND"}'
            else:
                actor=result['data']['intent']['actorId']
                status='200 OK';body=json.dumps(result,separators=(',',':')).encode()
        except Exception as error:
            code=error.code if isinstance(error,(ScreeningWriterError,ImportReview)) else 'SCREENING_NEGATIVE_REVIEW'
            if not isinstance(code,str) or not re.fullmatch(r'(?:SCREENING|ORDER_IMPORT)_[A-Z_]{1,96}',code):code='SCREENING_NEGATIVE_REVIEW'
            body=json.dumps({'code':code},separators=(',',':')).encode()
        event={'module':'public-screening','resource':'no-order-receipts',
               'eventId':'public-screening.no-order-receipts.'+(action if status=='200 OK' else 'review'),
               'requestId':request_id,'userId':actor}
        try:emit_stream.write(json.dumps(event,separators=(',',':'))+'\n');emit_stream.flush()
        except Exception:pass
        start_response(status,[('Content-Type','application/json'),('Cache-Control','private, no-store'),
                               ('Content-Length',str(len(body))),('X-Content-Type-Options','nosniff')])
        return [body]
    return application


def resource(sessions,proof_key):
    return NegativeResource(sessions,proof_key,lambda:int(time.time()*1000))
