import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import sys
import base64
import time
import datetime
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

import falcon
import falcon.testing
import prepare

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent / "invoice-security"


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class Documents(unittest.TestCase):
    def setUp(self):
        self.settings = ModuleType("settings")
        self.settings.SECRET_KEY = "first-customer-key-" * 3
        self.settings.SECRET_KEY_512 = "second-customer-key-" * 3
        self.settings.POS_INVOICE_KEY = "legacy-invoice-key-" * 3
        self.env = {"POS_INVOICE_SERVICE_KEY": "private-invoice-key-" * 3,
                    "POS_INVOICE_FEEDBACK_KEY": "separate-feedback-key-" * 3,
                    "POS_INVOICE_FEEDBACK_KEY_ID": "invoice-fixture",
                    "POS_INVOICE_FEEDBACK_TTL_SECONDS": "3600",
                    "POS_INVOICE_FEEDBACK_URL": "https://feedback.example.test/invoice-feedback",
                    "POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT": "pos-feedback-proof-v1"}
        self.calls = []
        self.html = "<html><body><h1>Fixture online invoice</h1></body></html>"
        settings_patch = patch.dict(sys.modules, {"settings": self.settings})
        settings_patch.start()
        self.addCleanup(settings_patch.stop)
        self.security = module(BASE / "pos_invoice_security.py", "online_invoice_security_test")
        controllers = ModuleType("controllers")
        invoice = ModuleType("controllers.InvoiceController")
        invoice.SessionR = SimpleNamespace(reader=object())

        def generate(order_id, skip_auth=False):
            self.calls.append((order_id, skip_auth))
            return self.html

        invoice.generate_invoice = generate
        controllers.InvoiceController = invoice
        self.modules = patch.dict(sys.modules, {"controllers": controllers,
            "controllers.InvoiceController": invoice, "controllers.PosInvoiceSecurity": self.security})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.environment = patch.dict(os.environ, self.env)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        additions = prepare.generated_files()
        native = ModuleType("pos_invoice_documents_native")
        native.native_snapshot = lambda _reader, _scope: {"binding": "a" * 64, "customerId": "777"}
        native_modules = patch.dict(sys.modules, {"pos_invoice_documents_native": native})
        native_modules.start()
        self.addCleanup(native_modules.stop)
        self.history = ModuleType("pos_invoice_documents_history")
        exec(compile(additions["pos_invoice_documents_history.py"], "reviewed-invoice-history", "exec"), self.history.__dict__)
        history_modules = patch.dict(sys.modules, {"pos_invoice_documents_history": self.history})
        history_modules.start()
        self.addCleanup(history_modules.stop)
        self.resource = module(ROOT / "online_resource.py", "private_online_invoice_resource_test")
        app = falcon.App()
        app.add_route("/internal/pos/invoices/online", self.resource.OnlineInvoiceResource())
        self.client = falcon.testing.TestClient(app)
        self.headers = {"X-POS-Invoice-Key": self.env["POS_INVOICE_SERVICE_KEY"],
            "X-POS-Invoice-Contract": "pos-invoice-security-v1", "X-POS-Feedback-Contract": "pos-feedback-proof-v1",
            "X-POS-Invoice-Nonce": "a" * 32, "X-POS-Operator-ID": "7", "X-Request-ID": "fixture-online-invoice"}
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.payload = {"v": 1, "purpose": "online-invoice-history", "contract": self.history.CONTRACT,
            "orderId": "9007199254740993", "operatorId": "7", "storeId": "1", "customerId": "777", "orderCount": "2",
            "nativeSnapshot": "a" * 64, "nonce": "a" * 32, "requestId": "fixture-online-invoice",
            "issuedAt": int(time.time()), "expiresAt": int(time.time()) + 30,
            "publication": {"generationId": "123e4567-e89b-42d3-a456-426614174000", "sourceSnapshotId": "controlled-source-snapshot",
                "sourceSnapshotAt": stamp, "sourceCdcWatermark": stamp, "publishedAt": stamp,
                "customerSourceRows": "3", "customerOrdersHash": "b" * 64}}
        self.headers["X-POS-Invoice-History"] = self.capability(self.payload)

    def capability(self, value):
        payload = base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
        message = self.history.CONTRACT + "." + payload
        signature = base64.urlsafe_b64encode(hmac.new(self.env["POS_INVOICE_SERVICE_KEY"].encode(), message.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        return message + "." + signature

    def test_exact_online_scope_and_literal_renderer_call(self):
        result = self.client.simulate_get("/internal/pos/invoices/online", params={"order_id": "9007199254740993"}, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.calls, [(9007199254740993, True)])
        self.assertEqual(result.text, self.html)
        message = "\n".join(("pos-invoice-security-v1", "pos-feedback-proof-v1", "online", "9007199254740993", "7", "fixture-online-invoice", "a" * 32, hashlib.sha256(self.html.encode()).hexdigest()))
        self.assertEqual(result.headers["x-pos-invoice-proof"], hmac.new(self.env["POS_INVOICE_SERVICE_KEY"].encode(), message.encode(), hashlib.sha256).hexdigest())
        self.assertIsNone(self.security._scope.get())
        self.assertIsNone(self.history._active.get())
        self.assertEqual(result.headers["x-pos-invoice-history-contract"], self.history.CONTRACT)

    def test_wrong_key_missing_key_and_query_secret_do_no_render(self):
        for headers, parameters in [({}, {"order_id": "1"}), ({**self.headers, "X-POS-Invoice-Key": "wrong"}, {"order_id": "1"}), (self.headers, {"order_id": "1", "pos_token": "CANARY"})]:
            result = self.client.simulate_get("/internal/pos/invoices/online", params=parameters, headers=headers)
            self.assertEqual(result.status_code, 401)
        self.assertEqual(self.calls, [])

    def test_history_capability_requires_every_scope_native_and_nonce_binding(self):
        for change in ({"orderId": "1"}, {"operatorId": "8"}, {"customerId": "778"}, {"nativeSnapshot": "b" * 64}, {"nonce": "b" * 32}, {"expiresAt": int(time.time()) - 1}):
            headers = {**self.headers, "X-POS-Invoice-History": self.capability({**self.payload, **change})}
            self.assertEqual(self.client.simulate_get("/internal/pos/invoices/online", params={"order_id": "9007199254740993"}, headers=headers).status_code, 503)
        headers = {**self.headers, "X-POS-Invoice-History": self.headers["X-POS-Invoice-History"][:-1] + "!"}
        self.assertEqual(self.client.simulate_get("/internal/pos/invoices/online", params={"order_id": "9007199254740993"}, headers=headers).status_code, 503)
        self.assertEqual(self.calls, [])

    def test_only_exact_frozen_count_and_customer_can_be_intercepted(self):
        class NoHistoricalSql:
            def execute(self, *_args, **_kwargs):
                raise AssertionError("A MySQL history query escaped")
        reader = self.history.InvoiceHistoryReader(NoHistoricalSql())
        token = self.history._active.set(self.payload)
        try:
            self.assertEqual(reader.execute(self.history.COUNT_SQL, {"user_id": 777}).mappings().first(), {"count": 2})
            with self.assertRaises(falcon.HTTPServiceUnavailable):
                reader.execute(self.history.COUNT_SQL, {"user_id": 778})
            with self.assertRaises(falcon.HTTPServiceUnavailable):
                reader.execute("SELECT COUNT(*) FROM orders WHERE user_id=:user_id", {"user_id": 777})
            with self.assertRaises(falcon.HTTPServiceUnavailable):
                reader.execute("SELECT * FROM orders WHERE user_id=:user_id", {"user_id": 777})
        finally:
            self.history._active.reset(token)
        with self.assertRaises(falcon.HTTPServiceUnavailable):
            reader.execute(self.history.COUNT_SQL, {"user_id": 777})

    def test_oversized_ids_duplicate_ids_and_legacy_scope_bypasses_rejected(self):
        for query in ("order_id=9223372036854775808", "order_id=1&order_id=2", "order_id=1&cr=1", "order_id=1&has_product_ids=9"):
            self.assertEqual(self.client.simulate_get("/internal/pos/invoices/online?" + query, headers=self.headers).status_code, 400)
        self.assertEqual(self.calls, [])

    def test_additive_artifact_pins_existing_reader_factory_and_all_templates(self):
        manifest = prepare.build()
        self.assertFalse(manifest["enabled"])
        self.assertEqual(manifest["sourceCommit"], "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5")
        self.assertEqual(len(manifest["templates"]), 3)
        raw = (ROOT / "factory.py").read_text()
        self.assertIn("create_private_invoice()", raw)
        self.assertIn('"/internal/pos/invoices/online"', raw)
        self.assertNotIn("create_token", (ROOT / "online_resource.py").read_text())


if __name__ == "__main__":
    unittest.main()
