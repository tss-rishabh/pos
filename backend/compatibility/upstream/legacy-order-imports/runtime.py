"""Private WSGI factory. Original source service/runtime dependencies required.

Run in a separate process behind a private mTLS ingress; never mount in the
public application. Source debug/print/access/error channels are closed here.
"""
import logging
import json
import os
import re
import sys
from pathlib import Path
from datetime import datetime, timezone
from uuid import UUID, uuid4

from protocol import ImportReview,SOURCE_CONTRACT


def _public_cache_emitter(stream):
    """Allow only fixed task events and opaque operator/request identifiers."""
    def emit(value):
        if not isinstance(value,dict): return
        event_id=value.get('eventId')
        if event_id not in ('public-screening.membership-cache.completed',
                            'public-screening.membership-cache.review'): return
        request=value.get('requestId')
        try:
            if str(UUID(request))!=request: raise ValueError()
        except (TypeError,ValueError,AttributeError): request=str(uuid4())
        actor=value.get('userId')
        if not isinstance(actor,str) or not re.fullmatch(r'[1-9][0-9]{0,18}',actor): actor=None
        event={'module':'public-screening','resource':'membership-cache','eventId':event_id,
               'eventInstanceId':str(uuid4()),'timestamp':datetime.now(timezone.utc).isoformat(),
               'requestId':request,'userId':actor}
        try:
            stream.write(json.dumps(event,separators=(',',':'))+'\n')
            stream.flush()
        except Exception: pass
    return emit


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
    # This optional resource has a separate confidential caller key. Validate
    # selection before source imports or any writer connection is opened.
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'public-screening-writer'))
    from publication_resource import options as publication_options
    public_options=publication_options(os.environ,proof,(key,os.environ.get('TSS_POS_CUSTOMER_CONTEXT_KEY','')))
    from negative_resource import options as negative_options
    no_order_options=negative_options(os.environ,proof,(key,os.environ.get('TSS_POS_CUSTOMER_CONTEXT_KEY',''),
        os.environ.get('POS_PUBLIC_SCREENING_PUBLICATION_KEY','')))
    sys.path.insert(0,str(Path(__file__).resolve().parent/'benefit-profile'))
    from coupon_generation_resource import options as coupon_control_options
    control_options=coupon_control_options(os.environ,proof,(
        key,os.environ.get('TSS_POS_CUSTOMER_CONTEXT_KEY',''),
        os.environ.get('POS_PUBLIC_SCREENING_PUBLICATION_KEY',''),
        os.environ.get('POS_PUBLIC_SCREENING_NEGATIVE_KEY',''),
        os.environ.get('POS_LEGACY_IMPORT_FINANCIAL_PROOF_KEY',''),
        os.environ.get('POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY',''),
        os.environ.get('POS_MEMBERSHIP_PROOF_KEY',''),
        os.environ.get('POS_LEGACY_IMPORT_COUPON_HISTORY_KEY',''),
        os.environ.get('POS_LEGACY_IMPORT_COUPON_GUARD_KEY','')))
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
    sys.path.insert(0,str(Path(__file__).resolve().parent/'benefit-profile'))
    from benefit_history_heads import NativeCouponHistoryHeads
    pipeline=SourceRuntime(os.environ['POS_LEGACY_IMPORT_SOURCE_ROOT'],os.environ['POS_LEGACY_IMPORT_RUNTIME_ROOT'],
                           benefit_heads=NativeCouponHistoryHeads(proof))
    event.listen(Session,'before_flush',normalize_source_sentinels)
    event.listen(engine,'commit',guard_private_commit)
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
    if os.environ.get('POS_PUBLIC_SCREENING_MEMBERSHIP_CACHE_QUEUE',''):
        from public_benefit_cache import register_task as register_public_benefit_cache
        register_public_benefit_cache(pipeline.tasks,factory,proof,os.environ,
                                     _public_cache_emitter(emit_stream))
    receiver=Receiver(factory,pipeline,key,proof,zone=os.environ.get('BUSINESS_TIMEZONE','Asia/Kolkata'),
                      correction_contract=os.environ.get('POS_LEGACY_IMPORT_CORRECTION_CONTRACT'))
    from http_app import private_application
    application=private_application(receiver,key,emit_stream)
    if public_options is not None:
        from publication_resource import PublicationResource,private_application as publication_application
        application=publication_application(PublicationResource(factory,proof,pipeline.tasks),public_options['key'],emit_stream,application,public_options['allowPost'])
    if no_order_options is not None:
        from negative_resource import resource as negative_resource,private_application as negative_application
        application=negative_application(negative_resource(factory,proof),no_order_options['key'],emit_stream,
                                         application,no_order_options['allowPost'])
    if control_options is not None:
        from coupon_generation_resource import resource as control_resource,private_application as control_application
        application=control_application(control_resource(factory,proof,pipeline.benefits),
                                        control_options['key'],emit_stream,application)
    return application


def create_application():
    try:
        return _create_application()
    except Exception:
        raise ImportReview('ORDER_IMPORT_SOURCE_UNAVAILABLE') from None
