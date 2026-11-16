"""Body/header-only bounded provider leaves; no source application startup/imports."""

import base64
import hashlib
import hmac
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from sqlalchemy import and_, select

from contract import ContactError, valid_uuid
from models import alternatives, orders, refunds, users

KINDS = {
    "auth-cache",
    "payment-customer",
    "clevertap",
    "moengage",
    "support",
    "refund-notice",
}
TASKS = {
    "clevertap": "pos.customer_contacts.clevertap_v1",
    "moengage": "pos.customer_contacts.moengage_v1",
    "support": "pos.customer_contacts.support_v1",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _msg, _headers, _url):
        raise ContactError("CONTACT_EFFECTS_PROVIDER_UNCERTAIN")


def https_url(raw):
    try:
        url = urllib.parse.urlparse(raw)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError()
    except Exception:
        raise ContactError("CONTACT_EFFECTS_CONFIGURATION_INVALID") from None
    return raw


def source_customer_token(customer, keys, now=None):
    if (
        customer["status"] != 1
        or customer["is_block"] == 1
        or customer["is_disabled"] == 1
    ):
        raise ContactError("CONTACT_EFFECTS_CUSTOMER_UNAVAILABLE")
    two = bool(customer["is_two_fa"])
    key = keys["hs512" if two else "hs256"]
    if not isinstance(key, str) or len(key) < 32:
        raise ContactError("CONTACT_EFFECTS_CONFIGURATION_INVALID")
    stamp = int(time.time()) if now is None else now

    def encoded(value):
        return (
            base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode())
            .rstrip(b"=")
            .decode()
        )

    unsigned = (
        encoded({"alg": "HS512" if two else "HS256", "typ": "JWT"})
        + "."
        + encoded({"sub": str(customer["id"]), "iat": stamp, "exp": stamp + 600})
    )
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(
                key.encode(),
                unsigned.encode(),
                hashlib.sha512 if two else hashlib.sha256,
            ).digest()
        )
        .rstrip(b"=")
        .decode()
    )
    return ("2f." if two else "") + unsigned + "." + signature


class SourceAdapters:
    def __init__(
        self,
        sessions,
        redis,
        celery,
        keys,
        *,
        payment_url,
        refund_url,
        default_queue,
        support_queue,
        opener=None,
    ):
        self.sessions, self.redis, self.celery, self.keys = (
            sessions,
            redis,
            celery,
            keys,
        )
        self.payment_url, self.refund_url = (
            https_url(payment_url),
            https_url(refund_url),
        )
        if not all(
            isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value)
            for value in [default_queue, support_queue]
        ):
            raise ContactError("CONTACT_EFFECTS_CONFIGURATION_INVALID")
        self.default_queue, self.support_queue = default_queue, support_queue
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def _post(self, url, body=None, headers=None):
        request = urllib.request.Request(
            url,
            data=json.dumps(body, separators=(",", ":")).encode()
            if body is not None
            else b"",
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        try:
            with self.opener.open(request, timeout=5) as response:
                # Never read/log a provider response body or forward a redirect.
                return "accepted" if response.status == 200 else "uncertain"
        except urllib.error.HTTPError as error:
            error.close()
            return (
                "rejected"
                if 400 <= error.code < 500 and error.code not in [408, 429]
                else "uncertain"
            )
        except Exception:
            return "uncertain"

    def __call__(self, kind, job_id, payload, detail):
        if kind not in KINDS or not valid_uuid(job_id):
            return "rejected"
        user_id = int(payload["customerId"])
        if kind == "auth-cache":
            self.redis.delete("auth_user:" + str(user_id))
            return "accepted"  # Deleting an already absent cache key is equivalent.
        if kind == "payment-customer":
            with self.sessions() as session:
                customer = (
                    session.execute(select(users).where(users.c.id == user_id))
                    .mappings()
                    .first()
                )
            if not customer:
                return "rejected"
            token = source_customer_token(customer, self.keys)
            return self._post(
                self.payment_url,
                headers={"Authorization": token, "Idempotency-Key": job_id},
            )
        if kind in TASKS:
            args = [[user_id], user_id] if kind == "clevertap" else [user_id]
            result = self.celery.send_task(
                TASKS[kind],
                args=args,
                task_id=job_id,
                queue=self.support_queue if kind == "support" else self.default_queue,
                retry=False,
                argsrepr="[private customer identifiers]",
                kwargsrepr="{}",
                ignore_result=True,
                headers={
                    "pos-contact-purpose": "pos-customer-contact-tasks-v1",
                    "pos-contact-operator-id": payload["operatorId"],
                    "pos-contact-customer-id": payload["customerId"],
                    "pos-contact-request-id": payload["requestId"] or job_id,
                    "pos-contact-operation-id": payload["operationId"],
                    "request-id": payload["requestId"],
                },
            )
            return "accepted" if result.id == job_id else "uncertain"
        with self.sessions() as session:
            eligible = session.execute(
                select(alternatives.c.id)
                .join(orders, orders.c.id == alternatives.c.order_id)
                .join(refunds, refunds.c.id == alternatives.c.refund_request_id)
                .where(
                    and_(
                        orders.c.user_id == user_id,
                        alternatives.c.order_id == int(detail["orderId"]),
                        alternatives.c.refund_request_id
                        == int(detail["refundRequestId"]),
                        alternatives.c.status == "PENDING",
                        refunds.c.is_completed == "FAILED",
                    )
                )
                .limit(1)
            ).first()
        if not eligible:
            return "accepted"  # A refund resolved since commit no longer needs a failed-refund notice.
        return self._post(
            self.refund_url,
            {
                "order_id": detail["orderId"],
                "refund_request_id": detail["refundRequestId"],
            },
            headers={"Idempotency-Key": job_id},
        )
