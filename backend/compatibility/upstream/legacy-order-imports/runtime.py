"""Private WSGI factory. Original source service/runtime dependencies required.

Run in a separate process behind a private mTLS ingress; never mount in the
public application. Source debug/print/access/error channels are closed here.
"""
import logging
import os
import re
import sys
from pathlib import Path

from protocol import ImportReview,SOURCE_CONTRACT


def _create_application():
    from sqlalchemy import create_engine,event,text
    from sqlalchemy.orm import Session,sessionmaker
    from sqlalchemy.engine import make_url
    from transaction import normalize_source_sentinels,guard_private_statement,guard_private_commit
    from source_runtime import SourceRuntime
    from receiver import Receiver
    from model_compat import CONTRACT as model_contract,verify_physical_columns
    if os.environ.get('POS_LEGACY_IMPORT_SOURCE_CONTRACT')!=SOURCE_CONTRACT:
        raise ImportReview('ORDER_IMPORT_SOURCE_UNAVAILABLE')
    if os.environ.get('POS_LEGACY_IMPORT_MODEL_CONTRACT')!=model_contract:
        raise ImportReview('ORDER_IMPORT_SOURCE_MODEL_UNQUALIFIED')
    key=os.environ.get('POS_LEGACY_IMPORT_KEY','')
    proof=os.environ.get('POS_LEGACY_IMPORT_PROOF_KEY','')
    if not re.fullmatch(r'[!-~]{32,4096}',key) or not re.fullmatch(r'[!-~]{32,4096}',proof) or key==proof:
        raise ImportReview('ORDER_IMPORT_KEY_UNAVAILABLE')
    url=make_url(os.environ['POS_LEGACY_IMPORT_MYSQL_WRITER_URL'])
    ca=Path(os.environ['POS_LEGACY_IMPORT_MYSQL_CA_FILE']).resolve(strict=True)
    if url.drivername!='mysql+pymysql' or not all((url.host,url.username,url.password,url.database)) or url.query:
        raise ImportReview('ORDER_IMPORT_WRITER_UNAVAILABLE')
    engine=create_engine(url,echo=False,hide_parameters=True,pool_size=4,max_overflow=0,pool_timeout=5,
        pool_pre_ping=True,connect_args={'ssl':{'ca':str(ca),'check_hostname':True},
                                       'connect_timeout':5,'read_timeout':25,'write_timeout':25})
    # This process is dedicated to the private source adapter. Suppress legacy
    # module loggers and print statements before any source import occurs.
    emit_stream=sys.stdout
    logging.disable(logging.CRITICAL)
    sys.stdout=open(os.devnull,'w')
    sys.stderr=open(os.devnull,'w')
    pipeline=SourceRuntime(os.environ['POS_LEGACY_IMPORT_SOURCE_ROOT'],os.environ['POS_LEGACY_IMPORT_RUNTIME_ROOT'])
    event.listen(Session,'before_flush',normalize_source_sentinels)
    event.listen(Session,'before_commit',guard_private_commit)
    event.listen(engine,'before_cursor_execute',guard_private_statement)
    factory=sessionmaker(bind=engine,autoflush=True,expire_on_commit=False)
    with engine.connect() as connection:
        verify_physical_columns(connection)
        values=connection.execute(text("SELECT COLUMN_NAME,IS_NULLABLE,DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME IN ('ship_date','ret_ex_request_date')")).mappings().all()
        if len(values)!=2 or any(row['IS_NULLABLE']!='YES' or row['DATA_TYPE']!='datetime' for row in values):
            raise ImportReview('ORDER_IMPORT_ORDER_SCHEMA_UNVERIFIED')
    if pipeline.membership:
        from membership_cache import register_task
        register_task(pipeline.tasks,factory,proof)
    receiver=Receiver(factory,pipeline,key,proof,zone=os.environ.get('BUSINESS_TIMEZONE','Asia/Kolkata'))
    from http_app import private_application
    return private_application(receiver,key,emit_stream)


def create_application():
    try:
        return _create_application()
    except Exception:
        raise ImportReview('ORDER_IMPORT_SOURCE_UNAVAILABLE') from None
