"""Opt-in supervisor for original system orders and postcommit source effects.

Only owned protocol ports select/advance work. No payload, customer JWT or
service credential is accepted on the command line or written to logs.
"""
import hashlib
import importlib
import io
import json
import logging
import os
from pathlib import Path
import re
import signal
import sys
from threading import Event, Timer
from datetime import datetime, timezone
from uuid import UUID, uuid4

CONTRACT = 'pos-screening-origin-source-worker-v1'
SOURCE = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
PREFIX = 'POS_SCREENING_ORIGIN_SOURCE_WORKER_'
HERE = Path(__file__).resolve().parent


class Sink(io.TextIOBase):
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def flag(value, default=False):
    if value in (None, ''):
        return default
    if value not in ('true', 'false'):
        raise ValueError()
    return value == 'true'


def integer(value, default, minimum, maximum):
    if value in (None, ''):
        return default
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,6}', value):
        raise ValueError()
    result = int(value)
    if not minimum <= result <= maximum:
        raise ValueError()
    return result


def command_id(value):
    if not isinstance(value, str) or len(value) != 36 or str(UUID(value)) != value or UUID(value).int == 0:
        raise ValueError()
    return value


def candidates(port, limit):
    values = port(limit)
    if not isinstance(values, (list, tuple)) or len(values) > limit:
        raise ValueError()
    result = [command_id(value) for value in values]
    if len(set(result)) != len(result):
        raise ValueError()
    return result


def bounded_file(path, maximum):
    if not path.is_file() or path.stat().st_size > maximum:
        raise ValueError()
    with path.open('rb') as source:
        data = source.read(maximum + 1)
    if not data or len(data) > maximum:
        raise ValueError()
    return data


def source_root(env):
    configured = env.get(PREFIX + 'SOURCE_ROOT', '')
    if not configured or not Path(configured).is_absolute():
        raise ValueError()
    root = Path(configured).resolve(strict=True)
    manifest = json.loads(bounded_file(HERE.parent / 'public-screening-writer/manifest.json', 1000000))
    if (manifest.get('contract') != 'pos-node-screening-writer-v1'
            or manifest.get('sourceCommit') != SOURCE
            or manifest.get('otherOrigins', {}).get('contract') != 'pos-screening-origins-v1'):
        raise ValueError()
    expected = manifest.get('candidate')
    if not isinstance(expected, dict) or not 1 <= len(expected) <= 32:
        raise ValueError()
    required = {'main.py', 'controllers/OrderController.py', 'middleware/PosImportOrderGuard.py',
                'pos_node_screening.py', 'pos_screening_origins.py'}
    if not required.issubset(expected):
        raise ValueError()
    for relative, checksum in expected.items():
        if (not isinstance(relative, str) or not re.fullmatch(r'[A-Za-z0-9_./-]+\.py', relative)
                or Path(relative).is_absolute() or '..' in Path(relative).parts
                or not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum)):
            raise ValueError()
        path = (root / relative).resolve(strict=True)
        if not path.is_relative_to(root) or hashlib.sha256(bounded_file(path, 4000000)).hexdigest() != checksum:
            raise ValueError()
    return root


