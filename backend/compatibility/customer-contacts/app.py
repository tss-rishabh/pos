"""Isolated WSGI boundary. No query/body/cookie/credential/raw exception logging."""

import hmac
import json
import re
import uuid

from contract import CONTRACT, PATH, SECRET, ContactError, valid_id, valid_uuid


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
        result[key] = value
    return result


def create_app(service, service_key, *, emit=lambda _event: None):
    if not isinstance(service_key, str) or not SECRET.fullmatch(service_key):
        raise ContactError("CONTACT_EFFECTS_CONFIGURATION_INVALID")

    def application(environ, start_response):
        if (
            environ.get("PATH_INFO") == "/healthz"
            and environ.get("REQUEST_METHOD") == "GET"
            and not environ.get("QUERY_STRING", "")
        ):
            encoded = (
                b'{"status":"configured","contract":"pos-customer-contact-effects-v1"}'
            )
            start_response(
                "200 OK",
                [
                    ("Content-Type", "application/json"),
                    ("Content-Length", str(len(encoded))),
                    ("Cache-Control", "no-store"),
                ],
            )
            return [encoded]
        status, code, result, operator = 503, "CONTACT_EFFECTS_UNAVAILABLE", None, None
        request = environ.get("HTTP_X_REQUEST_ID", "")
        if not valid_uuid(request):
            request = str(uuid.uuid4())
        try:
            if environ.get("PATH_INFO") != PATH or environ.get("QUERY_STRING", ""):
                raise ContactError("RESOURCE_NOT_FOUND", 404)
            if environ.get("REQUEST_METHOD") != "POST":
                raise ContactError("METHOD_NOT_ALLOWED", 405)
            supplied = environ.get("HTTP_X_CUSTOMER_CONTACT_KEY", "")
            if (
                not isinstance(supplied, str)
                or not supplied.isascii()
                or not hmac.compare_digest(service_key, supplied)
                or environ.get("HTTP_X_CUSTOMER_CONTACT_CONTRACT") != CONTRACT
            ):
                raise ContactError("CONTACT_EFFECTS_ACCESS_DENIED", 403)
            content = environ.get("CONTENT_TYPE", "").lower().replace(" ", "")
            if content not in ["application/json", "application/json;charset=utf-8"]:
                raise ContactError("UNSUPPORTED_MEDIA_TYPE", 415)
            length = environ.get("CONTENT_LENGTH", "")
            if (
                not isinstance(length, str)
                or not re.fullmatch(r"[0-9]{1,6}", length)
                or not 1 <= int(length) <= 256000
            ):
                raise ContactError("REQUEST_TOO_LARGE", 413)
            raw = environ["wsgi.input"].read(int(length))
            if len(raw) != int(length):
                raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400)
            try:
                body = json.loads(
                    raw.decode(),
                    object_pairs_hook=unique_object,
                    parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
                )
            except (ValueError, UnicodeError, RecursionError):
                raise ContactError("CONTACT_EFFECTS_REQUEST_INVALID", 400) from None
            result = service.accept(body)
            candidate = body.get("payload", {}).get("operatorId")
            if valid_id(candidate):
                operator = candidate
            status, code = 200, "ACCEPTED"
        except ContactError as error:
            status, code = error.status, error.code
        except Exception:
            pass
        emit(
            {
                "module": "customer-contacts",
                "resource": "customer-contact-source-effects",
                "eventId": "customer-contacts.customer-contact-source-effects.accepted"
                if status == 200
                else "customer-contacts.customer-contact-source-effects.rejected",
                "eventInstanceId": str(uuid.uuid4()),
                "requestId": request,
                "userId": operator,
                "statusCode": status,
                "resultCode": code,
            }
        )
        encoded = json.dumps(
            result
            if status == 200
            else {"error": {"code": code, "requestId": request}},
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
        phrases = {
            200: "OK",
            400: "Bad Request",
            403: "Forbidden",
            404: "Not Found",
            405: "Method Not Allowed",
            409: "Conflict",
            413: "Content Too Large",
            415: "Unsupported Media Type",
            503: "Service Unavailable",
        }
        start_response(
            str(status) + " " + phrases.get(status, "Service Unavailable"),
            [
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(encoded))),
                ("Cache-Control", "no-store"),
                ("X-Request-ID", request),
                ("X-Content-Type-Options", "nosniff"),
            ],
        )
        return [encoded]

    return application
