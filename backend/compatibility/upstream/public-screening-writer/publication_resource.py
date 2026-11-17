"""Private post-completion delivery resource. GET never routes or publishes.

The independently paid, COUNTED source receipt and the immutable native
projection are rechecked on every read. A paid flag is not a delivery proof.
This resource must be exposed only by the private mTLS service.
"""
import hmac
import json
import re
from protocol import ImportReview, digest
from writer_protocol import ScreeningWriterError, fail
from native_authority import one, value_json
from public_effects import _hint, _prefix, _completed, publish
from creation import creation_hash
from receiver import open_effects
from effects import KINDS
from tracing import TRUSTED_ACTOR
from transaction import CURRENT

CONTRACT='pos-node-screening-publication-v1'
SELECTOR='pos-node-screening-publication-resource-v1'
PREFIX='/internal/pos/public-screening/publications'
HEADER='HTTP_X_POS_PUBLIC_SCREENING_PUBLICATION_KEY'
UUID=re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
HASH=re.compile(r'[a-f0-9]{64}')
STATES={'pending','processing','uncertain','accepted','cancelled'}
SAFE=9007199254740991


def options(environment,proof_key,other_keys=()):
    """Default off. A retained independent key permits GET-only recovery."""
    contract=environment.get('POS_PUBLIC_SCREENING_PUBLICATION_CONTRACT')
    key=environment.get('POS_PUBLIC_SCREENING_PUBLICATION_KEY','')
    if contract in (None,'') and key in (None,''):return None
    if (contract not in (None,'',SELECTOR) or not isinstance(key,str) or not re.fullmatch(r'[!-~]{32,4096}',key)
            or key==proof_key or key in other_keys):
        fail('SCREENING_PUBLICATION_UNAVAILABLE')
    return {'contract':contract,'key':key,'allowPost':contract==SELECTOR}


def expected_kinds(intents):
    result=[]
    for intent in intents:
        if not isinstance(intent,dict):fail()
        if set(intent)=={'call'}:
            call=intent['call']
            if not isinstance(call,dict) or call.get('name') not in KINDS:fail()
            result.append(KINDS[call['name']])
        elif set(intent)=={'chain','args','options'}:
            if [row.get('name') for row in intent['chain']]!=['sync_kinesis_orders','insert_into_kinesis']:fail()
            result.append('kinesis-chain')
        else:fail()
    return result


class PublicationResource:
    def __init__(self,sessions,proof_key,tasks,clock=None):
        self.sessions=sessions;self.proof_key=proof_key;self.tasks=tasks;self.clock=clock
        from public_benefit_cache import install_kind
        install_kind()  # Retained GETs remain readable with new selection off.

    def read(self,operation):
        if not isinstance(operation,str) or not UUID.fullmatch(operation) or CURRENT.get() is not None:
            fail('SCREENING_PUBLICATION_SCOPE_INVALID')
        hint=_hint(self.sessions,operation,self.proof_key)
        with self.sessions() as session:
            with session.begin():
                session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                _prefix(session,hint)
                creation=_completed(session,hint,self.proof_key)
                completion=one(session,'SELECT proof_hash FROM pos_rewrite_public_screening_completions WHERE operation_id=:id FOR SHARE',{'id':operation})
                effect=one(session,'SELECT payload,effects_hash,status,deliveries,updated_at_ms FROM pos_rewrite_public_screening_effects WHERE operation_id=:id FOR SHARE',{'id':operation})
                if effect['effects_hash']!=creation['effectsHash']:fail()
                intents=open_effects(self.proof_key,'public-screening:'+operation,effect['payload'],effect['effects_hash'])
                kinds=expected_kinds(intents)
                deliveries=value_json(effect['deliveries']);status=effect['status'];updated=effect['updated_at_ms']
                if (status not in STATES or not isinstance(deliveries,list) or len(deliveries)>len(kinds)
                        or type(updated) is not int or not creation['createdAt']<=updated<=SAFE
                        or status in ('pending','processing','cancelled') and deliveries
                        or status=='accepted' and len(deliveries)!=len(kinds)
                        or not isinstance(completion['proof_hash'],str) or not HASH.fullmatch(completion['proof_hash'])):fail()
                seen=set()
                for index,row in enumerate(deliveries):
                    if (not isinstance(row,dict) or set(row)!={'id','kind'} or row['kind']!=kinds[index]
                            or not isinstance(row['id'],str) or not re.fullmatch(r'[A-Za-z0-9:_-]{1,128}',row['id'])
                            or row['id'] in seen):fail()
                    seen.add(row['id'])
                # This actor comes only from the verified immutable creation.
                TRUSTED_ACTOR.set(creation['actorId'])
                data={'contract':CONTRACT,'operationId':operation,'creationHash':creation_hash(self.proof_key,creation),
                      'completionHash':completion['proof_hash'],'effectsHash':effect['effects_hash'],
                      'status':status,'deliveries':deliveries,'updatedAt':updated}
                if 'benefitsHash' in creation:
                    from public_benefit_cache import read as cache_state
                    cached=cache_state(session,creation,self.proof_key)
                    if cached is not None:
                        data['benefitCacheStatus']=cached['status']
                        data['updatedAt']=max(data['updatedAt'],cached['updatedAt'])
                return {'data':data,'proofHash':digest(self.proof_key,'public-screening-publication',data)}

    def post(self,operation):
        # Read first: even a replay cannot route/publish an unverified creation.
        current=self.read(operation)
        if current['data']['status']=='pending':
            publish(self.sessions,operation,self.proof_key,self.tasks,self.clock)
        return self.read(operation)


