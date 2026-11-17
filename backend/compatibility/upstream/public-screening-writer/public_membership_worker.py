"""Dedicated supervised membership-cache consumer; default off, no startup I/O.

Use the original source dependency image and qualified private AMQPS settings.
Only its explicit private queue is consumed. This entry never creates an order,
confirms payment, issues a gift, or refreshes historical warehouse facts.
"""
import json
import logging
import os
from pathlib import Path
import re
import sys


def main(environment=None):
    env=os.environ if environment is None else environment
    stream=sys.stdout
    def emit(value):
        try:stream.write(json.dumps(value,separators=(',',':'))+'\n');stream.flush()
        except Exception:pass
    if env.get('DEMO_MODE')=='true' or env.get('POS_PUBLIC_SCREENING_MEMBERSHIP_WORKER_ENABLED') in (None,'','false'):
        emit({'module':'public-screening','resource':'membership-cache-worker',
            'eventId':'public-screening.membership-cache-worker.disabled','requestId':None,'userId':None})
        return 0
    engine=None
    try:
        if (env.get('POS_PUBLIC_SCREENING_MEMBERSHIP_WORKER_ENABLED')!='true'
                or env.get('POS_PUBLIC_SCREENING_MEMBERSHIP_WORKER_CONTRACT')!='pos-public-screening-membership-cache-worker-v1'):
            raise ValueError()
        queue=env.get('POS_PUBLIC_SCREENING_MEMBERSHIP_CACHE_QUEUE','')
        key=env.get('POS_LEGACY_IMPORT_PROOF_KEY','')
        if (not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',queue) or not re.fullmatch(r'[!-~]{32,4096}',key)
                or queue not in json.loads(env.get('POS_LEGACY_IMPORT_EFFECT_QUEUES','[]'))
                or key==env.get('POS_MEMBERSHIP_PROOF_KEY')):raise ValueError()
        common=Path(__file__).resolve().parent.parent/'legacy-order-imports'
        sys.path.insert(0,str(common))
        from sqlalchemy import create_engine
        from sqlalchemy.engine import make_url
        from sqlalchemy.orm import sessionmaker
        url=make_url(env['POS_LEGACY_IMPORT_MYSQL_WRITER_URL'])
        ca=Path(env['POS_LEGACY_IMPORT_MYSQL_CA_FILE']).resolve(strict=True)
        if (url.drivername!='mysql+pymysql' or not all((url.host,url.username,url.password,url.database)) or url.query
                or not ca.is_file()):raise ValueError()
        # Close source/debug/raw-error channels before importing the source
        # runtime. The saved stream receives allowlisted lifecycle/job fields.
        logging.disable(logging.CRITICAL)
        sys.stdout=open(os.devnull,'w');sys.stderr=open(os.devnull,'w')
        from source_runtime import SourceRuntime
        source=SourceRuntime(env['POS_LEGACY_IMPORT_SOURCE_ROOT'],env['POS_LEGACY_IMPORT_RUNTIME_ROOT'])
        source.tasks.assert_ready()
        engine=create_engine(url,echo=False,hide_parameters=True,pool_size=2,max_overflow=0,pool_timeout=5,
            pool_pre_ping=True,connect_args={'ssl':{'ca':str(ca),'check_hostname':True},
                'connect_timeout':5,'read_timeout':10,'write_timeout':10})
        sessions=sessionmaker(bind=engine,expire_on_commit=False)
        from public_benefit_cache import register_task
        register_task(source.tasks,sessions,key,env,emit)
        emit({'module':'public-screening','resource':'membership-cache-worker',
            'eventId':'public-screening.membership-cache-worker.started','requestId':None,'userId':None})
        # Celery owns SIGTERM/INT and finishes its single bounded task. No task
        # retry/redelivery is used to resolve an unknown Redis outcome.
        source.tasks.app.worker_main(['worker','--queues='+queue,'--pool=solo','--concurrency=1',
            '--prefetch-multiplier=1','--loglevel=CRITICAL','--without-mingle','--without-gossip'])
        emit({'module':'public-screening','resource':'membership-cache-worker',
            'eventId':'public-screening.membership-cache-worker.stopped','requestId':None,'userId':None})
        return 0
    except Exception:
        emit({'module':'public-screening','resource':'membership-cache-worker',
            'eventId':'public-screening.membership-cache-worker.startup-failed','requestId':None,'userId':None})
        return 1
    finally:
        if engine is not None:engine.dispose()


if __name__=='__main__':raise SystemExit(main())
