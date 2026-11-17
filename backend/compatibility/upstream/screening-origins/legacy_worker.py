"""Opt-in actual legacy postcommit worker. Does not replace the POS server.

`python /opt/pos-source/screening-origins/legacy_worker.py --once` uses the
digest-pinned legacy dependency image and its real DJANGO_SETTINGS_MODULE.
No database/import/outbound work occurs when disabled. Errors are static.
"""
import argparse
import hashlib
import hmac
import io
import json
import logging
import os
import signal
import sys
import threading
import time
from datetime import datetime,timezone
from contextlib import redirect_stdout,redirect_stderr
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

STOP=threading.Event()
RUN_ID=str(uuid4())


def emit(action,phase=None):
    event={'eventId':'screening-origins.legacy-effects.'+action,'eventInstanceId':str(uuid4()),
           'module':'screening-origins','resource':'legacy-effects','requestId':RUN_ID,'userId':None,
           'timestamp':datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')}
    if phase in ('BLOCKED','UNCERTAIN','ACCEPTED','DISABLED'):event['phase']=phase
    print(json.dumps(event,separators=(',',':')),flush=True)


class Sink(io.TextIOBase):
    def write(self,value):return len(value)
    def flush(self):pass


def qualified_url(value):
    parsed=urlsplit(value)
    return parsed.scheme=='https' and bool(parsed.hostname) and not any((parsed.username,parsed.password,parsed.query,parsed.fragment))


def deliver(command_id,helpers,clock=lambda:int(time.time()*1000)):
    from django.db import transaction
    from legacy_staff import database,key,one,rows
    from origin_contracts import canonical,digest,fail
    secret=key();alias,connection=database()
    contract=os.environ.get('POS_SCREENING_ORIGIN_LEGACY_EFFECT_HTTP_CONTRACT')
    if contract!='pos-screening-origin-legacy-effects-v1':return {'phase':'BLOCKED','accepted':0}
    urls={'push_order_kinesis':helpers.ORDER_PRODUCER_URL,'push_for_em':helpers.MAIN_API_V2_URL+'em-check'}
    if any(not qualified_url(value) for value in urls.values()):fail('SCREENING_ORIGIN_EFFECT_TRANSPORT_UNQUALIFIED')
    while True:
        with transaction.atomic(using=alias),connection.cursor() as cursor:
            cash=one(cursor,'SELECT data,proof_hash,effects,phase FROM pos_rewrite_screening_origin_legacy_cash WHERE command_id=%s FOR UPDATE',(command_id,))
            proof=json.loads(cash['data']) if isinstance(cash['data'],str) else cash['data']
            effects=json.loads(cash['effects']) if isinstance(cash['effects'],str) else cash['effects']
            if (proof.get('commandId')!=command_id or not hmac.compare_digest(digest(secret,'legacy-cash',proof),cash['proof_hash']) or
                    hashlib.sha256(canonical(effects).encode()).hexdigest()!=proof['effectsHash'] or not isinstance(effects,list) or len(effects)>2):fail()
            selected=None
            for ordinal,effect in enumerate(effects):
                if set(effect)!={'name','orderId'} or effect['name'] not in urls or effect['orderId']!=proof['orderId']:fail()
                prior=rows(cursor,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_legacy_effect_attempts WHERE command_id=%s AND ordinal=%s FOR UPDATE',(command_id,ordinal))
                if prior:
                    attempt=json.loads(prior[0]['data']) if isinstance(prior[0]['data'],str) else prior[0]['data']
                    if (attempt.get('commandId')!=command_id or attempt.get('ordinal')!=ordinal or attempt.get('cashHash')!=cash['proof_hash']
                            or not hmac.compare_digest(digest(secret,'legacy-effect-attempt',attempt),prior[0]['proof_hash'])):fail()
                    if attempt['phase']=='ACCEPTED':continue
                    cursor.execute('UPDATE pos_rewrite_screening_origin_legacy_cash SET phase=%s WHERE command_id=%s',('UNCERTAIN',command_id))
                    return {'phase':'UNCERTAIN','accepted':ordinal}
                effect_id=digest(secret,'legacy-effect-id',{'commandId':command_id,'ordinal':ordinal,'cashHash':cash['proof_hash'],'effect':effect})
                attempt={'contract':'pos-screening-legacy-effect-v1','commandId':command_id,'ordinal':ordinal,'cashHash':cash['proof_hash'],
                    'effectId':effect_id,'phase':'SENDING','responseStatus':None,'responseHash':None,'updatedAt':clock()}
                cursor.execute('INSERT INTO pos_rewrite_screening_origin_legacy_effect_attempts(command_id,ordinal,effect_id,data,proof_hash) VALUES(%s,%s,%s,%s,%s)',
                    (command_id,ordinal,effect_id,canonical(attempt),digest(secret,'legacy-effect-attempt',attempt)))
                selected=effect;break
            if selected is None:
                cursor.execute('UPDATE pos_rewrite_screening_origin_legacy_cash SET phase=%s WHERE command_id=%s',('ACCEPTED',command_id))
                return {'phase':'ACCEPTED','accepted':len(effects)}
        # The native SENDING fence committed before this original HTTP helper.
        # Source success strings/None cannot substitute for the actual response.
        import requests
        original=requests.sessions.Session.request;observations=[]
        def request(instance,method,url,*args,**kwargs):
            if str(method).upper()!='POST' or url!=urls[selected['name']]:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
            body=kwargs.get('json')
            if body is None:
                try:body=json.loads(kwargs.get('data',''))
                except Exception:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
            field='payload' if selected['name']=='push_order_kinesis' else 'order_id'
            if not isinstance(body,dict) or set(body)!={field} or str(body[field])!=selected['orderId']:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
            headers={**kwargs.get('headers',{}),'X-TSS-Screening-Effect':attempt['effectId']}
            authorization={'contract':'pos-screening-origin-legacy-effect-http-v1','commandId':command_id,'ordinal':attempt['ordinal'],
                'effectId':attempt['effectId'],'cashHash':attempt['cashHash'],'bodyHash':hashlib.sha256(canonical(body).encode()).hexdigest()}
            headers['X-TSS-Screening-Effect-Proof']=digest(secret,'legacy-effect-http',authorization)
            kwargs.update(headers=headers,allow_redirects=False,verify=True,timeout=(5,20),stream=True)
            response=original(instance,method,url,*args,**kwargs)
            chunks=[];length=0
            try:
                for chunk in response.iter_content(65536):
                    length+=len(chunk)
                    if length>1000000:fail('SCREENING_ORIGIN_EFFECT_RESPONSE_TOO_LARGE')
                    chunks.append(chunk)
                response._content=b''.join(chunks);response._content_consumed=True
            finally:response.close()
            observations.append({'status':response.status_code,'hash':hashlib.sha256(response._content).hexdigest()})
            return response
        requests.sessions.Session.request=request
        try:
            # Original helper logs/results stay private, including its swallowed
            # exception messages. The worker reports only stage/count metadata.
            with redirect_stdout(Sink()),redirect_stderr(Sink()):getattr(helpers.Helpers,selected['name'])(int(selected['orderId']))
        except Exception:pass
        finally:requests.sessions.Session.request=original
        accepted=len(observations)==1 and 200<=observations[0]['status']<300
        updated={**attempt,'phase':'ACCEPTED' if accepted else 'UNCERTAIN',
            'responseStatus':observations[0]['status'] if len(observations)==1 else None,
            'responseHash':observations[0]['hash'] if len(observations)==1 else None,'updatedAt':clock()}
        with transaction.atomic(using=alias),connection.cursor() as cursor:
            prior=one(cursor,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_legacy_effect_attempts WHERE command_id=%s AND ordinal=%s FOR UPDATE',(command_id,attempt['ordinal']))
            if prior['proof_hash']!=digest(secret,'legacy-effect-attempt',attempt):fail()
            cursor.execute('UPDATE pos_rewrite_screening_origin_legacy_effect_attempts SET data=%s,proof_hash=%s WHERE command_id=%s AND ordinal=%s',
                (canonical(updated),digest(secret,'legacy-effect-attempt',updated),command_id,attempt['ordinal']))
            if not accepted:cursor.execute('UPDATE pos_rewrite_screening_origin_legacy_cash SET phase=%s WHERE command_id=%s',('UNCERTAIN',command_id))
        if not accepted:return {'phase':'UNCERTAIN','accepted':attempt['ordinal']}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--once',action='store_true');arguments=parser.parse_args()
    if os.environ.get('POS_SCREENING_ORIGIN_LEGACY_EFFECTS_WORKER_ENABLED')!='true':emit('disabled','DISABLED');return
    if os.environ.get('POS_SCREENING_ORIGIN_LEGACY_EFFECT_HTTP_CONTRACT')!='pos-screening-origin-legacy-effects-v1':raise ValueError()
    root=Path(os.environ['POS_SCREENING_ORIGIN_LEGACY_SOURCE_ROOT']).resolve()
    module_root=Path(__file__).resolve().parent
    manifest=json.loads((module_root/'legacy-manifest.json').read_text())
    if hashlib.sha256((root/'helpers/helpers.py').read_bytes()).hexdigest()!=manifest['candidate']['helpers/helpers.py']:raise ValueError()
    for path in (root,module_root.parent/'public-screening-writer',module_root):sys.path.insert(0,str(path))
    logging.disable(logging.CRITICAL)
    with redirect_stdout(Sink()),redirect_stderr(Sink()):
        import django
        django.setup()
        import helpers.helpers as helpers
    from legacy_staff import database,rows
    for name in (signal.SIGTERM,signal.SIGINT):signal.signal(name,lambda _number,_frame:STOP.set())
    emit('started')
    while not STOP.is_set():
        _alias,connection=database()
        with connection.cursor() as cursor:jobs=rows(cursor,'SELECT command_id FROM pos_rewrite_screening_origin_legacy_cash WHERE phase=%s ORDER BY command_id LIMIT 25',('PENDING',))
        for job in jobs:
            if STOP.is_set():break
            try:
                result=deliver(job['command_id'],helpers)
                emit('batch',result['phase'])
            except BaseException:
                # Transport metadata is not money. Stop a malformed/blocked
                # obligation from starving the next bounded worker page.
                with connection.cursor() as cursor:cursor.execute('UPDATE pos_rewrite_screening_origin_legacy_cash SET phase=%s WHERE command_id=%s AND phase=%s',('BLOCKED',job['command_id'],'PENDING'))
                emit('worker-failure','BLOCKED')
        if arguments.once:return
        STOP.wait(2)
    emit('stopped')


if __name__=='__main__':
    try:main()
    except SystemExit as error:
        if error.code not in (0,None):emit('startup-failure')
        raise
    except BaseException:
        emit('startup-failure');sys.exit(1)
