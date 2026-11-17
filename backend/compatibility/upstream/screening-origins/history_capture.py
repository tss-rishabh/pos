"""Independent background snapshot/export only; never request-time fallback.

Private stdin/stdout IPC is bounded and carries no plaintext contact. Nothing
is written to a warehouse here. A readonly account connects to the explicitly
qualified writer origin; replica identity is never rewritten to fit a witness.
"""
import hashlib
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
sys.path.insert(0,str(HERE.parent/'legacy-order-imports'))
from origin_contracts import canonical,digest,identifier,fail
from origin_history import head
from native import one,rows

PROJECTION={
 'source':'2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
 'welcome':'COUNT(id) WHERE user_id=:customer AND NOT order_status=4',
 'app':'COUNT(id) WHERE user_id=:customer AND order_status=3 AND flag_id=18',
 'web':'COUNT(id) WHERE user_id=:customer AND order_status=3 AND flag_id!=18',
 'bounds':'all rows, including already-present future timestamps; SQL NULL predicates',
 'commitment':'sha256 UTF8 JSON array, numeric id order, keys flag,id,status; nullable signed decimal strings',
}
PROJECTION_HASH=hashlib.sha256(json.dumps(PROJECTION,separators=(',',':')).encode()).hexdigest()


def capture(session,customer_id,key,clock=lambda:int(time.time()*1000),expected=None,started=None):
    customer=identifier(customer_id);started=clock() if started is None else started
    witness=head(session,customer)
    if expected is not None and witness!=expected:fail('SCREENING_ORIGIN_HISTORY_CHANGED')
    one(session,'SELECT id FROM users WHERE id=:id',{'id':customer})
    values=rows(session,'SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(id AS CHAR) AS id,CAST(order_status AS CHAR) AS status,CAST(flag_id AS CHAR) AS flag FROM orders WHERE user_id=:customer ORDER BY id LIMIT 50001',{'customer':customer},50002)
    if len(values)>50000:fail('SCREENING_ORIGIN_HISTORY_COHORT_TOO_LARGE')
    ordered=[{'flag':None if row['flag'] is None else str(row['flag']),'id':identifier(str(row['id'])),'status':None if row['status'] is None else str(row['status'])} for row in values]
    if len({row['id'] for row in ordered})!=len(ordered):fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    if len(canonical(ordered).encode())>8000000:fail('SCREENING_ORIGIN_HISTORY_COHORT_TOO_LARGE')
    value={'contract':'pos-screening-origin-history-capture-v1','customerId':customer,'witness':witness,'projectionHash':PROJECTION_HASH,
           'orderRows':str(len(ordered)),'uniqueOrders':str(len(ordered)),
           'welcomeCount':str(sum(row['status'] is not None and row['status']!='4' for row in ordered)),
           'appCashbackCount':str(sum(row['status']=='3' and row['flag']=='18' for row in ordered)),
           'webCashbackCount':str(sum(row['status']=='3' and row['flag'] is not None and row['flag']!='18' for row in ordered)),
           'rowsHash':hashlib.sha256(canonical(ordered).encode()).hexdigest(),'capturedAt':started,'finishedAt':clock()}
    return {'capture':{**value,'signature':digest(key,'history-capture',value)},'rows':ordered}


def main():
    if sys.argv[1:]!=['--stdio']:fail('SCREENING_ORIGIN_HISTORY_CONFIGURATION')
    request=sys.stdin.buffer.read(64001)
    if not request or len(request)>64000:fail('SCREENING_ORIGIN_HISTORY_CONFIGURATION')
    data=json.loads(request)
    if set(data)!={'customerId','witness','captureKey','sourceUrl','caFile','allowLocalPlaintext'}:fail('SCREENING_ORIGIN_HISTORY_CONFIGURATION')
    parsed=urlsplit(data['sourceUrl'])
    if (parsed.scheme not in ('mysql','mysql+pymysql') or not parsed.hostname or not parsed.path[1:] or parsed.query or parsed.fragment
            or not isinstance(data['captureKey'],str) or not 32<=len(data['captureKey'])<=4096):fail('SCREENING_ORIGIN_HISTORY_CONFIGURATION')
    local=parsed.hostname in ('localhost','127.0.0.1','::1')
    connect={'connect_timeout':6,'read_timeout':6,'write_timeout':6}
    if data['allowLocalPlaintext'] is True and local:pass
    else:
        ca=Path(data['caFile']);
        if not ca.is_file() or ca.stat().st_size>1000000:fail('SCREENING_ORIGIN_HISTORY_CONFIGURATION')
        connect['ssl']={'ca':str(ca),'check_hostname':True}
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    url=data['sourceUrl'].replace('mysql://','mysql+pymysql://',1)
    engine=create_engine(url,echo=False,pool_pre_ping=False,connect_args=connect)
    try:
        # The conservative completeness point precedes opening this snapshot.
        # No later-commit coverage or event-time upper bound is asserted.
        started=int(time.time()*1000)
        with engine.connect().execution_options(isolation_level='REPEATABLE READ') as connection:
            connection.exec_driver_sql('SET SESSION MAX_EXECUTION_TIME=5000')
            connection.exec_driver_sql('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
            session=Session(bind=connection,expire_on_commit=False)
            try:value=capture(session,data['customerId'],data['captureKey'],expected=data['witness'],started=started)
            finally:session.close();connection.rollback()
        encoded=canonical(value)
        if len(encoded.encode())>9000000:fail('SCREENING_ORIGIN_HISTORY_COHORT_TOO_LARGE')
        sys.stdout.write(encoded)
    finally:engine.dispose()


if __name__=='__main__':
    try:main()
    except BaseException:
        # Do not print exception text, credentials, source IDs, SQL or stacks.
        sys.stderr.write('origin-history capture unavailable\n');sys.exit(1)
