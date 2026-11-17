"""Synthetic Node -> private receiver -> literal eligibility evidence.

No database/network is available. Keys and payloads enter only on stdin;
output contains decisions, static codes and counters, never supplied values.
"""
import ast
from datetime import datetime,timedelta
from enum import IntEnum
import hashlib
import io
import json
import os
from pathlib import Path
import sys
from threading import Barrier,Thread

HERE=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(HERE/'compatibility/upstream/legacy-order-imports'))
from membership_handoff import CURRENT_HISTORY
from membership_profile import CONTEXT,compile_free_membership
from protocol import ImportReview
from receiver import Receiver
from http_app import private_application


def main():
    value=json.load(sys.stdin)
    root=Path(sys.argv[1]).resolve()
    os.environ.update(POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT='pos-legacy-import-membership-v1',
                      POS_MEMBERSHIP_FRESH_READER_CONTRACT='pos-membership-fresh-reader-v1',
                      POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY=value['historyKey'],
                      POS_MEMBERSHIP_PRODUCT_IDS=json.dumps(value['memberProductIds']))
    calls={'native':0,'historical':0}
    def forbidden_session():
        calls['native']+=1
        raise AssertionError('Native SQL is unavailable in this boundary oracle')
    class NoHistoricalIO:
        def execute(self,*_args,**_kwargs):
            calls['historical']+=1
            raise AssertionError('Historical SQL fallback is forbidden')
    raw=(root/'constants/StatusEnum.py').read_bytes()
    if hashlib.sha256(raw).hexdigest()!='42cb694ff628c61ef8a5ec169a4b319a8c1491ef2a698f93665348e6b22d0a06':
        # Other source tests permit a clean sibling to advance. The archive
        # root remains the preferred input; never execute a changed constant.
        import subprocess
        raw=subprocess.check_output(['git','-C',str(root),'show',
            '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5:constants/StatusEnum.py'],
            stderr=subprocess.DEVNULL,timeout=5)
        if hashlib.sha256(raw).hexdigest()!='42cb694ff628c61ef8a5ec169a4b319a8c1491ef2a698f93665348e6b22d0a06':
            raise AssertionError('Immutable source constant unavailable')
    payment=next(node for node in ast.parse(raw.decode()).body if isinstance(node,ast.ClassDef) and node.name=='PaymentMethod')
    namespace={'_IntEnum':IntEnum,'timedelta':timedelta,'MEMBERSHIP_PROD_ID':value['memberProductIds']}
    exec(compile(ast.Module(body=[payment],type_ignores=[]),'<pinned-PaymentMethod>','exec'),namespace)
    class LiveClock:
        @staticmethod
        def now():
            # Deliberately different from the retained preparation second.
            return datetime.fromisoformat(value['liveSourceTime'])
    namespace['datetime']=LiveClock
    criteria=compile_free_membership(root,namespace)
    barrier=Barrier(2) if value.get('concurrent') else None
    class EvaluationReceiver(Receiver):
        def _order(self,operation_id,body,plan,cap):
            reader=CURRENT_HISTORY.get()
            if barrier:barrier.wait(timeout=5)
            state={'capability':cap,'user':{'user_id':int(cap['authority']['customerId'])},
                   'historyReader':reader,'eligibility':'not-added'}
            token=CONTEXT.set(state)
            try:
                instance=object.__new__(criteria)
                instance.cart_value=value.get('cartValue',1999)
                instance.number_of_items=value.get('numberOfItems',1)
                instance.user=state['user']
                instance.session=NoHistoricalIO()
                eligible=instance.check_criteria()
                return {'eligible':eligible,'eligibility':state['eligibility'],
                        'usedHistory':reader is not None,
                        'clockRetained':None if reader is None else reader.execution_clock(state).strftime('%Y-%m-%d %H:%M:%S')==reader.scope['asOf']}
            finally:
                CONTEXT.reset(token)
    receiver=EvaluationReceiver(forbidden_session,None,value['authKey'],value['proofKey'],
                               clock=lambda:value['now'],zone=value.get('sourceTimeZone','Asia/Kolkata'))
    def evaluate(body):
        try:
            result=receiver.order(body['capability']['operationId'],body)
            return {'ok':True,**result}
        except ImportReview as error:
            return {'ok':False,'code':error.code}
    if value.get('http'):
        body=value['body'];raw=json.dumps(body,separators=(',',':')).encode()
        headers=[];logs=io.StringIO()
        application=private_application(receiver,value['authKey'],logs)
        response=application({'PATH_INFO':'/internal/pos/legacy-order-imports/'+body['capability']['operationId']+'/order',
            'REQUEST_METHOD':'POST','QUERY_STRING':'','CONTENT_TYPE':'application/json',
            'CONTENT_LENGTH':str(len(raw)),'HTTP_X_POS_LEGACY_IMPORT_KEY':value['authKey'],
            'HTTP_X_POS_OPERATOR_ID':body['capability']['scope']['actorId'],'wsgi.input':io.BytesIO(raw)},
            lambda status,_headers:headers.append(status))
        result={'httpStatus':headers[0],'response':json.loads(b''.join(response)),
                'loggedFields':sorted(json.loads(logs.getvalue()).keys()),'bodyBytes':len(raw)}
    elif value.get('concurrent'):
        results=[None,None]
        def run(index):results[index]=evaluate(value['bodies'][index])
        threads=[Thread(target=run,args=(index,)) for index in range(2)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=10)
        if any(thread.is_alive() for thread in threads):raise AssertionError('Concurrent scope did not finish')
        result={'results':results}
    else:
        result=evaluate(value['body'])
    print(json.dumps({**result,'nativeSessionOpens':calls['native'],'historicalSqlCalls':calls['historical'],
                      'scopeRestored':CURRENT_HISTORY.get() is None and CONTEXT.get() is None},separators=(',',':')))


if __name__=='__main__':
    try:main()
    except Exception:
        print('{"error":"MEMBERSHIP_HANDOFF_ORACLE_FAILED"}')
        sys.exit(1)
