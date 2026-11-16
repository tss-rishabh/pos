"""Private invoice transport and purpose-only feedback proof.

This module never imports customer token helpers or accepts a customer signing
key. The isolated invoice process must additionally use read-only SQL credentials.
"""
import base64
import contextvars
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from urllib.parse import urlsplit, urlunsplit

import falcon
import settings

INVOICE_CONTRACT = "pos-invoice-security-v1"
FEEDBACK_CONTRACT = "pos-feedback-proof-v1"
FEEDBACK_ISSUER = "pos-invoice"
FEEDBACK_AUDIENCE = "tss-pos-feedback"
_scope = contextvars.ContextVar("private_invoice_scope", default=None)
_identifier = re.compile(r"[1-9][0-9]{0,18}\Z")
_key_id = re.compile(r"[a-z0-9][a-z0-9_-]{0,39}\Z")


def _unavailable():
    return falcon.HTTPServiceUnavailable(title="Invoice unavailable", description="Private invoice security is not configured.")


def _configuration(environ=None):
    environ = os.environ if environ is None else environ
    service_key = environ.get("POS_INVOICE_SERVICE_KEY", "")
    feedback_key = environ.get("POS_INVOICE_FEEDBACK_KEY", "")
    key_id = environ.get("POS_INVOICE_FEEDBACK_KEY_ID", "")
    ttl = environ.get("POS_INVOICE_FEEDBACK_TTL_SECONDS", "")
    url = environ.get("POS_INVOICE_FEEDBACK_URL", "")
    if (not isinstance(service_key, str) or not isinstance(feedback_key, str)
            or not isinstance(key_id, str) or not isinstance(ttl, str) or not isinstance(url, str)
            or not re.fullmatch(r"[!-~]{32,4096}", service_key)
            or not 32 <= len(feedback_key.encode()) <= 4096
            or not _key_id.fullmatch(key_id) or not re.fullmatch(r"[0-9]{2,8}", ttl)
            or not 60 <= int(ttl) <= 2678400
            or environ.get("POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT") != FEEDBACK_CONTRACT):
        raise _unavailable()
    customer_keys = [getattr(settings, name, None) for name in ("SECRET_KEY", "SECRET_KEY_512", "POS_INVOICE_KEY")]
    forbidden = [value for value in customer_keys if isinstance(value, str) and value]
    if (len(forbidden) != 3 or hmac.compare_digest(service_key.encode(), feedback_key.encode())
            or any(hmac.compare_digest(value.encode(), key.encode()) for value in forbidden for key in (service_key, feedback_key))):
        raise _unavailable()
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or len(url) > 1024):
            raise ValueError()
    except (ValueError, TypeError):
        raise _unavailable() from None
    return service_key, feedback_key, key_id, int(ttl), parsed


def _checked_id(value):
    if not isinstance(value, str) or not _identifier.fullmatch(value) or int(value) > 9223372036854775807:
        raise falcon.HTTPBadRequest(title="Invalid invoice reference")
    return value


def require_invoice_scope(req, kind, environ=None):
    _scope.set(None)
    service_key, feedback_key, key_id, ttl, url = _configuration(environ)
    supplied = req.get_header("X-POS-Invoice-Key") or ""
    if (not isinstance(supplied, str) or len(supplied) > 4096
            or not hmac.compare_digest(supplied.encode(), service_key.encode())
            or req.get_header("X-POS-Invoice-Contract") != INVOICE_CONTRACT
            or req.get_header("X-POS-Feedback-Contract") != FEEDBACK_CONTRACT
            or req.get_param("pos_token") is not None):
        raise falcon.HTTPUnauthorized(title="Private invoice authorization required")
    if set(req.params) != {"order_id"} or not isinstance(req.params.get("order_id"), str):
        raise falcon.HTTPBadRequest(title="Invalid invoice parameters")
    nonce = req.get_header("X-POS-Invoice-Nonce") or ""
    request_id = req.get_header("X-Request-ID") or ""
    operator_id = req.get_header("X-POS-Operator-ID") or ""
    if (kind not in ("store", "online", "same-day")
            or not re.fullmatch(r"[A-Za-z0-9_-]{32}", nonce)
            or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", request_id)):
        raise falcon.HTTPBadRequest(title="Invalid invoice correlation")
    value = {
        "kind": kind, "order_id": _checked_id(req.get_param("order_id")),
        "operator_id": _checked_id(operator_id), "request_id": request_id,
        "nonce": nonce, "service_key": service_key, "feedback_key": feedback_key,
        "key_id": key_id, "ttl": ttl, "feedback_url": url,
    }
    _scope.set(value)
    return value


def _encoded(value):
    raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def feedback_url(order_id, now=None):
    scope = _scope.get()
    if not scope or _checked_id(str(order_id)) != scope["order_id"]:
        raise _unavailable()
    issued = int(time.time()) if now is None else int(now)
    header = _encoded({"alg": "HS256", "typ": "JWT", "kid": scope["key_id"]})
    payload = _encoded({
        "v": 1, "iss": FEEDBACK_ISSUER, "aud": FEEDBACK_AUDIENCE,
        "purpose": "nps", "type": "nps", "order_id": scope["order_id"],
        "iat": issued, "exp": issued + scope["ttl"], "jti": secrets.token_hex(16),
    })
    message = header + "." + payload
    signature = base64.urlsafe_b64encode(hmac.new(scope["feedback_key"].encode(), message.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    url = scope["feedback_url"]
    return urlunsplit((url.scheme, url.netloc, url.path, "", "feedback_proof=" + message + "." + signature))


def stamp_invoice_response(resp, html, scope):
    digest = hashlib.sha256(html.encode("utf-8")).hexdigest()
    message = "\n".join((INVOICE_CONTRACT, FEEDBACK_CONTRACT, scope["kind"], scope["order_id"],
                         scope["operator_id"], scope["request_id"], scope["nonce"], digest))
    proof = hmac.new(scope["service_key"].encode(), message.encode(), hashlib.sha256).hexdigest()
    resp.set_header("X-POS-Invoice-Contract", INVOICE_CONTRACT)
    resp.set_header("X-POS-Feedback-Contract", FEEDBACK_CONTRACT)
    resp.set_header("X-POS-Invoice-Nonce", scope["nonce"])
    resp.set_header("X-POS-Invoice-Proof", proof)
    resp.set_header("Cache-Control", "no-store")


def clear_invoice_scope():
    _scope.set(None)


def invoice_log_event(runtime=False):
    context = _scope.get() or {}
    return {"module": "checkout", "resource": "tax-invoice",
            "eventId": "checkout.tax-invoice.runtime-error" if runtime else "checkout.tax-invoice.source-error",
            "requestId": context.get("request_id"), "userId": context.get("operator_id")}


class _ClosedInvoiceLogger:
    def _event(self):
        logging.getLogger("pos.invoice").warning(json.dumps(invoice_log_event(), separators=(",", ":")))

    def debug(self, *_args, **_kwargs):
        pass

    def info(self, *_args, **_kwargs):
        pass

    def error(self, *_args, **_kwargs):
        self._event()

    warning = error
    exception = error


def safe_invoice_logger():
    return _ClosedInvoiceLogger()
