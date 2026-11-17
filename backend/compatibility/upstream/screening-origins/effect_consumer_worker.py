"""Explicit quiet supervisor for either original source Celery app.

An unselected process opens no source, broker or database. Selected consumers
use only named qualified private queues and the actual pinned source candidate.
"""
from datetime import datetime, timezone
import importlib
import json
import logging
import os
from pathlib import Path
import re
import sys
from threading import Timer
from uuid import uuid4
from source_worker import Sink, command_id, flag, source_root


def main():
    env = os.environ
    stream = sys.stdout
    run_id = str(uuid4())
    lane = env.get('POS_SCREENING_ORIGIN_EFFECT_CONSUMER_LANE', 'tasks')
    resource = 'source-abandon-consumer' if lane == 'abandon' else 'source-task-consumer'
    bootstrap = None
    shutdown_timer = None
    exit_code = 1

    def emit(action, request_id=None, actor=None):
        try:
            identity = command_id(request_id) if request_id is not None else run_id
            user = actor if isinstance(actor, str) and re.fullmatch(r'[1-9][0-9]{0,18}', actor) else None
            if user is not None and int(user) > 9223372036854775807:
                user = None
            value = {'module': 'screening-origins', 'resource': resource,
                     'eventId': 'screening-origins.' + resource + '.' + action,
                     'eventInstanceId': str(uuid4()), 'requestId': identity, 'userId': user,
                     'timestamp': datetime.now(timezone.utc).isoformat()}
            stream.write(json.dumps(value, separators=(',', ':')) + '\n')
            stream.flush()
        except Exception:
            pass

    def observe(value):
        # Independent consumer events never forward arbitrary source dictionaries.
        if not isinstance(value, dict):
            return
        action = value.get('phase')
        if action not in ('SENDING', 'INVOKED', 'UNCERTAIN', 'REPLAYED', 'REFUSED'):
            return
        emit('invocation-' + action.lower(), value.get('commandId'), value.get('actorId'))

    def deadline():
        emit('shutdown-failed')
        os._exit(1)

    def shutdown(**_fields):
        nonlocal shutdown_timer
        if shutdown_timer is None:
            emit('stopping')
            shutdown_timer = Timer(40, deadline)
            shutdown_timer.daemon = True
            shutdown_timer.start()

    try:
        if len(sys.argv) != 1:
            raise ValueError()
        if flag(env.get('DEMO_MODE')) or not flag(env.get('POS_SCREENING_ORIGIN_EFFECT_CONSUMER_ENABLED')):
            emit('disabled')
            return 0
        if (lane not in ('tasks', 'abandon')
                or env.get('POS_SCREENING_ORIGIN_EFFECT_CONSUMER_CONTRACT') != 'pos-screening-origin-effects-v1'
                or env.get('POS_SCREENING_ORIGIN_EFFECTS_CONTRACT') != 'pos-screening-origin-effects-v1'
                or env.get('POS_SCREENING_ORIGIN_CONTRACT') != 'pos-screening-origins-v1'):
            raise ValueError()
        encoded = env.get('POS_SCREENING_ORIGIN_EFFECT_CONSUMER_QUEUES', '')
        allowed = env.get('POS_LEGACY_IMPORT_EFFECT_QUEUES', '')
        if len(encoded) > 16000 or len(allowed) > 16000:
            raise ValueError()
        queues, qualified = json.loads(encoded), json.loads(allowed)
        for values in (queues, qualified):
            if (not isinstance(values, list) or not 1 <= len(values) <= 100
                    or any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', name) for name in values)
                    or len(set(values)) != len(values)):
                raise ValueError()
        if not set(queues).issubset(qualified):
            raise ValueError()
        root = source_root(env)
        logging.disable(logging.CRITICAL)
        sys.stdout, sys.stderr = Sink(), Sink()
        here = Path(__file__).resolve().parent
        for directory in (here.parent / 'legacy-order-imports',
                          here.parent / 'legacy-order-imports/benefit-profile',
                          here.parent / 'public-screening-writer', here, root):
            sys.path.insert(0, str(directory))
        if 'main' in sys.modules or 'origin_consumer' in sys.modules:
            raise ValueError()
        consumer = importlib.import_module('origin_consumer')
        if not callable(getattr(consumer, 'set_observer', None)):
            raise ValueError()
        consumer.set_observer(observe)
        bootstrap = sys.modules['main']._screening_origins
        app = consumer.abandon_app if lane == 'abandon' else consumer.app
        bootstrap.registry.tasks.assert_ready()
        app.conf.worker_enable_remote_control = False
        from celery.signals import worker_shutting_down
        worker_shutting_down.connect(shutdown, weak=False)
        emit('started')
        result = app.worker_main(['worker', '--queues=' + ','.join(queues), '--pool=solo', '--concurrency=1',
                                  '--prefetch-multiplier=1', '--loglevel=CRITICAL', '--without-mingle', '--without-gossip'])
        if result not in (None, 0):
            raise ValueError()
        exit_code = 0
    except BaseException:
        emit('unavailable')
        exit_code = 1
    finally:
        if bootstrap is not None:
            shutdown()
            try:
                bootstrap.close_worker()
            except Exception:
                emit('shutdown-failed')
                exit_code = 1
        if shutdown_timer is not None:
            shutdown_timer.cancel()
    if exit_code == 0:
        emit('stopped')
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
