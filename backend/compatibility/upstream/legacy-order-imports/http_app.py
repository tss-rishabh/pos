"""Bounded private HTTP transport; no URL/body/header/error logging."""
import hmac
import json
import re
from protocol import ImportReview
from tracing import TRUSTED_ACTOR

ROUTE=re.compile(r'^/internal/pos/legacy-order-imports/([a-f0-9-]{36})/(order|publication)$')


def private_application(receiver,key,emit_stream):
    def application(environ,start_response):
        token=TRUSTED_ACTOR.set(None)
        request_id=environ.get('HTTP_X_REQUEST_ID','')
        request_id=request_id if re.fullmatch(r'[A-Za-z0-9._:-]{1,128}',request_id) else None
        status='409 Conflict'
        try:
            match=ROUTE.fullmatch(environ.get('PATH_INFO',''))
            supplied=environ.get('HTTP_X_POS_LEGACY_IMPORT_KEY','')
            length=int(environ.get('CONTENT_LENGTH','0'))
            limit=1400000 if match and match[2]=='order' else 256000
            if (not match or environ.get('REQUEST_METHOD')!='POST' or environ.get('QUERY_STRING') or
                environ.get('CONTENT_TYPE','').split(';')[0]!='application/json' or
                not 0<length<=limit or not isinstance(supplied,str) or not hmac.compare_digest(key,supplied)):
                raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
            raw=environ['wsgi.input'].read(length)
            if len(raw)!=length:
                raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
            value=json.loads(raw)
            if (not isinstance(value,dict) or environ.get('HTTP_X_POS_OPERATOR_ID','')!=
                value.get('capability',{}).get('scope',{}).get('actorId')):
                raise ImportReview('ORDER_IMPORT_CAPABILITY_INVALID')
            result=getattr(receiver,match[2])(match[1],value)
            status='200 OK'
            body=json.dumps(result,separators=(',',':')).encode()
        except Exception as error:
            code=error.code if isinstance(error,ImportReview) else 'ORDER_IMPORT_SOURCE_REVIEW'
            body=json.dumps({'code':code},separators=(',',':')).encode()
        try:
            event={'module':'legacy-order-imports','resource':'financial-receivers',
                'eventId':'legacy-order-imports.financial-receivers.recorded' if status=='200 OK' else 'legacy-order-imports.financial-receivers.review',
                'requestId':request_id,'userId':TRUSTED_ACTOR.get()}
            # An optional log sink failure cannot change a known SQL outcome.
            try:
                emit_stream.write(json.dumps(event,separators=(',',':'))+'\n')
                emit_stream.flush()
            except Exception:
                pass
            start_response(status,[('Content-Type','application/json'),('Cache-Control','private, no-store'),
                ('Content-Length',str(len(body))),('X-Content-Type-Options','nosniff')])
            return [body]
        finally:
            TRUSTED_ACTOR.reset(token)
    return application
