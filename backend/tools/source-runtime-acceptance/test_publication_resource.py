"""HTTP/privacy and retained-proof projection tests; no remote effects."""
import hashlib
import io
import json
import sys
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports'))
sys.path.insert(0,str(ROOT/'compatibility/upstream/public-screening-writer'))
import publication_resource as resource
from protocol import digest,canonical
from receiver import seal_effects
from tracing import TRUSTED_ACTOR

KEY='isolated-publication-resource-caller-key-'*2
PROOF='isolated-publication-native-proof-key-'*2
OP='11111111-1111-4111-8111-111111111111'


def request(app,method='GET',path=None,body=None,key=KEY,**extras):
    raw=json.dumps(body,separators=(',',':')).encode() if body is not None else b''
    environ={'PATH_INFO':path or resource.PREFIX+'/'+OP,'REQUEST_METHOD':method,'QUERY_STRING':'',
             resource.HEADER:key,'CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(raw)),
             'HTTP_X_REQUEST_ID':'fixture-request','wsgi.input':io.BytesIO(raw),**extras}
    status=[]
    result=b''.join(app(environ,lambda code,headers:status.append((code,dict(headers)))))
    return status[0],json.loads(result)


class Transport(unittest.TestCase):
    def setUp(self):
        self.calls=[];self.logs=io.StringIO()
        def call(kind,operation):
            self.calls.append((kind,operation));TRUSTED_ACTOR.set('7');return {'status':'accepted'}
        self.target=SimpleNamespace(read=lambda op:call('read',op),post=lambda op:call('post',op))
        self.app=resource.private_application(self.target,KEY,self.logs)

    def test_exact_post_and_get_paths_and_source_only_actor(self):
        status,body=request(self.app,'POST',resource.PREFIX,{'operationId':OP})
        self.assertEqual(status[0],'200 OK');self.assertEqual(body,{'status':'accepted'})
        self.assertEqual(request(self.app)[0][0],'200 OK')
        self.assertEqual(self.calls,[('post',OP),('read',OP)])
        self.assertEqual(json.loads(self.logs.getvalue().splitlines()[0]),{'module':'public-screening','resource':'publications',
            'eventId':'public-screening.publications.recorded','requestId':'fixture-request','userId':'7'})
        self.assertIsNone(TRUSTED_ACTOR.get())
        self.assertEqual(status[1]['Cache-Control'],'private, no-store')

    def test_bad_auth_routes_query_json_and_extra_scope_are_refused_before_handler(self):
        values=[{'key':'wrong-private-key'},{'QUERY_STRING':'customer=private@example.test'},
                {'path':resource.PREFIX+'/'+OP+'/again'},{'method':'DELETE'},
                {'method':'POST','path':resource.PREFIX,'body':{'operationId':OP,'paid':True}},
                {'method':'POST','path':resource.PREFIX,'body':{'operationId':OP},'CONTENT_LENGTH':'999999'}]
        for value in values:
            with self.subTest(case=values.index(value)):
                status,body=request(self.app,**value)
                self.assertNotEqual(status[0],'200 OK');self.assertIn('code',body)
        self.assertEqual(self.calls,[])
        for forbidden in ('private@example.test','wrong-private-key',OP,'paid','QUERY_STRING'):
            self.assertNotIn(forbidden,self.logs.getvalue())

    def test_unknown_error_and_log_sink_failure_never_exposes_payload_or_erases_receipt(self):
        def failed(_op):raise ValueError('private@example.test?credential=secret')
        self.target.post=failed
        status,body=request(self.app,'POST',resource.PREFIX,{'operationId':OP})
        self.assertEqual(body,{'code':'SCREENING_PUBLICATION_REVIEW'})
        self.assertNotIn('credential',self.logs.getvalue())
        class Broken:
            def write(self,_value):raise OSError('fixture')
        app=resource.private_application(self.target,KEY,Broken())
        self.assertEqual(request(app)[0][0],'200 OK')

    def test_options_are_default_off_and_keys_separate_without_raw_errors(self):
        self.assertIsNone(resource.options({},PROOF))
        self.assertEqual(resource.options({'POS_PUBLIC_SCREENING_PUBLICATION_CONTRACT':resource.SELECTOR,'POS_PUBLIC_SCREENING_PUBLICATION_KEY':KEY},PROOF)['key'],KEY)
        self.assertIs(resource.options({'POS_PUBLIC_SCREENING_PUBLICATION_KEY':KEY},PROOF)['allowPost'],False)
        for key in (PROOF,'short','source-auth-private-key-'*2):
            with self.assertRaises(Exception) as error:
                resource.options({'POS_PUBLIC_SCREENING_PUBLICATION_CONTRACT':resource.SELECTOR,'POS_PUBLIC_SCREENING_PUBLICATION_KEY':key},PROOF,('source-auth-private-key-'*2,))
            self.assertNotIn(key,str(error.exception))

    def test_retained_key_recovery_mount_never_admits_a_new_post_when_selection_is_off(self):
        app=resource.private_application(self.target,KEY,self.logs,allow_post=False)
        self.assertEqual(request(app,'POST',resource.PREFIX,{'operationId':OP})[1],{'code':'SCREENING_PUBLICATION_UNAVAILABLE'})
        self.assertEqual(self.calls,[])
        self.assertEqual(request(app)[0][0],'200 OK')
        self.assertEqual(self.calls,[('read',OP)])