def main(arguments=None):
    # Original imported modules consume the actual process environment too.
    env = os.environ
    args = sys.argv[1:] if arguments is None else arguments
    stream = sys.stdout
    run_id = str(uuid4())
    stopped = Event()
    shutdown_timer = None
    original_handlers = {}
    bootstrap = None
    started = False
    exit_code = 1

    def emit(resource, action, request_id=None, actor=None, phase=None):
        # Callers provide only static resource/action values. No source result,
        # exception, path, URL, SQL, message or payload enters this envelope.
        try:
            request_id = command_id(request_id) if request_id is not None else run_id
            user_id = actor if isinstance(actor, str) and re.fullmatch(r'[1-9][0-9]{0,18}', actor) else None
            if user_id is not None and int(user_id) > 9223372036854775807:
                user_id = None
            value = {'module': 'screening-origins', 'resource': resource,
                     'eventId': 'screening-origins.' + resource + '.' + action,
                     'eventInstanceId': str(uuid4()), 'requestId': request_id,
                     'userId': user_id, 'timestamp': datetime.now(timezone.utc).isoformat()}
            if phase in ('PREPARED', 'SOURCE_RUNNING', 'PAYMENT_SENDING', 'PENDING',
                         'SENDING', 'UNCERTAIN', 'COMPLETE', 'ACCEPTED', 'REJECTED',
                         'FAILED', 'BLOCKED', 'COUNTED', 'BOUND'):
                value['phase'] = phase
            stream.write(json.dumps(value, separators=(',', ':')) + '\n')
            stream.flush()
        except Exception:
            pass

    def deadline():
        emit('source-worker', 'shutdown-failed')
        os._exit(1)

    def stop(_signal=None, _frame=None):
        nonlocal shutdown_timer
        if not stopped.is_set():
            stopped.set()
            shutdown_timer = Timer(40, deadline)
            shutdown_timer.daemon = True
            shutdown_timer.start()

    try:
        if args not in ([], ['--once']):
            raise ValueError()
        if flag(env.get('DEMO_MODE')) or not flag(env.get(PREFIX + 'ENABLED')):
            emit('source-worker', 'disabled')
            return 0
        if (env.get(PREFIX + 'CONTRACT') != CONTRACT
                or env.get('POS_SCREENING_ORIGIN_CONTRACT') != 'pos-screening-origins-v1'
                or not re.fullmatch(r'[!-~]{32,4096}', env.get('POS_SCREENING_ORIGIN_PROOF_KEY', ''))):
            raise ValueError()
        system = flag(env.get(PREFIX + 'SYSTEM_ENABLED'))
        effects = flag(env.get(PREFIX + 'EFFECTS_ENABLED'))
        if not (system or effects):
            raise ValueError()
        if system and env.get('POS_SCREENING_ORIGIN_SYSTEM_CONTRACT') != 'pos-screening-origin-system-v1':
            raise ValueError()
        interval = integer(env.get(PREFIX + 'INTERVAL_MS'), 2000, 1000, 60000)
        limit = integer(env.get(PREFIX + 'BATCH'), 10, 1, 25)
        once = args == ['--once'] or flag(env.get(PREFIX + 'ONCE'))
        root = source_root(env)
        for name in (signal.SIGINT, signal.SIGTERM):
            original_handlers[name] = signal.getsignal(name)
            signal.signal(name, stop)
        # Suppress source import/handler diagnostics before importing main.
        # emit retains its independent original output stream.
        logging.disable(logging.CRITICAL)
        sys.stdout, sys.stderr = Sink(), Sink()
        for directory in (HERE.parent / 'legacy-order-imports',
                          HERE.parent / 'legacy-order-imports/benefit-profile',
                          HERE.parent / 'public-screening-writer', HERE, root):
            sys.path.insert(0, str(directory))
        if 'main' in sys.modules:
            # A supervisor cannot reuse another application's imported module.
            raise ValueError()
        module = importlib.import_module('main')
        if Path(module.__file__).resolve() != root / 'main.py':
            raise ValueError()
        bootstrap = module._screening_origins
        if bootstrap.runtime is None:
            raise ValueError()
        lanes = []
        if system:
            orders = bootstrap.system
            if orders is None or not callable(getattr(orders, 'worker_candidates', None)) or not callable(getattr(orders, 'run', None)):
                raise ValueError()
            lanes.append(('system-order-worker', orders.worker_candidates, orders.run))
        if effects:
            if not callable(getattr(bootstrap, 'effect_candidates', None)) or not callable(getattr(bootstrap, 'dispatch_effects', None)):
                raise ValueError()
            lanes.append(('source-effects-worker', bootstrap.effect_candidates, bootstrap.dispatch_effects))
        emit('source-worker', 'started')
        started = True
        while not stopped.is_set():
            for resource, select, advance in lanes:
                if stopped.is_set():
                    break
                try:
                    pending = candidates(select, limit)
                except Exception:
                    emit(resource, 'unavailable')
                    continue
                for identity in pending:
                    if stopped.is_set():
                        break
                    try:
                        result = advance(identity)
                        actor = result.get('actorId') if isinstance(result, dict) else None
                        phase = result.get('phase') if isinstance(result, dict) else None
                        emit(resource, 'observed', identity, actor, phase)
                    except Exception:
                        emit(resource, 'reconciliation-required', identity)
            if once:
                break
            stopped.wait(interval / 1000)
        exit_code = 0
    except BaseException:
        emit('source-worker', 'unavailable')
        exit_code = 1
    finally:
        # Install a cleanup deadline even after a normal one-cycle exit.
        if original_handlers or bootstrap is not None:
            stop()
        try:
            if bootstrap is not None:
                close = getattr(bootstrap, 'close_worker', None)
                if callable(close):
                    close()
                else:
                    engine = bootstrap.runtime.sessions.kw.get('bind')
                    if engine is not None:
                        engine.dispose()
        except Exception:
            emit('source-worker', 'shutdown-failed')
            exit_code = 1
        finally:
            if shutdown_timer is not None:
                shutdown_timer.cancel()
            # Source-library atexit/background diagnostics must stay muted for
            # the rest of this dedicated process, including interpreter exit.
            for name, handler in original_handlers.items():
                signal.signal(name, handler)
    if started and exit_code == 0:
        emit('source-worker', 'stopped')
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
