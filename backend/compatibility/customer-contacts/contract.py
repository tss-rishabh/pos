"""Private purpose contract only; no source app imports, network or startup side effects."""

import hashlib
import hmac
import json
import re
import uuid

CONTRACT = "pos-customer-contact-effects-v1"
PATH = "/internal/pos/customer-contact-effects"
ID = re.compile(r"^[1-9][0-9]{0,18}$")
SECRET = re.compile(r"^[\x21-\x7e]{32,4096}$")
FIELDS = {
    "contract",
    "operationId",
    "challengeId",
    "operatorId",
    "customerId",
    "storeId",
    "checkoutId",
    "kind",
    "oldEmail",
    "oldTelephone",
    "newValue",
    "refundRemails",
    "requestId",
}


class ContactError(Exception):
    def __init__(self, code="CONTACT_EFFECTS_UNAVAILABLE", status=503):
        super().__init__(code)
        self.code, self.status = code, status


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def valid_id(value):
    return (
        isinstance(value, str)
        and bool(ID.fullmatch(value))
        and int(value) <= 9223372036854775807
    )


def canonical(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def payload_hash(secret, payload):
    if not isinstance(secret, str) or not SECRET.fullmatch(secret):
        raise ContactError("CONTACT_EFFECTS_CONFIGURATION_INVALID")
    # Node operationHash fixes these two envelope keys in insertion order,
    # while recursively sorting only the payload properties.
    raw = (
        '{"kind":' + json.dumps(CONTRACT) + ',"input":' + canonical(payload) + "}"
    ).encode()
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def validate_request(body, secret):
    if not isinstance(body, dict) or set(body) != {"deliveryId", "bodyHash", "payload"}:
        raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
    payload = body["payload"]
    if (
        not valid_uuid(body["deliveryId"])
        or not isinstance(body["bodyHash"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", body["bodyHash"])
        or not isinstance(payload, dict)
        or set(payload) != FIELDS
        or payload["contract"] != CONTRACT
        or not all(
            valid_uuid(payload[key])
            for key in ["operationId", "challengeId", "checkoutId"]
        )
        or not all(
            valid_id(payload[key]) for key in ["operatorId", "customerId", "storeId"]
        )
        or payload["kind"] not in ["telephone", "email"]
    ):
        raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
    for name, limit in [("oldEmail", 96), ("oldTelephone", 32), ("newValue", 96)]:
        if not isinstance(payload[name], str) or len(payload[name]) > limit:
            raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
    if not payload["newValue"] or payload["newValue"] != payload["newValue"].strip():
        raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
    if payload["kind"] == "telephone":
        if not re.fullmatch(r"[6-9][0-9]{9}", payload["newValue"]):
            raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
    elif (
        not re.fullmatch(
            r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}",
            payload["newValue"],
        )
        or payload["newValue"] != payload["newValue"].lower()
    ):
        raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
    remails = payload["refundRemails"]
    if (
        not isinstance(remails, list)
        or len(remails) > 1000
        or (payload["kind"] == "telephone" and remails)
    ):
        raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
    seen = set()
    for item in remails:
        if (
            not isinstance(item, dict)
            or set(item) != {"orderId", "refundRequestId"}
            or not all(valid_id(value) for value in item.values())
        ):
            raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
        pair = (item["orderId"], item["refundRequestId"])
        if pair in seen:
            raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
        seen.add(pair)
    request = payload["requestId"]
    if request is not None and (
        not isinstance(request, str)
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", request)
    ):
        raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
    if not hmac.compare_digest(body["bodyHash"], payload_hash(secret, payload)):
        raise ContactError("CONTACT_EFFECTS_PROOF_INVALID", 403)
    return body


def acknowledgement(body):
    return {
        "contract": CONTRACT,
        "deliveryId": body["deliveryId"],
        "operationId": body["payload"]["operationId"],
        "bodyHash": body["bodyHash"],
        "status": "accepted",
    }
