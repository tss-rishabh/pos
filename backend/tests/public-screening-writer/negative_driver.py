"""Controlled WSGI/native no-order resource. Synthetic local rows only."""
import io
import json
import sys
import time
from pathlib import Path
from sqlalchemy import create_engine,event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

ROOT=Path(__file__).resolve().parents[2]
for name in ('legacy-order-imports','offline-cash-pricing','public-screening-writer'):
    sys.path.insert(0,str(ROOT/'compatibility/upstream'/name))
from negative import NegativeResource
from negative_resource import private_application,PREFIX


def run(value):
    url=make_url(value['url'])
    if (url.host not in ('localhost','127.0.0.1') or not url.database.startswith('pos_rewrite_import_runtime_') or
            len(url.database)!=len('pos_rewrite_import_runtime_')+12 or url.query):raise RuntimeError('Isolated fixture required')
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
    if value.get('gate'):
        gate=Path(value['gate']).resolve()
        if gate.name!='release' or not gate.parent.name.startswith('pos-public-screening-'):raise RuntimeError('Invalid gate')
        def barrier(_connection,_cursor,statement,_parameters,_context,_many):
            if statement.startswith('INSERT INTO pos_rewrite_public_screening_negatives'):
                print('PUBLIC_BODY_READY',flush=True)
                deadline=time.monotonic()+10
                while not gate.is_file():
                    if time.monotonic()>deadline:raise RuntimeError('Fixture gate timeout')
                    time.sleep(.01)
        event.listen(engine,'before_cursor_execute',barrier)
    sessions=sessionmaker(bind=engine,expire_on_commit=False)
    log=io.StringIO()
    app=private_application(NegativeResource(sessions,value['proofKey'],lambda:value['now']),
                            value['key'],log,allow_post=value.get('allowPost',True))
    results=[]
    try:
        for request in value.get('requests',[{'method':'POST'}]):
            method=request['method'];body=json.dumps(request.get('body',{'operationId':value['operationId']})).encode() if method=='POST' else b''
            env={'PATH_INFO':request.get('path',PREFIX if method=='POST' else PREFIX+'/'+value['operationId']),
                 'REQUEST_METHOD':method,'QUERY_STRING':request.get('query',''),
                 'HTTP_X_POS_PUBLIC_SCREENING_NEGATIVE_KEY':request.get('key',value['key']),
                 'HTTP_X_REQUEST_ID':'isolated-negative-request-'.ljust(128,'x'),
                 'CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(body)),'wsgi.input':io.BytesIO(body)}
            statuses=[]
            raw=b''.join(app(env,lambda status,_headers:statuses.append(status)))
            results.append({'status':statuses[0],'body':json.loads(raw)})
        return {'responses':results,'events':[json.loads(row) for row in log.getvalue().splitlines()]}
    finally:engine.dispose()


if __name__=='__main__':
    try:print(json.dumps(run(json.loads(sys.stdin.read())),separators=(',',':')))
    except Exception:
        print('{"code":"PUBLIC_SCREENING_NEGATIVE_FIXTURE_FAILED"}')
        sys.exit(1)
