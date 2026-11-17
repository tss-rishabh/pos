"""Private transport refuses untrusted requests before opening a session."""
import io
import json
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
for name in ('legacy-order-imports','offline-cash-pricing','public-screening-writer'):
    sys.path.insert(0,str(ROOT/'compatibility/upstream'/name))
from negative_resource import private_application,options,PREFIX,SELECTOR
from negative import NegativeResource
from writer_protocol import ScreeningWriterError

KEY='isolated-negative-transport-key-'.join(['key']*4)
OP='22222222-2222-4222-8222-222222222222'


class NegativeTransportTests(unittest.TestCase):
    def call(self,resource,method='POST',key=KEY,path=PREFIX,body=None,query='',allow_post=True):
        raw=json.dumps({'operationId':OP} if body is None else body).encode() if method=='POST' else b''
        stream=io.StringIO();statuses=[]
        env={'REQUEST_METHOD':method,'PATH_INFO':path,'QUERY_STRING':query,
             'HTTP_X_POS_PUBLIC_SCREENING_NEGATIVE_KEY':key,'HTTP_X_REQUEST_ID':'fixture-id-123',
             'CONTENT_LENGTH':str(len(raw)),'CONTENT_TYPE':'application/json','wsgi.input':io.BytesIO(raw)}
        result=b''.join(private_application(resource,KEY,stream,allow_post=allow_post)(env,lambda status,_headers:statuses.append(status)))
        return statuses[0],json.loads(result),stream.getvalue()

    def test_bad_credentials_and_request_scope_never_access_resource(self):
        class NoAccess:
            def __getattr__(self,_name):raise AssertionError('Unauthorized resource call')
        for key in ('', 'wrong', 'é'*40, 'x'*4097):
            status,body,log=self.call(NoAccess(),key=key)
            self.assertEqual(status,'401 Unauthorized');self.assertEqual(body['code'],'SCREENING_NEGATIVE_UNAUTHORIZED')
            self.assertNotIn(key if key else 'missing-private-key',log)
        for change in ({'body':{'operationId':OP,'noOrder':True}}, {'body':{'operationId':'../private'}},
                       {'query':'token=private-value'}, {'path':PREFIX+'/extra'}, {'body':{'operationId':'x'*200}}):
            self.assertEqual(self.call(NoAccess(),**change)[0],'409 Conflict')

    def test_get_absence_is_only_missing_receipt_and_disabled_post_cannot_mint_one(self):
        class ReadOnly:
            def __init__(self):self.reads=[]
            def read(self,operation):self.reads.append(operation);return None
            def post(self,_operation):raise AssertionError('GET dispatched work')
        resource=ReadOnly()
        status,body,_log=self.call(resource,method='GET',path=PREFIX+'/'+OP,allow_post=False)
        self.assertEqual(status,'404 Not Found');self.assertEqual(body,{'code':'SCREENING_NEGATIVE_NOT_FOUND'})
        self.assertEqual(resource.reads,[OP])
        self.assertEqual(self.call(resource,allow_post=False)[0],'409 Conflict')

    def test_unknown_exception_has_static_response_and_identifier_only_logs(self):
        canary='private-cookie-phone-credential-body-canary'
        class Broken:
            def post(self,_operation):raise RuntimeError(canary)
        status,body,log=self.call(Broken())
        self.assertEqual(status,'409 Conflict');self.assertEqual(body,{'code':'SCREENING_NEGATIVE_REVIEW'})
        self.assertNotIn(canary,log+json.dumps(body));self.assertNotIn(KEY,log)
        self.assertEqual(json.loads(log),{'module':'public-screening','resource':'no-order-receipts',
            'eventId':'public-screening.no-order-receipts.review','requestId':'fixture-id-123','userId':None})

    def test_options_and_constructor_default_off_are_io_free(self):
        self.assertIsNone(options({},'proof-key'))
        self.assertFalse(options({'POS_PUBLIC_SCREENING_NEGATIVE_KEY':KEY},'proof-key')['allowPost'])
        self.assertTrue(options({'POS_PUBLIC_SCREENING_NEGATIVE_KEY':KEY,'POS_PUBLIC_SCREENING_NEGATIVE_CONTRACT':SELECTOR},'proof-key')['allowPost'])
        with self.assertRaises(ScreeningWriterError):options({'POS_PUBLIC_SCREENING_NEGATIVE_KEY':KEY},KEY)
        def sessions():raise AssertionError('Constructor opened SQL')
        NegativeResource(sessions,'proof-key',lambda:0)


if __name__=='__main__':unittest.main()
