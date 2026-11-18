"""Closed source WSGI and disabled worker entry boundaries; no source startup."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from uuid import UUID

ROOT=Path(__file__).resolve().parents[2]
for folder in ('legacy-order-imports','offline-cash-pricing','public-screening-writer','screening-origins','legacy-order-imports/benefit-profile'):
    sys.path.insert(0,str(ROOT/'compatibility/upstream'/folder))
from origin_coupon_controls import private_application,PREFIX

KEY='isolated-current-coupon-background-controls-'*3


class SourceResources(unittest.TestCase):
    def test_actual_coupon_wsgi_mount_keeps_original_fallback_and_closed_events(self):
        calls=[];events=io.StringIO();statuses=[]
        class Resource:
            coupons=type('Keys',(),{'key':'different-origin-source-key-'*3,'history_key':'different-history-key-'*3})()
            def read(self,identity):calls.append(identity);return {'data':{'couponId':identity},'proofHash':'a'*64}
        fallback=lambda _environment,_start:[b'original-source-fallback']
        app=private_application(Resource(),KEY,events,fallback)
        self.assertEqual(app({'PATH_INFO':'/api/v2/cart'},lambda *_a:None),[b'original-source-fallback'])
        request={'PATH_INFO':PREFIX+'7','REQUEST_METHOD':'GET','QUERY_STRING':'','CONTENT_LENGTH':'0','HTTP_X_POS_ORIGIN_COUPON_CONTROLS_KEY':KEY,'HTTP_X_REQUEST_ID':'11111111-1111-4111-8111-111111111111'}
        body=b''.join(app(request,lambda status,headers:statuses.append((status,dict(headers)))))
        self.assertEqual(statuses[0][0],'200 OK');self.assertEqual(json.loads(body)['data']['couponId'],'7')
        self.assertEqual(statuses[0][1]['Cache-Control'],'private, no-store');self.assertEqual(calls,['7'])
        event=json.loads(events.getvalue())
        self.assertEqual(set(event),{'timestamp','module','resource','eventId','eventInstanceId','requestId','userId'})
        self.assertEqual(event['eventId'],'screening-origins.coupon-controls.read')
        self.assertEqual(str(UUID(event['eventInstanceId'])),event['eventInstanceId']);self.assertIsNone(event['userId'])
        self.assertNotIn(KEY,events.getvalue());self.assertNotIn('proofHash',events.getvalue())
    def test_coupon_wsgi_refuses_values_before_current_control_access(self):
        class Never:
            coupons=type('Keys',(),{'key':'unrelated-key-'*3,'history_key':'unrelated-history-'*3})()
            def read(self,_identity):raise AssertionError('Unauthorized current control access')
        for overrides in ({'HTTP_X_POS_ORIGIN_COUPON_CONTROLS_KEY':'private-cookie-secret-canary'},
                {'REQUEST_METHOD':'POST'},{'QUERY_STRING':'email=private-contact-canary'},
                {'PATH_INFO':PREFIX+'7/extra'},{'CONTENT_LENGTH':'5'}):
            events=io.StringIO();statuses=[]
            request={'PATH_INFO':PREFIX+'7','REQUEST_METHOD':'GET','QUERY_STRING':'','CONTENT_LENGTH':'0','HTTP_X_POS_ORIGIN_COUPON_CONTROLS_KEY':KEY,**overrides}
            body=b''.join(private_application(Never(),KEY,events)(request,lambda status,_headers:statuses.append(status)))
            self.assertTrue(statuses[0].startswith(('400','401')))
            self.assertNotIn('canary',body.decode()+events.getvalue())
            event=json.loads(events.getvalue());self.assertEqual(str(UUID(event['requestId'])),event['requestId'])
            self.assertEqual(event['eventId'],'screening-origins.coupon-controls.review')
    def test_disabled_supervised_source_worker_does_not_import_the_source_or_writer(self):
        worker=ROOT/'compatibility/upstream/screening-origins/source_worker.py'
        environment={key:value for key,value in os.environ.items() if not key.startswith('POS_SCREENING_ORIGIN_SOURCE_WORKER_')}
        environment.update(POS_SCREENING_ORIGIN_SOURCE_WORKER_ENABLED='false',
            POS_SCREENING_ORIGIN_SOURCE_WORKER_SOURCE_ROOT='/missing-private-cookie-source-canary',
            POS_LEGACY_IMPORT_MYSQL_WRITER_URL='mysql://private-contact-canary:private-password-canary@127.0.0.1:1/private')
        result=subprocess.run([sys.executable,'-B',str(worker),'--once'],env=environment,capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0);self.assertEqual(result.stderr,'')
        self.assertNotIn('canary',result.stdout)
        event=json.loads(result.stdout)
        self.assertEqual(set(event),{'timestamp','module','resource','eventId','eventInstanceId','requestId','userId'})
        self.assertTrue(event['eventId'].endswith('.disabled'));self.assertIsNone(event['userId'])
        self.assertEqual(str(UUID(event['requestId'])),event['requestId'])


if __name__=='__main__':unittest.main()
