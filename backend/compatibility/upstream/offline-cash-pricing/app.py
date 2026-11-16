"""An isolated WSGI resource; never mount behind legacy body/query logging."""

from __future__ import annotations

import hmac
import json
import re
import time
import uuid
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from budget import check_deadline, request_budget
from pricing_service import build_snapshot, freeze_settings
from source_calculator import PricingError

PATH = "/internal/pos/offline-cash/prices"
FIELDS = {
    "snapshotId",
    "operatorId",
    "storeId",
    "counterId",
    "productIds",
    "quantities",
    "businessDate",
    "issuedAt",
    "expiresAt",
}
IDENTIFIER = re.compile(r"^[1-9][0-9]{0,19}$")


def valid_id(value):
    return (
        isinstance(value, str)
        and bool(IDENTIFIER.fullmatch(value))
        and int(value) <= 18446744073709551615
    )


def validate_request(value, operator, now, business_zone):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise PricingError("INVALID_REQUEST", 400)
    try:
        if str(uuid.UUID(value["snapshotId"])) != value["snapshotId"]:
            raise ValueError()
        if not all(
            valid_id(value[name]) for name in ("operatorId", "storeId", "counterId")
        ):
            raise ValueError()
        if operator != value["operatorId"]:
            raise PricingError("OPERATOR_SCOPE_MISMATCH", 403)
        products, quantities = value["productIds"], value["quantities"]
        if (
            not isinstance(products, list)
            or not 1 <= len(products) <= 1000
            or not all(map(valid_id, products))
            or len(set(products)) != len(products)
        ):
            raise ValueError()
        if (
            not isinstance(quantities, list)
            or not 1 <= len(quantities) <= 99
            or any(type(q) is not int or not 1 <= q <= 99 for q in quantities)
            or len(set(quantities)) != len(quantities)
        ):
            raise ValueError()
        issued, expires = value["issuedAt"], value["expiresAt"]
        if (
            type(issued) is not int
            or type(expires) is not int
            or abs(issued - now) > 60000
            or expires <= now
            or not 0 < expires - issued <= 8 * 3600000
        ):
            raise ValueError()
        day = date.fromisoformat(value["businessDate"])
        if day.isoformat() != value["businessDate"] or any(
            datetime.fromtimestamp(stamp / 1000, timezone.utc)
            .astimezone(business_zone)
            .date()
            != day
            for stamp in (now, issued, expires - 1)
        ):
            raise ValueError()
    except (TypeError, ValueError, KeyError, OverflowError, AttributeError):
        raise PricingError("INVALID_REQUEST", 400) from None
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PricingError("INVALID_REQUEST", 400)
        result[key] = value
    return result


def create_app(
    source_root,
    settings,
    session_factory,
    service_key,
    *,
    business_timezone="Asia/Kolkata",
    clock=lambda: int(time.time() * 1000),
    emit=lambda _event: None,
):
    frozen = freeze_settings(settings)
    business_zone = ZoneInfo(business_timezone)

    def handle(body, operator):
        request = validate_request(body, operator, clock(), business_zone)
        with session_factory() as executor:
            return build_snapshot(source_root, frozen, executor, request)

    return create_private_resource(PATH, service_key, handle, emit=emit)


def create_private_resource(
    path,
    service_key,
    handle,
    *,
    emit=lambda _event: None,
    resource="offline-cash-prices",
):
    if not isinstance(service_key, str) or not re.fullmatch(
        r"[\x21-\x7e]{32,4096}", service_key
    ):
        raise PricingError("SOURCE_CONFIGURATION_UNSUPPORTED", 503)

    def application(environ, start_response):
        request_id = str(uuid.uuid4())
        supplied_request_id = environ.get("HTTP_X_REQUEST_ID", "")
        try:
            parsed = uuid.UUID(supplied_request_id)
            if str(parsed) == supplied_request_id:
                request_id = supplied_request_id
        except (ValueError, AttributeError, TypeError):
            pass
        operator, status, code, result = None, 500, "SOURCE_UNAVAILABLE", None
        try:
            if environ.get("PATH_INFO") != path or environ.get("QUERY_STRING", ""):
                raise PricingError("RESOURCE_NOT_FOUND", 404)
            if environ.get("REQUEST_METHOD") != "POST":
                raise PricingError("METHOD_NOT_ALLOWED", 405)
            provided = environ.get("HTTP_X_POS_OFFLINE_KEY", "")
            if (
                not isinstance(provided, str)
                or not provided.isascii()
                or not hmac.compare_digest(service_key, provided)
            ):
                raise PricingError("SOURCE_ACCESS_DENIED", 403)
            operator = environ.get("HTTP_X_POS_OPERATOR_ID")
            if not valid_id(operator):
                operator = None
                raise PricingError("SOURCE_ACCESS_DENIED", 403)
            content_type = environ.get("CONTENT_TYPE", "").lower().replace(" ", "")
            if content_type not in (
                "application/json",
                "application/json;charset=utf-8",
            ):
                raise PricingError("UNSUPPORTED_MEDIA_TYPE", 415)
            length_text = environ.get("CONTENT_LENGTH", "")
            if not isinstance(length_text, str) or not re.fullmatch(
                r"[0-9]{1,6}", length_text
            ):
                raise PricingError("INVALID_REQUEST", 400)
            length = int(length_text)
            if not 1 <= length <= 128000:
                raise PricingError("REQUEST_TOO_LARGE", 413)
            raw = environ["wsgi.input"].read(length)
            if len(raw) != length:
                raise PricingError("INVALID_REQUEST", 400)
            try:
                body = json.loads(
                    raw.decode("utf-8"),
                    object_pairs_hook=unique_object,
                    parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
                )
            except (ValueError, UnicodeError, RecursionError):
                raise PricingError("INVALID_REQUEST", 400) from None
            with request_budget():
                result = handle(body, operator)
                check_deadline()
                encoded = json.dumps(
                    result, ensure_ascii=False, separators=(",", ":"), allow_nan=False
                ).encode("utf-8")
                check_deadline()
            if len(encoded) > 8000000:
                raise PricingError("SNAPSHOT_TOO_LARGE", 409)
            status, code = 200, "OK"
        except PricingError as error:
            status, code = error.status, error.code
        except Exception:
            # Never serialize source exceptions, SQL, credentials, cart data or names.
            status, code = 503, "SOURCE_UNAVAILABLE"
        if status != 200:
            encoded = json.dumps(
                {"error": {"code": code, "requestId": request_id}},
                separators=(",", ":"),
            ).encode("utf-8")
        emit(
            {
                "module": "checkout",
                "resource": resource,
                "eventId": "checkout." + resource + ".completed",
                "eventInstanceId": str(uuid.uuid4()),
                "requestId": request_id,
                "userId": operator,
                "statusCode": status,
                "resultCode": code,
            }
        )
        phrases = {
            200: "OK",
            400: "Bad Request",
            403: "Forbidden",
            404: "Not Found",
            405: "Method Not Allowed",
            409: "Conflict",
            413: "Content Too Large",
            415: "Unsupported Media Type",
            500: "Internal Server Error",
            503: "Service Unavailable",
        }
        start_response(
            f"{status} {phrases[status]}",
            [
                ("Content-Type", "application/json; charset=utf-8"),
                ("Content-Length", str(len(encoded))),
                ("Cache-Control", "private, no-store"),
                ("X-Content-Type-Options", "nosniff"),
                ("X-Request-ID", request_id),
            ],
        )
        return [encoded]

    return application
