"""Once-fenced real source Celery task bodies for origin effect messages.

Use as an explicit Celery worker import in the reviewed source image. Broker
redelivery never repeats an uncertain body; a completed body returns its frozen
original result so the pinned two-task canvas can continue safely.
"""
import copy
import functools
import hmac
import os
from sqlalchemy import text
from origin_contracts import canonical,digest,fail
from origin_effects import load,seal_effects,open_effects
from native import one,rows,json_value

OBSERVER=None
def set_observer(callback):
    global OBSERVER
    if not callable(callback):fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
    OBSERVER=callback
def observed(command,phase):
    if OBSERVER is not None:
        try:OBSERVER({'phase':phase,'commandId':command['id'],'actorId':command['actorId']})
        except BaseException:pass


def install(bootstrap):
    registry=bootstrap.registry
    if registry is None:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
    owner=bootstrap.runtime
    def wrap(task):
        if getattr(task,'__screening_origin_consumer__',False):return
        original=task.run
        @functools.wraps(original)
        def run(*args,**kwargs):
            envelope=(getattr(task.request,'headers',None) or {}).get('screening-origin-effect')
            if envelope is None:return original(*args,**kwargs)
            from celery.exceptions import Ignore
            if (not isinstance(envelope,dict) or set(envelope)!={'data','proofHash'} or not isinstance(envelope['data'],dict)
                    or not hmac.compare_digest(digest(owner.key,'effect-call-authorization',envelope['data']),envelope['proofHash'])):raise Ignore()
            scope=envelope['data']
            if set(scope)!={'contract','effectId','commandId','ordinal','name','callHash','callsHash'} or scope['contract']!='pos-screening-origin-effects-v1':raise Ignore()
            with owner.sessions() as session,session.begin():
                hint=one(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':scope['commandId']})
                from origin_ledger import read
                command=read(session,scope['commandId'],str(hint['customer_id']),owner.key)
                row,effects,_deliveries=load(session,command,owner.key)
                matches=[effect for index,effect in enumerate(effects) if digest(owner.key,'effect-id',{'commandId':command['id'],'index':index,'effect':effect})==scope['effectId']]
                if len(matches)!=1:raise Ignore()
                effect=matches[0];calls=[effect['call']] if effect['kind'] in ('task','direct-task') else effect.get('calls')
                if not isinstance(calls,list) or type(scope['ordinal']) is not int or not 0<=scope['ordinal']<len(calls):raise Ignore()
                call=calls[scope['ordinal']]
                if (call['name']!=scope['name'] or registry.task(scope['name']) is not task or digest(owner.key,'effect-call',call)!=scope['callHash']
                        or digest(owner.key,'effect-calls',calls)!=scope['callsHash'] or kwargs!=call['kwargs']):raise Ignore()
                expected=list(call['args'])
                if scope['ordinal']==1:
                    prior=one(session,'SELECT phase,data,proof_hash,result_payload,result_hash FROM pos_rewrite_screening_origin_task_invocations WHERE effect_id=:id AND ordinal=0 FOR SHARE',{'id':scope['effectId']})
                    prior_data=json_value(prior['data'])
                    if prior['phase']!='INVOKED' or digest(owner.key,'task-invocation',prior_data)!=prior['proof_hash']:raise Ignore()
                    result=open_effects(owner.key,'task-result:'+scope['effectId']+':0',prior['result_payload'],prior['result_hash'])
                    if len(result)!=1:raise Ignore()
                    expected=[result[0],*expected]
                elif effect['kind']=='chain':expected=[*effect.get('args',[]),*expected]
                if canonical(list(args))!=canonical(expected):raise Ignore()
                prior=rows(session,'SELECT phase,data,proof_hash,result_payload,result_hash FROM pos_rewrite_screening_origin_task_invocations WHERE effect_id=:id AND ordinal=:ordinal FOR UPDATE',{'id':scope['effectId'],'ordinal':scope['ordinal']},2)
                if prior:
                    saved=json_value(prior[0]['data'])
                    if saved.get('scope')!=scope or digest(owner.key,'task-invocation',saved)!=prior[0]['proof_hash']:raise Ignore()
                    if prior[0]['phase']=='INVOKED':
                        result=open_effects(owner.key,'task-result:'+scope['effectId']+':'+str(scope['ordinal']),prior[0]['result_payload'],prior[0]['result_hash'])
                        if len(result)!=1:raise Ignore()
                        observed(command,'REPLAYED');return result[0]
                    observed(command,'REFUSED')
                    raise Ignore()
                record={'contract':'pos-screening-origin-task-invocation-v1','scope':scope,'phase':'SENDING','resultHash':None,'updatedAt':owner.clock()}
                session.execute(text("INSERT INTO pos_rewrite_screening_origin_task_invocations(effect_id,ordinal,command_id,phase,data,proof_hash) VALUES(:id,:ordinal,:command,'SENDING',:data,:hash)"),
                    {'id':scope['effectId'],'ordinal':scope['ordinal'],'command':scope['commandId'],'data':canonical(record),'hash':digest(owner.key,'task-invocation',record)})
            observed(command,'SENDING')
            try:
                result=original(*args,**kwargs)
                from hashlib import sha256
                result_hash=sha256(canonical([result]).encode()).hexdigest()
                payload=seal_effects(owner.key,'task-result:'+scope['effectId']+':'+str(scope['ordinal']),[result])
                if len(payload)>1400000:fail()
                phase='INVOKED'
            except BaseException:
                result=None;payload=None;result_hash=None;phase='UNCERTAIN'
            with owner.sessions() as session,session.begin():
                current=one(session,'SELECT data,proof_hash,phase FROM pos_rewrite_screening_origin_task_invocations WHERE effect_id=:id AND ordinal=:ordinal FOR UPDATE',{'id':scope['effectId'],'ordinal':scope['ordinal']})
                if current['phase']!='SENDING' or current['proof_hash']!=digest(owner.key,'task-invocation',record):raise Ignore()
                updated={**record,'phase':phase,'resultHash':result_hash,'updatedAt':owner.clock()}
                session.execute(text('UPDATE pos_rewrite_screening_origin_task_invocations SET phase=:phase,data=:data,proof_hash=:hash,result_payload=:payload,result_hash=:result WHERE effect_id=:id AND ordinal=:ordinal'),
                    {'id':scope['effectId'],'ordinal':scope['ordinal'],'phase':phase,'data':canonical(updated),'hash':digest(owner.key,'task-invocation',updated),'payload':payload,'result':result_hash})
            observed(command,phase)
            if phase!='INVOKED':raise Ignore()
            return result
        task.run=run;task.__screening_origin_consumer__=True
    from origin_effects import TASKS
    for name in TASKS:
        try:value=registry.task(name)
        except Exception:continue
        wrap(value)


if os.environ.get('POS_SCREENING_ORIGIN_EFFECT_CONSUMER_CONTRACT')=='pos-screening-origin-effects-v1':
    # Explicit process entry; disabled import has no source/DB/broker I/O.
    import io
    import sys
    import logging
    class Sink(io.TextIOBase):
        def write(self,value):return len(value)
        def flush(self):pass
    sys.stdout=Sink();sys.stderr=Sink();logging.disable(logging.CRITICAL)
    import main
    from source_runtime import SilentLogger
    import sys
    from pathlib import Path
    source=Path(main.__file__).resolve().parent
    for module in tuple(sys.modules.values()):
        filename=getattr(module,'__file__',None)
        if not filename:continue
        try:inside=Path(filename).resolve().is_relative_to(source)
        except (OSError,ValueError):inside=False
        if inside and hasattr(module,'logger'):module.logger=SilentLogger()
    install(main._screening_origins)
    # Two real original source apps share only the qualified broker factory.
    # Each lane is a runnable Celery -A origin_consumer:app|abandon_app worker.
    app=main._screening_origins.registry.tasks.app
    abandon_app=main._screening_origins.registry.fast_queue.process_abandon_cart_data.app
