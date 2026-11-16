"""Purpose-scoped privacy for the three pinned POS customer-contact task paths."""

import contextvars
import functools
import hashlib
import json
import logging
import math
import re
import sys
import threading
import uuid
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import urlsplit

from celery import current_task
from celery.worker.control import inspect_command

PURPOSE = "pos-customer-contact-tasks-v1"
TASKS = {
    "clevertap-profile": "pos.customer_contacts.clevertap_v1",
    "moengage-attributes": "pos.customer_contacts.moengage_v1",
    "support-flags": "pos.customer_contacts.support_v1",
}
RESOURCES = set(TASKS)
_scope = contextvars.ContextVar("pos_customer_contact_log_scope", default=None)
_factory_lock = threading.RLock()
_emit_lock = threading.Lock()
_installed_factory = None
_source_sha256 = None


class PrivateContactTaskError(Exception):
    """Static task failure: no source exception/cause/message reaches Celery."""


def _uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def _id(value):
    return (
        isinstance(value, str)
        and re.fullmatch(r"[1-9][0-9]{0,18}", value)
        and int(value) <= 9223372036854775807
    )


def _install_factory():
    global _installed_factory
    with _factory_lock:
        previous = logging.getLogRecordFactory()
        if previous is _installed_factory:
            return

        def private_factory(*args, **kwargs):
            scope = _scope.get()
            if scope is None:
                return previous(*args, **kwargs)
            level = kwargs.get("level", args[1] if len(args) > 1 else 0)
            if isinstance(level, int):
                if level >= logging.ERROR:
                    scope["sourceErrorCount"] += 1
                elif level >= logging.WARNING:
                    scope["sourceWarningCount"] += 1
            # Do not even give an existing formatter a raw string, exception,
            # args or extra context. A negative level also suppresses this static
            # record in every handler observed in the pinned source.
            return logging.LogRecord(
                "pos.customer-contact.suppressed",
                -1,
                "pos_contact_task_privacy",
                0,
                "Private customer-contact task diagnostic suppressed",
                (),
                None,
            )

        _installed_factory = private_factory
        logging.setLogRecordFactory(private_factory)


def _emit(scope, phase):
    event = {
        "module": "customer-contacts",
        "resource": scope["resource"],
        "eventId": "customer-contacts." + scope["resource"] + "." + phase,
        "eventInstanceId": str(uuid.uuid4()),
        "requestId": scope["requestId"],
        "userId": scope["userId"],
        "taskId": scope["taskId"],
        "operationId": scope["operationId"],
        "sourceErrorCount": scope["sourceErrorCount"],
        "sourceWarningCount": scope["sourceWarningCount"],
    }
    with _emit_lock:
        sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def private_contact_task(resource):
    if resource not in RESOURCES:
        raise ValueError("Invalid private contact task resource")

    def decorate(function):
        @functools.wraps(function)
        def wrapped(*args, **kwargs):
            request = getattr(current_task, "request", None)
            headers = getattr(request, "headers", None) or {}
            if not isinstance(headers, Mapping) or "pos-contact-purpose" not in headers:
                raise PrivateContactTaskError(
                    "Private customer-contact task purpose missing"
                )
            actor, customer = (
                headers.get("pos-contact-operator-id"),
                headers.get("pos-contact-customer-id"),
            )
            task_id, operation = (
                getattr(request, "id", None),
                headers.get("pos-contact-operation-id"),
            )
            if (
                headers.get("pos-contact-purpose") != PURPOSE
                or not _id(actor)
                or not _id(customer)
                or not _uuid(task_id)
                or not _uuid(operation)
                or kwargs
            ):
                raise PrivateContactTaskError(
                    "Private customer-contact task proof invalid"
                )
            expected = (
                ([int(customer)], int(customer))
                if resource == "clevertap-profile"
                else (int(customer),)
            )
            if args != expected:
                raise PrivateContactTaskError(
                    "Private customer-contact task scope invalid"
                )
            request_id = headers.get("pos-contact-request-id")
            scope = {
                "resource": resource,
                "requestId": request_id if _uuid(request_id) else task_id,
                "userId": actor,
                "taskId": task_id,
                "operationId": operation,
                "sourceErrorCount": 0,
                "sourceWarningCount": 0,
            }
            _install_factory()
            token = _scope.set(scope)
            try:
                _emit(scope, "started")
                try:
                    value = function(*args, **kwargs)
                except Exception:
                    _emit(scope, "failed")
                    # Source diagnostic strings/traceback context are private.
                    raise PrivateContactTaskError(
                        "Customer contact source task failed"
                    ) from None
                _emit(scope, "returned")
                return value
            finally:
                _scope.reset(token)

        return wrapped

    return decorate


