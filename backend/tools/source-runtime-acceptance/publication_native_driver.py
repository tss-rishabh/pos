"""Actual private WSGI publication resource against disposable native receipts."""
import io
import json
import sys
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports'))
sys.path.insert(0,str(ROOT/'compatibility/upstream/public-screening-writer'))
from publication_resource import PublicationResource,private_application,PREFIX,HEADER
from fixture_broker import FixtureBroker


def run(value):
    url=make_url(value['url'])
    if (url.host not in ('localhost','127.0.0.1') or not url.database.startswith('pos_rewrite_import_runtime_') or
            len(url.database)!=len('pos_rewrite_import_runtime_')+12 or url.query):raise RuntimeError('Isolated localhost fixture required')
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
    sessions=sessionmaker(bind=engine,expire_on_commit=False)
    broker=FixtureBroker();logs=io.StringIO();key=value.get('publicationKey','isolated-native-publication-caller-key-'*2)
    if value.get('mode')=='unknown':
        def accepted_without_ack(_name):
            broker.accepted.append({'id':'accepted-original','task':'fixture'})
            raise RuntimeError('Fixture ACK lost')
        broker.accept=accepted_without_ack
    resource=PublicationResource(sessions,value['proofKey'],broker,lambda:value['now'])
    application=private_application(resource,key,logs,allow_post=not value.get('recoveryOnly',False))
    responses=[]
    try:
        for method in value['methods']:
            raw=json.dumps({'operationId':value['operationId']},separators=(',',':')).encode() if method=='POST' else b''
            status=[];path=PREFIX if method=='POST' else PREFIX+'/'+value['operationId']
            body=b''.join(application({'PATH_INFO':path,'REQUEST_METHOD':method,'QUERY_STRING':'',HEADER:'wrong' if value.get('badKey') else key,
                'CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(raw)),'wsgi.input':io.BytesIO(raw),'HTTP_X_REQUEST_ID':'fixture-request'},
                lambda code,headers:status.append(code)))
            responses.append({'status':status[0],'body':json.loads(body)})
        return {'responses':responses,'queueCalls':len(broker.accepted),'events':[json.loads(line) for line in logs.getvalue().splitlines()]}
    finally:engine.dispose()


if __name__=='__main__':
    try:print(json.dumps(run(json.loads(sys.stdin.read())),separators=(',',':')))
    except Exception:
        print('{"code":"PUBLICATION_NATIVE_FIXTURE_FAILED"}')
        sys.exit(1)
