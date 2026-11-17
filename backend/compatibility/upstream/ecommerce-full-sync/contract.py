"""Purpose-specific full-catalog protocol. No legacy app imports or network work."""

import hashlib
import hmac
import json
import re
import uuid

CONTRACT = "pos-ecommerce-full-sync-v1"
PATH = "/internal/pos/ecommerce-full-syncs"
FIELDS = {"contract", "operationId", "storeId", "actorId", "requestId"}


class SyncError(Exception):
    def __init__(self, code="ECOMMERCE_FULL_SYNC_UNAVAILABLE", status=503):
        super().__init__(code)
        self.code, self.status = code, status


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def valid_id(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[1-9][0-9]{0,19}", value)) and int(value) <= 18446744073709551615


def validate(body):
    if (not isinstance(body, dict) or set(body) != FIELDS or body["contract"] != CONTRACT
            or not valid_uuid(body["operationId"]) or not valid_id(body["storeId"])
            or not valid_id(body["actorId"]) or (body["requestId"] is not None and
            (not isinstance(body["requestId"], str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", body["requestId"])))):
        raise SyncError("ECOMMERCE_FULL_SYNC_REQUEST_INVALID", 400)
    # Match the Node body's insertion order, including an explicit null correlation.
    return {name: body[name] for name in ["contract", "operationId", "storeId", "actorId", "requestId"]}


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def body_hash(body):
    return hashlib.sha256(encode(validate(body))).hexdigest()


def request_signature(secret, timestamp, method, path, raw):
    digest = hashlib.sha256(raw).hexdigest()
    return hmac.new(secret.encode(), f"{CONTRACT}\n{timestamp}\n{method}\n{path}\n{digest}".encode(), hashlib.sha256).hexdigest()


def response_signature(secret, operation_id, raw):
    digest = hashlib.sha256(raw).hexdigest()
    return hmac.new(secret.encode(), f"{CONTRACT}\nresponse\n{operation_id}\n{digest}".encode(), hashlib.sha256).hexdigest()


def validate_proof(proof):
    if not isinstance(proof, dict) or set(proof) != {"mongoWrites", "redisWrites", "cdnBatches", "catalogDigest"}:
        raise SyncError("ECOMMERCE_FULL_SYNC_PROOF_INVALID")
    if any(type(proof[name]) is not int or not 0 <= proof[name] <= 9007199254740991 for name in ["mongoWrites", "redisWrites", "cdnBatches"]):
        raise SyncError("ECOMMERCE_FULL_SYNC_PROOF_INVALID")
    if not isinstance(proof["catalogDigest"], str) or not re.fullmatch(r"[a-f0-9]{64}", proof["catalogDigest"]):
        raise SyncError("ECOMMERCE_FULL_SYNC_PROOF_INVALID")
    return proof


def create_app(store, secret, clock, emit=lambda _event: None):
    if not isinstance(secret, str) or not 32 <= len(secret) <= 256:
        raise SyncError("ECOMMERCE_FULL_SYNC_CONFIGURATION_INVALID")

    def application(env, start_response):
        operation_id = ""
        context = {"requestId": None, "userId": None}
        try:
            path, method = env.get("PATH_INFO", ""), env.get("REQUEST_METHOD", "")
            if env.get("QUERY_STRING") or method not in {"GET", "POST"}:
                raise SyncError("ECOMMERCE_FULL_SYNC_REQUEST_INVALID", 400)
            length = int(env.get("CONTENT_LENGTH") or "0")
            if length < 0 or length > 2048 or (method == "GET" and length):
                raise SyncError("ECOMMERCE_FULL_SYNC_REQUEST_INVALID", 400)
            raw = env["wsgi.input"].read(length)
            timestamp = env.get("HTTP_X_ECOM_TIMESTAMP", "")
            supplied = env.get("HTTP_X_ECOM_SIGNATURE", "")
            if (not re.fullmatch(r"[0-9]{1,12}", timestamp) or abs(int(timestamp) - int(clock())) > 60
                    or not re.fullmatch(r"[a-f0-9]{64}", supplied)
                    or not hmac.compare_digest(supplied, request_signature(secret, timestamp, method, path, raw))):
                raise SyncError("ECOMMERCE_FULL_SYNC_AUTHENTICATION_REQUIRED", 401)
            if method == "POST" and path == PATH:
                if env.get("CONTENT_TYPE", "").split(";", 1)[0] != "application/json":
                    raise SyncError("ECOMMERCE_FULL_SYNC_REQUEST_INVALID", 400)
                body = validate(json.loads(raw))
                operation_id = body["operationId"]
                if env.get("HTTP_IDEMPOTENCY_KEY") != operation_id:
                    raise SyncError("ECOMMERCE_FULL_SYNC_REQUEST_INVALID", 400)
                result = store.accept(body)
                context = {"requestId": body["requestId"], "userId": body["actorId"]}
                status = 200 if result["status"] == "succeeded" else 202
            elif method == "GET" and path.startswith(PATH + "/"):
                operation_id = path[len(PATH) + 1:]
                if not valid_uuid(operation_id) or env.get("HTTP_IDEMPOTENCY_KEY") != operation_id:
                    raise SyncError("ECOMMERCE_FULL_SYNC_REQUEST_INVALID", 400)
                result = store.read(operation_id)
                if result:
                    context = store.trace(operation_id)
                status = 200 if result else 404
                if result is None:
                    result = {"contract": CONTRACT, "operationId": operation_id, "error": "ECOMMERCE_FULL_SYNC_NOT_FOUND"}
            else:
                raise SyncError("ECOMMERCE_FULL_SYNC_NOT_FOUND", 404)
        except SyncError as error:
            result, status = {"error": error.code}, error.status
        except Exception:
            result, status = {"error": "ECOMMERCE_FULL_SYNC_UNAVAILABLE"}, 503
        raw = encode(result)
        headers = [("Content-Type", "application/json"), ("Cache-Control", "private, no-store"), ("Content-Length", str(len(raw)))]
        if valid_uuid(operation_id):
            headers.append(("X-Ecom-Signature", response_signature(secret, operation_id, raw)))
        start_response(str(status) + " " + {200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 503: "Service Unavailable"}[status], headers)
        # Request paths/bodies, signatures, product payloads and errors are excluded.
        emit({"module": "administration", "resource": "ecommerce-full-sync-http", "eventId": "administration.ecommerce-full-sync-http.completed", "eventInstanceId": operation_id if valid_uuid(operation_id) else str(uuid.uuid4()), **context, "statusCode": status})
        return [raw]

    return application
