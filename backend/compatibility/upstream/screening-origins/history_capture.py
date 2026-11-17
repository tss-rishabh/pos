"""Independent background qualification ONLY, never an admission fallback.

Bounded native rows remain in memory. The private output contains only counts,
hashes and origin metadata; it contains no token, contact or source row dump.
"""
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from origin_contracts import canonical,digest,identifier,fail
from origin_history import head
from native import rows


def capture(session,customer_id,key,clock=lambda:int(time.time()*1000)):
    customer=identifier(customer_id);started=clock()
    witness=head(session,customer)
    values=rows(session,'SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(id AS CHAR) AS id,order_status AS status,flag_id AS flag FROM orders WHERE user_id=:customer ORDER BY id LIMIT 5001',{'customer':customer},5002)
    if len(values)>5000:fail('SCREENING_ORIGIN_HISTORY_COHORT_TOO_LARGE')
    ordered=[{'flag':row['flag'],'id':row['id'],'status':row['status']} for row in values]
    if len({row['id'] for row in ordered})!=len(ordered):fail()
    value={'contract':'pos-screening-origin-history-capture-v1','customerId':customer,'witness':witness,
           'orderRows':str(len(ordered)),'uniqueOrders':str(len(ordered)),
           'welcomeCount':str(sum(row['status'] is not None and row['status']!=4 for row in ordered)),
           'appCashbackCount':str(sum(row['status']==3 and row['flag']==18 for row in ordered)),
           'webCashbackCount':str(sum(row['status']==3 and row['flag'] is not None and row['flag']!=18 for row in ordered)),
           'rowsHash':hashlib.sha256(canonical(ordered).encode()).hexdigest(),'capturedAt':started,'finishedAt':clock()}
    return {**value,'signature':digest(key,'history-capture',value)}


def main():
    if len(sys.argv)!=2:fail('SCREENING_ORIGIN_HISTORY_CONFIGURATION')
    if os.environ.get('POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_CONTRACT')!='pos-screening-origin-history-capture-v1':fail('SCREENING_ORIGIN_HISTORY_CONFIGURATION')
    source_url=os.environ.get('POS_SCREENING_ORIGIN_HISTORY_READONLY_SOURCE_URL','')
    key=os.environ.get('POS_SCREENING_ORIGIN_HISTORY_CAPTURE_KEY','')
    directory=Path(os.environ.get('POS_SCREENING_ORIGIN_HISTORY_PRIVATE_DIRECTORY','')).resolve()
    if not source_url or not directory.is_dir():fail('SCREENING_ORIGIN_HISTORY_CONFIGURATION')
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    engine=create_engine(source_url,echo=False,pool_pre_ping=True)
    try:
        with engine.connect().execution_options(isolation_level='REPEATABLE READ') as connection:
            connection.exec_driver_sql('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
            session=Session(bind=connection,expire_on_commit=False)
            try:value=capture(session,sys.argv[1],key)
            finally:session.close();connection.rollback()
        descriptor,temp=tempfile.mkstemp(prefix='.origin-history-',dir=directory)
        os.fchmod(descriptor,0o600)
        with os.fdopen(descriptor,'w') as output:output.write(canonical(value)+'\n')
        final=directory/('origin-history-'+value['signature']+'.json')
        os.replace(temp,final)
        print('screening-origin history metadata captured')
    finally:engine.dispose()


if __name__=='__main__':
    try:main()
    except BaseException:
        # Never stringify SDK/DB exceptions, DSNs, headers, causes or bodies.
        print('screening-origin history capture failed',file=sys.stderr);sys.exit(1)