def _install_requests_guard(module):
    session_type = module.sessions.Session
    original = session_type.request
    if getattr(original, "_pos_contact_private_guard", False):
        return

    @functools.wraps(original)
    def bounded(session, method, url, *args, **kwargs):
        if _scope.get() is None:
            return original(session, method, url, *args, **kwargs)
        try:
            parsed = urlsplit(url)
            verify = kwargs.get("verify")
            if (
                not isinstance(url, str)
                or parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or not (
                    verify is None
                    or verify is True
                    or isinstance(verify, str)
                    and bool(verify)
                )
            ):
                raise ValueError()
            supplied = kwargs.get("timeout")
            if supplied is None:
                timeout = (3, 5)
            else:
                values = (
                    supplied
                    if isinstance(supplied, tuple) and len(supplied) == 2
                    else (supplied, supplied)
                )
                if any(
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(value)
                    or value <= 0
                    for value in values
                ):
                    raise ValueError()
                timeout = (min(3, values[0]), min(5, values[1]))
        except Exception:
            raise PrivateContactTaskError(
                "Private customer-contact provider configuration invalid"
            ) from None
        kwargs.update(timeout=timeout, allow_redirects=False, stream=True)
        response = original(session, method, url, *args, **kwargs)
        try:
            content = []
            size = 0
            for chunk in response.iter_content(chunk_size=8192):
                size += len(chunk)
                if size > 64000:
                    raise PrivateContactTaskError(
                        "Private customer-contact provider response exceeds limit"
                    )
                content.append(chunk)
            response._content = b"".join(content)
            response._content_consumed = True
            return response
        finally:
            response.close()
            # Requests skips raw.close after a fully consumed response. Close the
            # bounded stream explicitly while keeping its cached JSON available.
            raw = getattr(response, "raw", None)
            if raw is not None:
                raw.close()

    bounded._pos_contact_private_guard = True
    session_type.request = bounded


@inspect_command()
def pos_contact_task_privacy(_state, **_kwargs):
    """Read-only worker readiness: no contacts, args, credentials or source paths."""
    return {
        "contract": PURPOSE,
        "helperSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "tasksSha256": _source_sha256,
        "tasks": sorted(TASKS.values()),
    }


def register_private_contact_tasks(app, targets, requests_module=None):
    """New names fail closed on unpatched workers; original source tasks are unchanged."""
    global _source_sha256
    if requests_module is not None:
        _install_requests_guard(requests_module)
    if set(targets) != RESOURCES:
        raise ValueError("Private customer-contact task registry invalid")
    paths = {
        Path(target.run.__code__.co_filename).resolve(strict=True)
        for target in targets.values()
    }
    if len(paths) != 1:
        raise ValueError("Private customer-contact source task artifact invalid")
    _source_sha256 = hashlib.sha256(paths.pop().read_bytes()).hexdigest()

    def build(target, resource):
        def execute(*args, **kwargs):
            # These purpose-only tasks acknowledge execution without returning a
            # profile/provider value to Celery's result/success diagnostics.
            target.run(*args, **kwargs)

        return private_contact_task(resource)(execute)

    for resource, target in targets.items():
        app.task(name=TASKS[resource], ignore_result=True)(build(target, resource))