class Session:
    def __enter__(self):return self
    def __exit__(self,*_args):pass
    def begin(self):return nullcontext()
    def connection(self,**_kwargs):return None


class RetainedStatus(unittest.TestCase):
    def setUp(self):
        self.intents=[{'call':{'name':'send_order_placed_sms','args':[5001],'kwargs':{},'options':{}}}]
        self.creation={'operationId':OP,'actorId':'7','customerId':'77','storeId':'1','counterId':'2','createdAt':1000,
                       'effectsHash':hashlib.sha256(canonical(self.intents).encode()).hexdigest()}
        self.effect={'payload':seal_effects(PROOF,'public-screening:'+OP,self.intents),'effects_hash':self.creation['effectsHash'],
                     'status':'pending','deliveries':'[]','updated_at_ms':1001}
        self.prefix=[];self.completed=[]
        self.patches=[patch.object(resource,'_hint',lambda *_a:self.creation),
                      patch.object(resource,'_prefix',lambda *_a:self.prefix.append(True)),
                      patch.object(resource,'_completed',lambda *_a:(self.completed.append(True) or self.creation)),
                      patch.object(resource,'one',lambda _s,sql,_p:{'proof_hash':'c'*64} if 'completions' in sql else self.effect)]
        for item in self.patches:item.start()
        self.target=resource.PublicationResource(Session,PROOF,object())
    def tearDown(self):
        for item in reversed(self.patches):item.stop()
        TRUSTED_ACTOR.set(None)

    def test_get_projects_only_safe_signed_retained_fields_without_touching_tasks(self):
        with patch.object(resource,'publish',side_effect=AssertionError('GET sent an effect')):
            value=self.target.read(OP)
        proof=value['proofHash'];data=value['data']
        self.assertEqual(proof,digest(PROOF,'public-screening-publication',data))
        self.assertEqual(data['status'],'pending');self.assertEqual(data['deliveries'],[])
        self.assertEqual(set(data),{'contract','operationId','creationHash','completionHash','effectsHash','status','deliveries','updatedAt'})
        self.assertEqual(self.prefix,[True]);self.assertEqual(self.completed,[True])

    def test_post_only_publishes_pending_then_rereads_and_accepted_replay_never_sends(self):
        sent=[]
        def publish(*_a):
            sent.append(True);self.effect.update(status='accepted',deliveries=json.dumps([{'id':'original-task-id','kind':'sms'}]),updated_at_ms=1002)
        with patch.object(resource,'publish',publish):
            first=self.target.post(OP);second=self.target.post(OP)
        self.assertEqual(first,second);self.assertEqual(len(sent),1)
        self.assertEqual(first['data']['deliveries'],[{'id':'original-task-id','kind':'sms'}])

    def test_processing_or_uncertain_never_resends_and_bad_acceptance_never_becomes_success(self):
        for status in ('processing','uncertain','cancelled'):
            self.effect['status']=status
            with patch.object(resource,'publish',side_effect=AssertionError('Retried an unknown send')):
                self.assertEqual(self.target.post(OP)['data']['status'],status)
        self.effect['status']='accepted'
        with self.assertRaises(Exception):self.target.read(OP)
        self.effect['deliveries']=json.dumps([{'id':'original-task-id','kind':'warehouse'}])
        with self.assertRaises(Exception):self.target.read(OP)

    def test_modified_ciphertext_hash_or_nonmatching_native_completion_is_refused(self):
        self.effect['effects_hash']='a'*64
        with self.assertRaises(Exception):self.target.read(OP)
        self.effect['effects_hash']=self.creation['effectsHash'];self.effect['payload']='not-sealed'
        with self.assertRaises(Exception):self.target.read(OP)
        with patch.object(resource,'_completed',side_effect=ValueError('unverified completion')):
            with self.assertRaises(ValueError):self.target.read(OP)


if __name__=='__main__':unittest.main()
