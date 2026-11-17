"""Disposable localhost-only actual source preview/rollback receiver fixture."""
import io
import json
import os
from pathlib import Path
import re
import sys
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo
from sqlalchemy import create_engine,event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

HERE=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(HERE/'compatibility/upstream/legacy-order-imports'))
from receiver import Receiver
from protocol import ImportReview,PREPARATION_CONTRACT
from http_app import private_application
from source_fixture import pipeline,pinned_source
from membership_handoff import CURRENT_HISTORY
from membership_profile import CONTEXT
from effects import CAPTURE
from transaction import CURRENT
from cart_preparation import BUILDING,PREVIEW_ONLY


def main():
    value=json.load(sys.stdin)
    url=make_url(value['url'])
    if (url.host not in ('localhost','127.0.0.1') or url.query
            or not re.fullmatch(r'pos_rewrite_import_runtime_[a-f0-9]{12}',url.database or '')):
        raise ValueError()
    os.environ.update(POS_LEGACY_IMPORT_PREPARATION_CONTRACT=value.get('contract',PREPARATION_CONTRACT),
        POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT='pos-legacy-import-membership-v1',
        POS_MEMBERSHIP_FRESH_READER_CONTRACT='pos-membership-fresh-reader-v1',
        POS_MEMBERSHIP_PRODUCT_IDS='["10","12"]',POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY=value['historyKey'])
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
    counts={'commits':0,'rollbacks':0};trace=[]
    event.listen(engine,'commit',lambda _connection:counts.__setitem__('commits',counts['commits']+1))
    event.listen(engine,'rollback',lambda _connection:counts.__setitem__('rollbacks',counts['rollbacks']+1))
    # Only the pinned source's hard-coded tss.products qualifier changes inside
    # this disposable schema. Production source SQL is not rewritten.
    def schema(_connection,_cursor,statement,parameters,_context,_many):
        return statement.replace('FROM tss.products','FROM products'),parameters
    event.listen(engine,'before_cursor_execute',schema,retval=True)
    try:
        with pinned_source(value['sourceRoot']) as source:
            instance=pipeline(source,value['body']['plan'],trace,value.get('mode','normal'))
            instance.source_clock=SimpleNamespace(now=lambda:datetime.fromtimestamp(value['now']/1000,ZoneInfo('Asia/Kolkata')).replace(tzinfo=None))
            service=Receiver(sessionmaker(bind=engine,expire_on_commit=False),instance,
                value['authKey'],value['proofKey'],clock=lambda:value['now'])
            logs=io.StringIO();status=[];body=json.dumps(value['body']).encode()
            application=private_application(service,value['authKey'],logs)
            result=application({'PATH_INFO':'/internal/pos/legacy-order-imports/'+value['body']['capability']['operationId']+'/preparation',
                'REQUEST_METHOD':'POST','QUERY_STRING':'','CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(body)),
                'HTTP_X_POS_LEGACY_IMPORT_KEY':value.get('headerKey',value['authKey']),
                'HTTP_X_POS_OPERATOR_ID':value['body']['capability']['scope']['actorId'],'wsgi.input':io.BytesIO(body)},
                lambda status_value,_headers:status.append(status_value))
            response=json.loads(b''.join(result))
            return {'status':status[0],'response':response,'trace':trace,**counts,
                'loggedFields':sorted(json.loads(logs.getvalue()).keys()),
                'scopeRestored':all(context.get() is None for context in (CURRENT_HISTORY,CONTEXT,CAPTURE,CURRENT,BUILDING)) and PREVIEW_ONLY.get() is False}
    finally:engine.dispose()


if __name__=='__main__':
    try:print(json.dumps(main(),separators=(',',':')))
    except BaseException:
        print('{"error":"SOURCE_PREVIEW_FIXTURE_FAILED"}')
        sys.exit(1)
