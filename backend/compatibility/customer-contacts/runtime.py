"""Configured bridge factory and a separate bounded worker; neither imports legacy app startup."""

import json
import logging
import os
import re
import signal
import ssl
import sys
import threading
import uuid
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from adapters import KINDS, TASKS, SourceAdapters
from app import create_app
from contract import SECRET, ContactError
from service import ContactEffects


def emit(event):
    sys.stdout.write(json.dumps(event, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def configured():
    # Dedicated service: third-party broker/driver logs cannot print URLs,
    # headers, contact rows or raw exceptions. Controlled events use emit().
    logging.disable(logging.CRITICAL)
    try:
        service_key = os.environ["POS_CONTACT_EFFECTS_SERVICE_KEY"]
        storage_key = os.environ["POS_CONTACT_EFFECTS_STORAGE_KEY"]
        if (
            not SECRET.fullmatch(service_key)
            or not SECRET.fullmatch(storage_key)
            or service_key == storage_key
        ):
            raise ValueError()
        url = make_url(os.environ["POS_CONTACT_EFFECTS_WRITER_URL"])
        ca = Path(os.environ["POS_CONTACT_EFFECTS_MYSQL_CA_FILE"]).resolve(strict=True)
        if (
            url.drivername != "mysql+pymysql"
            or not all([url.host, url.username, url.password, url.database])
            or url.query
        ):
            raise ValueError()
        engine = create_engine(
            url,
            echo=False,
            hide_parameters=True,
            pool_size=4,
            max_overflow=4,
            pool_timeout=5,
            pool_pre_ping=True,
            pool_recycle=300,
            connect_args={
                "ssl": {"ca": str(ca), "check_hostname": True},
                "connect_timeout": 5,
                "read_timeout": 10,
                "write_timeout": 10,
            },
        )
        sessions = sessionmaker(engine, expire_on_commit=False)
        return (
            engine,
            sessions,
            ContactEffects(sessions, service_key, storage_key),
            service_key,
        )
    except Exception:
        raise RuntimeError(
            "Customer contact effect configuration is unavailable"
        ) from None


def create_application():
    try:
        _engine, _sessions, service, key = configured()
        return create_app(service, key, emit=emit)
    except Exception:
        emit(
            {
                "module": "customer-contacts",
                "resource": "customer-contact-source-http",
                "eventId": "customer-contacts.customer-contact-source-http.startup-failed",
                "eventInstanceId": str(uuid.uuid4()),
                "requestId": None,
                "userId": None,
            }
        )
        raise RuntimeError(
            "Customer contact source HTTP configuration is unavailable"
        ) from None


def verify_private_worker(celery, worker_name, candidate, queues):
    """Bounded metadata-only readiness proves the exact candidate on an isolated worker."""
    try:
        if len(set(queues)) != 2 or any(
            not value.startswith("pos-contact-") for value in queues
        ):
            raise ValueError()
        proof = celery.control.broadcast(
            "pos_contact_task_privacy", destination=[worker_name], reply=True, timeout=5
        )
        expected = {
            "contract": "pos-customer-contact-tasks-v1",
            "helperSha256": candidate["newFileSha256"],
            "tasksSha256": candidate["afterSha256"],
            "tasks": sorted(TASKS.values()),
        }
        if (
            not isinstance(proof, list)
            or len(proof) != 1
            or proof[0].get(worker_name) != expected
        ):
            raise ValueError()
        active = celery.control.inspect(
            destination=[worker_name], timeout=5
        ).active_queues()
        if (
            not isinstance(active, dict)
            or worker_name not in active
            or not set(queues).issubset(
                {item.get("name") for item in active[worker_name]}
            )
        ):
            raise ValueError()
    except Exception:
        raise ContactError("CONTACT_EFFECTS_PRIVATE_WORKER_UNVERIFIED") from None


def build_adapters(sessions):
    from celery import Celery
    from redis import Redis

    try:
        if (
            os.environ.get("POS_CONTACT_EFFECTS_TASK_CONTRACT")
            != "pos-customer-contact-tasks-v1"
            or os.environ.get("POS_CONTACT_SOURCE_PRIVACY_VERIFIED") != "true"
        ):
            raise ValueError()
        candidate = json.loads(
            Path(__file__).with_name("privacy-candidate-manifest.json").read_text()
        )
        if (
            os.environ.get("POS_CONTACT_SOURCE_PRIVACY_PATCH_SHA256")
            != candidate["patchSha256"]
        ):
            raise ValueError()
        worker_name = os.environ["POS_CONTACT_SOURCE_WORKER_NODE"]
        if not isinstance(worker_name, str) or not re.fullmatch(
            r"[A-Za-z0-9_.:@-]{1,128}", worker_name
        ):
            raise ValueError()
        cache_url = os.environ["POS_CONTACT_AUTH_CACHE_REDIS_URL"]
        broker_url = os.environ["POS_CONTACT_CELERY_BROKER_URL"]
        for raw in [cache_url, broker_url]:
            parsed = urlparse(raw)
            if (
                parsed.scheme != "rediss"
                or not parsed.hostname
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError()
        cache = Redis.from_url(
            cache_url,
            ssl_cert_reqs=ssl.CERT_REQUIRED,
            ssl_check_hostname=True,
            socket_connect_timeout=5,
            socket_timeout=5,
            decode_responses=False,
        )
        celery = Celery(
            "pos-customer-contact-producer", broker=broker_url, backend=None
        )
        celery.conf.update(
            task_serializer="json",
            accept_content=["json"],
            task_ignore_result=True,
            task_send_sent_event=False,
            task_publish_retry=False,
            broker_connection_retry=False,
            broker_connection_retry_on_startup=False,
            broker_connection_max_retries=0,
            broker_connection_timeout=5,
            broker_use_ssl={
                "ssl_cert_reqs": ssl.CERT_REQUIRED,
                "ssl_check_hostname": True,
            },
            broker_transport_options={
                "socket_connect_timeout": 5,
                "socket_timeout": 5,
                "retry_on_timeout": False,
            },
        )
        keys = {
            "hs256": os.environ["POS_CONTACT_CUSTOMER_JWT_HS256"],
            "hs512": os.environ["POS_CONTACT_CUSTOMER_JWT_HS512"],
        }
        if any(len(value) < 32 for value in keys.values()):
            raise ValueError()
        adapter = SourceAdapters(
            sessions,
            cache,
            celery,
            keys,
            payment_url=os.environ["POS_CONTACT_PAYMENT_CUSTOMER_UPDATE_URL"],
            refund_url=os.environ["POS_CONTACT_REFUND_FAILED_MAIL_URL"],
            default_queue=os.environ["POS_CONTACT_DEFAULT_TASK_QUEUE"],
            support_queue=os.environ["POS_CONTACT_SUPPORT_QUEUE"],
        )
        verify_private_worker(
            celery,
            worker_name,
            candidate,
            [adapter.default_queue, adapter.support_queue],
        )
        return adapter, cache, celery
    except Exception:
        raise RuntimeError("Customer contact source delivery is unavailable") from None


def worker_main():
    engine = cache = celery = None
    stop = threading.Event()
    for name in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(name, lambda _signal, _frame: stop.set())
    try:
        if os.environ.get("POS_CONTACT_EFFECTS_WORKER_ENABLED") != "true":
            emit(
                {
                    "module": "customer-contacts",
                    "resource": "customer-contact-source-worker",
                    "eventId": "customer-contacts.customer-contact-source-worker.disabled",
                    "eventInstanceId": str(uuid.uuid4()),
                    "requestId": None,
                    "userId": None,
                }
            )
            return
        engine, sessions, service, _key = configured()
        adapter, cache, celery = build_adapters(sessions)
        while not stop.is_set():
            try:
                result = service.drain_one(adapter)
                if isinstance(result, dict):
                    kind = result["kind"] if result["kind"] in KINDS else "invalid"
                    emit(
                        {
                            "module": "customer-contacts",
                            "resource": "customer-contact-source-effect",
                            "eventId": "customer-contacts.customer-contact-source-effect."
                            + kind
                            + "."
                            + result["status"].lower(),
                            "eventInstanceId": str(uuid.uuid4()),
                            "requestId": result["requestId"],
                            "userId": result["operatorId"],
                            "jobId": result["jobId"],
                            "receiptId": result["receiptId"],
                        }
                    )
            except Exception:
                emit(
                    {
                        "module": "customer-contacts",
                        "resource": "customer-contact-source-worker",
                        "eventId": "customer-contacts.customer-contact-source-worker.unavailable",
                        "eventInstanceId": str(uuid.uuid4()),
                        "requestId": None,
                        "userId": None,
                    }
                )
            stop.wait(2)
    except Exception:
        emit(
            {
                "module": "customer-contacts",
                "resource": "customer-contact-source-worker",
                "eventId": "customer-contacts.customer-contact-source-worker.startup-failed",
                "eventInstanceId": str(uuid.uuid4()),
                "requestId": None,
                "userId": None,
            }
        )
        sys.exit(1)
    finally:
        for close in [
            getattr(cache, "close", None),
            getattr(celery, "close", None),
            getattr(engine, "dispose", None),
        ]:
            if close:
                try:
                    close()
                except Exception:
                    pass


if __name__ == "__main__":
    worker_main()
