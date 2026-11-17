"""Separate private HTTP/worker entrypoints; disabled until explicitly configured.

No automatic source migrations. This bridge must share catalog-writer ownership
with existing full/individual cache writers before production activation.
"""

import argparse
import json
import logging
import multiprocessing
import os
import signal
import sys
import threading
import time
import uuid
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from contract import CONTRACT, SyncError, create_app
from source_runner import run, verified_source
from store import CommandStore


def emit(event):
    sys.stdout.write(json.dumps(event, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def configured():
    logging.disable(logging.CRITICAL)
    try:
        if os.environ.get("POS_ECOMMERCE_FULL_SYNC_CONTRACT") != CONTRACT:
            raise ValueError()
        key = os.environ["POS_ECOMMERCE_FULL_SYNC_SECRET"]
        if not 32 <= len(key) <= 256:
            raise ValueError()
        url = make_url(os.environ["POS_ECOMMERCE_FULL_SYNC_WRITER_URL"])
        if url.drivername != "mysql+pymysql" or not all([url.host, url.username, url.password, url.database]) or url.query:
            raise ValueError()
        ca = Path(os.environ["POS_ECOMMERCE_FULL_SYNC_MYSQL_CA_FILE"]).resolve(strict=True)
        engine = create_engine(url, echo=False, hide_parameters=True, pool_pre_ping=True,
            pool_size=2, max_overflow=1, pool_timeout=5, pool_recycle=300,
            connect_args={"ssl": {"ca": str(ca), "check_hostname": True}, "connect_timeout": 5, "read_timeout": 10, "write_timeout": 10})
        return engine, CommandStore(engine, time.time), key
    except Exception:
        raise SyncError("ECOMMERCE_FULL_SYNC_CONFIGURATION_INVALID") from None


def create_application():
    _engine, store, key = configured()
    return create_app(store, key, time.time, emit)


def child_run(source_root, connection):
    try:
        proof = run(source_root)
        connection.send({"proof": proof})
    except BaseException:
        connection.send({"error": "ECOMMERCE_FULL_SYNC_IO_UNCERTAIN"})
    finally:
        connection.close()


def execute(store, command, source_root, stop, timeout_seconds=1800, child_target=child_run):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(target=child_target, args=(source_root, child), daemon=True)
    process.start()
    child.close()
    outcome, deadline = None, time.monotonic() + timeout_seconds
    try:
        while process.is_alive():
            if parent.poll(1):
                outcome = parent.recv()
                break
            if stop.is_set() or time.monotonic() >= deadline or not store.heartbeat(command):
                break
        if outcome is None and parent.poll():
            outcome = parent.recv()
    except Exception:
        outcome = None
    finally:
        if process.is_alive():
            process.terminate()
        process.join(5)
        if process.is_alive():
            process.kill()
            process.join(5)
        parent.close()
    if process.is_alive():
        raise SyncError("ECOMMERCE_FULL_SYNC_WORKER_INTERRUPTED")
    # A worker failure does not free global ownership or publish completion.
    store.finish(command, proof=(outcome or {}).get("proof"), code="ECOMMERCE_FULL_SYNC_IO_UNCERTAIN")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("worker")
    reconcile = sub.add_parser("reconcile-stopped")
    reconcile.add_argument("operation_id")
    reconcile.add_argument("stopped_worker_id")
    reconcile.add_argument("evidence_sha256")
    args = parser.parse_args()
    engine = None
    try:
        engine, store, _key = configured()
        if args.mode == "reconcile-stopped":
            store.reconcile_stopped(args.operation_id, args.stopped_worker_id, args.evidence_sha256)
            return
        source_root = str(verified_source(os.environ["POS_ECOMMERCE_SOURCE_ROOT"]))
        stop = threading.Event()
        for sig in [signal.SIGTERM, signal.SIGINT]:
            signal.signal(sig, lambda _sig, _frame: stop.set())
        while not stop.is_set():
            worker_id = str(uuid.uuid4())
            command = store.claim(worker_id)
            if command is None:
                stop.wait(5)
                continue
            execute(store, command, source_root, stop)
            result = store.read(command["operationId"])
            emit({"module": "administration", "resource": "ecommerce-full-sync-worker", "eventId": "administration.ecommerce-full-sync-worker.completed",
                "eventInstanceId": command["operationId"], "workerId": worker_id,
                "requestId": command["requestId"], "userId": command["actorId"], "state": result["status"]})
    except BaseException:
        emit({"module": "administration", "resource": "ecommerce-full-sync-worker", "eventId": "administration.ecommerce-full-sync-worker.unavailable", "requestId": None, "userId": None})
        return 1
    finally:
        if engine is not None:
            engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
