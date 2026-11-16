"""Authenticated selected-document scope. No HTTP-supplied line IDs are trusted."""
import base64
import contextvars
import hashlib
import hmac
import json
import re
import time
import falcon
from pos_invoice_documents_native import native_snapshot

CONTRACT = "pos-scoped-invoice-v1"
_active = contextvars.ContextVar("selected_invoice", default=None)


def unavailable():
    return falcon.HTTPServiceUnavailable(title="Invoice unavailable", description="The selected invoice scope could not be verified.")


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def require_selected(req, invoice_scope, reader):
    _active.set(None)
    token = req.get_header("X-POS-Invoice-Scope") or ""
    try:
        contract, body, signature = token.split(".")
        if contract != CONTRACT or not re.fullmatch(r"[A-Za-z0-9_-]{1,4096}", body) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", signature):
            raise ValueError()
        message = contract + "." + body
        if not hmac.compare_digest(base64.urlsafe_b64decode(signature + "="), hmac.new(invoice_scope["service_key"].encode(), message.encode(), hashlib.sha256).digest()):
            raise ValueError()
        value = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)), object_pairs_hook=unique)
        if set(value) != {"v", "purpose", "contract", "kind", "orderId", "operatorId", "storeId", "customerId", "nativeSnapshot", "selection", "selectedHash", "selectedCount", "nonce", "requestId", "issuedAt", "expiresAt"}:
            raise ValueError()
        if type(value["v"]) is not int or value["v"] != 1 or value["purpose"] != "scoped-invoice" or value["contract"] != CONTRACT or value["kind"] != "express" or value["selection"] != "store-express-line-items-v1":
            raise ValueError()
        if any(not isinstance(value[key], str) or not re.fullmatch(r"[1-9][0-9]{0,18}", value[key]) or int(value[key]) > 9223372036854775807 for key in ("orderId", "operatorId", "storeId", "customerId")):
            raise ValueError()
        if value["orderId"] != invoice_scope["order_id"] or value["operatorId"] != invoice_scope["operator_id"] or value["nonce"] != invoice_scope["nonce"] or value["requestId"] != invoice_scope["request_id"] or not isinstance(value["nativeSnapshot"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["nativeSnapshot"]):
            raise ValueError()
        now = int(time.time())
        if type(value["issuedAt"]) is not int or type(value["expiresAt"]) is not int or not 0 < value["expiresAt"] - value["issuedAt"] <= 30 or value["issuedAt"] > now + 5 or value["expiresAt"] <= now:
            raise ValueError()
        snapshot = native_snapshot(reader, value, include_parts=True)
        if snapshot["customerId"] != value["customerId"] or not hmac.compare_digest(snapshot["binding"], value["nativeSnapshot"]):
            raise ValueError()
        parts = snapshot["parts"]
        lines = {row[0]: row[1] for row in parts[9]}
        selected = {row[1] for row in parts[10] if row[2] == value["storeId"]}
        if not selected or any(row[1] not in lines or (row[1] in selected and row[2] != value["storeId"]) for row in parts[10]) or any(lines.get(identifier) != "5" for identifier in selected):
            raise ValueError()
        identifiers = [row[0] for row in parts[9] if row[0] in selected]
        digest = hashlib.sha256(json.dumps(identifiers, separators=(",", ":")).encode()).hexdigest()
        if type(value["selectedCount"]) is not int or value["selectedCount"] != len(identifiers) or not isinstance(value["selectedHash"], str) or not hmac.compare_digest(digest, value["selectedHash"]):
            raise ValueError()
        value.update({"ids": identifiers, "is_split": len(identifiers) < len(lines), "capability": token})
        _active.set(value)
        return value
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise unavailable() from None


def selected_ids():
    value = _active.get()
    if value is None:
        raise unavailable()
    return value["ids"]


def selected_store_id():
    selected_ids()
    return _active.get()["storeId"]


def selected_is_split():
    selected_ids()
    return _active.get()["is_split"]


def selected_rows(rows):
    selected = {int(value) for value in selected_ids()}
    if not selected.issubset({int(row["rowid"]) for row in rows}):
        raise unavailable()
    return [row for row in rows if int(row["rowid"]) in selected]


def stamp_selected(resp, html, value, key):
    message = "\n".join((CONTRACT, hashlib.sha256(value["capability"].encode()).hexdigest(), hashlib.sha256(html.encode()).hexdigest()))
    resp.set_header("X-POS-Invoice-Scope-Contract", CONTRACT)
    resp.set_header("X-POS-Invoice-Scope-Proof", hmac.new(key.encode(), message.encode(), hashlib.sha256).hexdigest())


class SelectedReader:
    def __init__(self, reader):
        self.reader = reader

    def query(self, model):
        selected_ids()
        query = self.reader.query(model)
        if getattr(model, "__tablename__", None) in {"order_stores", "pos_terminal_transactions"}:
            query = query.filter(model.store_id == int(_active.get()["storeId"]))
        return query

    def execute(self, *args, **kwargs):
        selected_ids()
        return self.reader.execute(*args, **kwargs)

    def expunge(self, value):
        return self.reader.expunge(value)
