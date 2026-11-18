"""Local-only native scope/reader qualification; renderer is an explicit test seam."""
import hashlib
import json
import re
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
from unittest.mock import patch
import falcon.testing
from sqlalchemy import event, text
import prepare

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent / "invoice-security"


def run(value):
    repository = ROOT.parents[4] / "backend-tss-api_v2"
    builder = prepare.base_builder()
    base_manifest = builder.build()
    original = subprocess.check_output(["git", "show", f"{prepare.COMMIT}:controllers/InvoiceController.py"], cwd=repository, text=True)
    candidate, helper = builder.candidate(original), (BASE / "pos_invoice_security.py").read_text()
    factory = ((BASE / "factory.py").read_text().replace("@@CONTROLLER_SHA256@@", hashlib.sha256(candidate.encode()).hexdigest()).replace("@@HELPER_SHA256@@", hashlib.sha256(helper.encode()).hexdigest()))
    if hashlib.sha256(factory.encode()).hexdigest() != base_manifest["factorySha256"]:
        raise RuntimeError("Private invoice base factory changed")
    settings = ModuleType("settings")
    for name, item in {"SECRET_KEY": "first-customer-signing-key-" * 3, "SECRET_KEY_512": "second-customer-signing-key-" * 3,
        "POS_INVOICE_KEY": "legacy-invoice-key-" * 3, "TIMEZONE_IST": "Asia/Kolkata", "IMAGE_URL": "https://images.example.test/",
        "TSS_STORE_URL": "https://store.example.test/", "TSS_API_URL": "https://api.example.test/", "SKIP_COMPLEMENTARY_PRODUCT_STATUSES": ["CANCELLED"]}.items():
        setattr(settings, name, item)
    environment = {"POS_INVOICE_SERVICE_KEY": value["key"], "POS_INVOICE_FEEDBACK_KEY": "separate-feedback-signing-key-" * 3,
        "POS_INVOICE_FEEDBACK_KEY_ID": "invoice-fixture", "POS_INVOICE_FEEDBACK_TTL_SECONDS": "3600",
        "POS_INVOICE_FEEDBACK_URL": "https://feedback.example.test/invoice-feedback", "POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT": "pos-feedback-proof-v1", "POS_INVOICE_MYSQL_READER_URL": value["url"]}
    with TemporaryDirectory(prefix="isolated-online-invoice-") as temporary:
        root = Path(temporary)
        for name in ("controllers", "models", "constants", "database"):
            (root / name).mkdir()
            (root / name / "__init__.py").write_text("")
        for path in ("models/Order.py", "models/GiftVoucher.py", "models/User.py", "constants/StatusEnum.py", "constants/Constants.py"):
            (root / path).write_bytes(subprocess.check_output(["git", "show", f"{prepare.COMMIT}:{path}"], cwd=repository))
        (root / "controllers/InvoiceController.py").write_text(candidate)
        (root / "controllers/PosInvoiceSecurity.py").write_text(helper)
        (root / "pos_invoice_factory.py").write_text(factory)
        for name, content in prepare.generated_files().items():
            (root / name).write_text(content)
        for name in ("index-shop.html", "old-index.html", "new-index.html"):
            path = root / "templates/Invoicer" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(subprocess.check_output(["git", "show", f"{prepare.COMMIT}:templates/Invoicer/{name}"], cwd=repository))
        with patch.dict(os.environ, environment), patch.dict(sys.modules, {"settings": settings}):
            if "database.database" in sys.modules:
                raise RuntimeError("Invoice probe needs an isolated process")
            sys.path.insert(0, str(root))
            engine = None
            try:
                import pos_invoice_factory
                original_engine = pos_invoice_factory.reader_engine
                pos_invoice_factory.reader_engine = lambda url, _ca: original_engine(url, local_test=True)
                import pos_invoice_documents_factory
                app = pos_invoice_documents_factory.create_app()
                client = falcon.testing.TestClient(app)
                from controllers import InvoiceController
                from pos_invoice_documents_native import native_snapshot
                import pos_invoice_documents_history as history
                bindings = sys.modules["database.database"]
                reader, engine = bindings.SessionR, bindings.SessionR.get_bind()
                isolation = reader.connection().get_isolation_level()
                previous_mode = reader.execute(text("SELECT @@SESSION.sql_mode")).scalar_one()
                snapshot = native_snapshot(reader, {"storeId": value["storeId"], "orderId": value["orderId"]})
                write_rejected = False
                try:
                    reader.execute(text("INSERT INTO invoice_read_guard(id,marker) VALUES(2,'must-reject')"))
                except Exception:
                    write_rejected = True
                finally:
                    reader.rollback()
                current_mode = reader.execute(text("SELECT @@SESSION.sql_mode")).scalar_one()
                rows = reader.execute(text("SELECT COUNT(*) FROM invoice_read_guard")).scalar_one()
                reader.rollback()
                observed = {"historyFallbacks": 0, "renderCalls": 0}

                @event.listens_for(engine, "before_cursor_execute")
                def guard_history(_connection, _cursor, statement, _parameters, _context, _many):
                    query = " ".join(statement.lower().split())
                    if re.match(r"^select\s+count\s*\(", query) and "from orders" in query:
                        observed["historyFallbacks"] += 1
                        raise AssertionError("Unexpected MySQL lifetime history")

                if value.get("scopeCapability"):
                    from controllers import PosExpressInvoiceController
                    from controllers.PosInvoiceSecurity import _scope, stamp_invoice_response
                    from pos_invoice_documents_scoped import selected_ids
                    class NativeSelectedRenderer:
                        def on_get(self, _req, resp):
                            observed["renderCalls"] += 1
                            observed["selectedPoints"] = PosExpressInvoiceController.order_point_cashback_eligibility_check(int(value["orderId"]))[1]
                            observed["selectedGiftIds"] = [str(row["id"]) for row in PosExpressInvoiceController.get_bought_gift_vouchers(int(value["orderId"]))]
                            resp.text = "<html><body>Selected: " + ",".join(selected_ids()) + "</body></html>"
                            resp.content_type = "text/html"
                            stamp_invoice_response(resp, resp.text, _scope.get())
                    PosExpressInvoiceController.PosInvoiceShop = NativeSelectedRenderer
                    headers = {"X-POS-Invoice-Key": value["key"], "X-POS-Invoice-Contract": "pos-invoice-security-v1", "X-POS-Feedback-Contract": "pos-feedback-proof-v1", "X-POS-Invoice-Nonce": value["nonce"], "X-POS-Operator-ID": value["operatorId"], "X-Request-ID": value["requestId"], "X-POS-Invoice-Scope": value["scopeCapability"]}
                    result = client.simulate_get("/internal/pos/invoices/express", params={"order_id": value["orderId"]}, headers=headers)
                    missing = client.simulate_get("/internal/pos/invoices/express", params={"order_id": value["orderId"]}, headers={key: item for key, item in headers.items() if key != "X-POS-Invoice-Scope"})
                    substituted = client.simulate_get("/internal/pos/invoices/express", params={"order_id": value["orderId"], "has_product_ids": "78"}, headers=headers)
                    return {"snapshot": snapshot, "writeRejected": write_rejected, "rows": rows, "isolation": isolation, "sqlModeUnchanged": previous_mode == current_mode, "status": result.status_code, "missingScopeStatus": missing.status_code, "substitutedIdsStatus": substituted.status_code, "html": result.text, "headers": dict(result.headers), **observed}

                # Test seam ONLY. Full original tax/template code executes in its
                # independent source oracle, not this native authority check.
                def render(order_id, skip_auth=False):
                    if str(order_id) != value["orderId"] or skip_auth is not True:
                        raise AssertionError("Unexpected renderer scope")
                    observed["renderCalls"] += 1
                    observed["boughtVoucherInitialValues"] = [str(row["voucher_initial_value"]) for row in InvoiceController.get_bought_gift_vouchers(order_id)]
                    result = InvoiceController.SessionR.execute(text(history.COUNT_SQL), {"user_id": int(value["customerId"])}).mappings().first()
                    return "<!doctype html><html><body><h1>Fixture tax invoice</h1><p>Orders: " + str(result["count"]) + "</p></body></html>"

                InvoiceController.generate_invoice = render
                headers = {"X-POS-Invoice-Key": value["key"], "X-POS-Invoice-Contract": "pos-invoice-security-v1",
                    "X-POS-Feedback-Contract": "pos-feedback-proof-v1", "X-POS-Invoice-Nonce": value["nonce"],
                    "X-POS-Operator-ID": value["operatorId"], "X-Request-ID": value["requestId"], "X-POS-Invoice-History": value["capability"]}
                if value.get("globalCapability"):
                    headers.update({"X-POS-Global-Invoice": value["globalCapability"], "X-POS-Global-Invoice-Contract": "pos-global-online-invoice-v1"})
                result = client.simulate_get("/internal/pos/invoices/online", params={"order_id": value["orderId"]}, headers=headers)
                missing = client.simulate_get("/internal/pos/invoices/online", params={"order_id": value["orderId"]}, headers={key: item for key, item in headers.items() if key != "X-POS-Invoice-History"})
                return {"snapshot": snapshot, "writeRejected": write_rejected, "rows": rows, "isolation": isolation, "sqlModeUnchanged": previous_mode == current_mode,
                    "status": result.status_code, "missingHistoryStatus": missing.status_code, "html": result.text, "headers": dict(result.headers), **observed,
                    "writerBindingsAbsent": not hasattr(bindings, "Session") and not hasattr(bindings, "SessionC"), "redisWriterAbsent": not hasattr(bindings.redis_object, "set")}
            finally:
                if "database.database" in sys.modules:
                    sys.modules["database.database"].SessionR.remove()
                if engine is not None:
                    engine.dispose()
                sys.path.pop(0)


if __name__ == "__main__":
    print(json.dumps(run(json.load(sys.stdin))))