def _unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:fail('SCREENING_PUBLICATION_REQUEST_INVALID')
        result[key]=value
    return result


def private_application(resource,key,emit_stream,fallback=None,allow_post=True):
    """Exact paths, bounded JSON, confidential auth, allowlisted static events."""
    if not isinstance(key,str) or not re.fullmatch(r'[!-~]{32,4096}',key):fail('SCREENING_PUBLICATION_UNAVAILABLE')
    def application(environ,start_response):
        path=environ.get('PATH_INFO','')
        if path!=PREFIX and not path.startswith(PREFIX+'/'):
            if fallback is not None:return fallback(environ,start_response)
        actor=TRUSTED_ACTOR.set(None);status='409 Conflict'
        request_id=environ.get('HTTP_X_REQUEST_ID','')
        request_id=request_id if isinstance(request_id,str) and re.fullmatch(r'[A-Za-z0-9._:-]{1,128}',request_id) else None
        method=environ.get('REQUEST_METHOD');action='read' if method=='GET' else 'recorded'
        try:
            supplied=environ.get(HEADER,'')
            if (not isinstance(supplied,str) or len(supplied)>4096 or not hmac.compare_digest(key,supplied)):
                status='401 Unauthorized';fail('SCREENING_PUBLICATION_UNAUTHORIZED')
            if environ.get('QUERY_STRING'):fail('SCREENING_PUBLICATION_REQUEST_INVALID')
            if method=='POST' and path==PREFIX:
                if not allow_post:fail('SCREENING_PUBLICATION_UNAVAILABLE')
                if environ.get('CONTENT_TYPE','').split(';')[0]!='application/json':fail('SCREENING_PUBLICATION_REQUEST_INVALID')
                length=int(environ.get('CONTENT_LENGTH','0'))
                if not 0<length<=128:fail('SCREENING_PUBLICATION_REQUEST_INVALID')
                raw=environ['wsgi.input'].read(length)
                if len(raw)!=length:fail('SCREENING_PUBLICATION_REQUEST_INVALID')
                body=json.loads(raw,object_pairs_hook=_unique)
                if not isinstance(body,dict) or set(body)!={'operationId'} or not isinstance(body['operationId'],str) or not UUID.fullmatch(body['operationId']):fail('SCREENING_PUBLICATION_REQUEST_INVALID')
                result=resource.post(body['operationId'])
            elif method=='GET' and path.startswith(PREFIX+'/') and UUID.fullmatch(path[len(PREFIX)+1:]):
                if environ.get('CONTENT_LENGTH','0') not in ('','0'):fail('SCREENING_PUBLICATION_REQUEST_INVALID')
                result=resource.read(path[len(PREFIX)+1:])
            else:fail('SCREENING_PUBLICATION_REQUEST_INVALID')
            status='200 OK';body=json.dumps(result,separators=(',',':')).encode()
        except Exception as error:
            code=error.code if isinstance(error,(ScreeningWriterError,ImportReview)) else 'SCREENING_PUBLICATION_REVIEW'
            # Never pass arbitrary exception text or codes from dependencies.
            if not isinstance(code,str) or not re.fullmatch(r'(?:SCREENING|ORDER_IMPORT)_[A-Z_]{1,96}',code):code='SCREENING_PUBLICATION_REVIEW'
            body=json.dumps({'code':code},separators=(',',':')).encode()
        try:
            event={'module':'public-screening','resource':'publications',
                   'eventId':'public-screening.publications.'+(action if status=='200 OK' else 'review'),
                   'requestId':request_id,'userId':TRUSTED_ACTOR.get()}
            try:emit_stream.write(json.dumps(event,separators=(',',':'))+'\n');emit_stream.flush()
            except Exception:pass
            start_response(status,[('Content-Type','application/json'),('Cache-Control','private, no-store'),
                                   ('Content-Length',str(len(body))),('X-Content-Type-Options','nosniff')])
            return [body]
        finally:TRUSTED_ACTOR.reset(actor)
    return application
