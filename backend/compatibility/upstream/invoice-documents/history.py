"""Purpose-bound warehouse history; never execute a lifetime MySQL fallback."""
import base64
import contextvars
import datetime
import hashlib
import hmac
import json
import re
import time
import falcon
from pos_invoice_documents_native import native_snapshot

CONTRACT = "pos-online-invoice-history-v1"
COUNT_SQL = "@@COUNT_SQL@@"
CURRENT_SQL = []  # @@CURRENT_SQL@@
_active = contextvars.ContextVar("invoice_history", default=None)


def unavailable():
    return falcon.HTTPServiceUnavailable(title="Invoice unavailable", description="The invoice history and native source snapshot could not be verified.")


def normalized(value):
    return " ".join(str(value).lower().split())


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate proof field")
        value[key] = item
    return value


def _identifier(value, zero=False):
    return isinstance(value, str) and bool(re.fullmatch(r"(?:0|[1-9][0-9]{0,18})" if zero else r"[1-9][0-9]{0,18}", value)) and int(value) <= 9223372036854775807


def require_history(req, invoice_scope, reader):
    _active.set(None)
    capability = req.get_header("X-POS-Invoice-History") or ""
    try:
        if not isinstance(capability, str) or len(capability) > 8192:
            raise ValueError()
        contract, payload, signature = capability.split(".")
        if contract != CONTRACT or not re.fullmatch(r"[A-Za-z0-9_-]{1,4096}", payload) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", signature):
            raise ValueError()
        actual = base64.urlsafe_b64decode(signature + "=")
        expected = hmac.new(invoice_scope["service_key"].encode(), (contract + "." + payload).encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(actual, expected):
            raise ValueError()
        value = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)), object_pairs_hook=_unique)
        if set(value) != {"v", "purpose", "contract", "orderId", "operatorId", "storeId", "customerId", "orderCount", "nativeSnapshot", "nonce", "requestId", "issuedAt", "expiresAt", "publication"}:
            raise ValueError()
        if type(value["v"]) is not int or value["v"] != 1 or value["purpose"] != "online-invoice-history" or value["contract"] != CONTRACT:
            raise ValueError()
        if any(not _identifier(value[key]) for key in ("orderId", "operatorId", "storeId", "customerId")) or not _identifier(value["orderCount"], True):
            raise ValueError()
        if value["orderId"] != invoice_scope["order_id"] or value["operatorId"] != invoice_scope["operator_id"] or value["nonce"] != invoice_scope["nonce"] or value["requestId"] != invoice_scope["request_id"] or not re.fullmatch(r"[a-f0-9]{64}", value["nativeSnapshot"]):
            raise ValueError()
        now = int(time.time())
        if type(value["issuedAt"]) is not int or type(value["expiresAt"]) is not int or not 0 < value["expiresAt"] - value["issuedAt"] <= 30 or value["issuedAt"] > now + 5 or value["expiresAt"] <= now:
            raise ValueError()
        publication = value["publication"]
        if not isinstance(publication, dict) or set(publication) != {"generationId", "sourceSnapshotId", "sourceSnapshotAt", "sourceCdcWatermark", "publishedAt", "customerSourceRows", "customerOrdersHash"}:
            raise ValueError()
        if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", publication["generationId"]) or not re.fullmatch(r"[A-Za-z0-9._:-]{16,128}", publication["sourceSnapshotId"]) or not _identifier(publication["customerSourceRows"]) or int(value["orderCount"]) > int(publication["customerSourceRows"]) or not re.fullmatch(r"[a-f0-9]{64}", publication["customerOrdersHash"]):
            raise ValueError()
        dates = [datetime.datetime.fromisoformat(publication[key].replace("Z", "+00:00")) for key in ("sourceSnapshotAt", "sourceCdcWatermark", "publishedAt")]
        if any(value.tzinfo is None for value in dates):
            raise ValueError()
        times = [value.timestamp() for value in dates]
        if any(stamp > now + 5 for stamp in times) or min(times[1:]) < times[0] or times[2] + 5 < times[1] or now - times[0] > 3605:
            raise ValueError()
        snapshot = native_snapshot(reader, value)
        if snapshot["customerId"] != value["customerId"] or not hmac.compare_digest(snapshot["binding"], value["nativeSnapshot"]):
            raise ValueError()
        value["capability"] = capability
        _active.set(value)
        return value
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise unavailable() from None


def clear_history():
    _active.set(None)


def stamp_history(resp, html, value, key):
    message = "\n".join((CONTRACT, hashlib.sha256(value["capability"].encode()).hexdigest(), hashlib.sha256(html.encode()).hexdigest()))
    resp.set_header("X-POS-Invoice-History-Contract", CONTRACT)
    resp.set_header("X-POS-Invoice-History-Proof", hmac.new(key.encode(), message.encode(), hashlib.sha256).hexdigest())


class CountResult:
    def __init__(self, value):
        self.value = value

    def mappings(self):
        return self

    def first(self):
        return {"count": self.value}


class InvoiceHistoryReader:
    def __init__(self, reader):
        self.reader = reader

    def execute(self, statement, parameters=None, *args, **kwargs):
        query, scope = normalized(statement), _active.get()
        if query == normalized(COUNT_SQL):
            if scope is None or not isinstance(parameters, dict) or set(parameters) != {"user_id"} or str(parameters["user_id"]) != scope["customerId"]:
                raise unavailable()
            return CountResult(int(scope["orderCount"]))
        # A future historical orders query must never bypass the frozen count.
        if "from orders" in query and query != "select * from orders where id = :order_id limit 1":
            raise unavailable()
        if scope is not None:
            allowed = {normalized(value.replace("%d", scope["orderId"]).replace("%%", "%")) for value in CURRENT_SQL}
            if query not in allowed:
                raise unavailable()
            if "from orders" in query and (not isinstance(parameters, dict) or str(parameters.get("order_id")) != scope["orderId"]):
                raise unavailable()
        return self.reader.execute(statement, parameters, *args, **kwargs)

    def query(self, model):
        if _active.get() is not None and getattr(model, "__tablename__", None) != "has_addresses":
            raise unavailable()
        return self.reader.query(model)

    def expunge(self, value):
        return self.reader.expunge(value)
