"""Execute the exact patched source handler with closed, read-only dependencies."""
import ast
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import logging
from pathlib import Path
import subprocess
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import prepare


class HttpError(Exception):
    def __init__(self, title="", description=""):
        super().__init__(title)
        self.title, self.description = title, description


falcon = ModuleType("falcon")
falcon.HTTPError = HttpError
for name in ("HTTPBadRequest", "HTTPUnauthorized", "HTTPServiceUnavailable"):
    setattr(falcon, name, type(name, (HttpError,), {}))
settings = ModuleType("settings")
settings.SECRET_KEY = "customer-signing-key-" * 3
settings.SECRET_KEY_512 = "customer-second-factor-key-" * 3
settings.POS_INVOICE_KEY = "legacy-query-receipt-key-" * 3
sys.modules["falcon"], sys.modules["settings"] = falcon, settings
spec = importlib.util.spec_from_file_location("invoice_security_fixture", ROOT / "pos_invoice_security.py")
security = importlib.util.module_from_spec(spec)
spec.loader.exec_module(security)

ENV = {
    "POS_INVOICE_SERVICE_KEY": "private-invoice-service-key-" * 3,
    "POS_INVOICE_FEEDBACK_KEY": "separate-feedback-signing-key-" * 3,
    "POS_INVOICE_FEEDBACK_KEY_ID": "invoice-fixture-1",
    "POS_INVOICE_FEEDBACK_TTL_SECONDS": "3600",
    "POS_INVOICE_FEEDBACK_URL": "https://feedback.example.test/invoice",
    "POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT": security.FEEDBACK_CONTRACT,
}


def request(order_id="9007199254740993", operator_id="44", nonce="a" * 32):
    headers = {
        "X-POS-Invoice-Key": ENV["POS_INVOICE_SERVICE_KEY"],
        "X-POS-Invoice-Contract": security.INVOICE_CONTRACT,
        "X-POS-Feedback-Contract": security.FEEDBACK_CONTRACT,
        "X-POS-Invoice-Nonce": nonce, "X-POS-Operator-ID": operator_id,
        "X-Request-ID": "invoice-fixture-" + operator_id,
    }
    params = {"order_id": order_id}
    return SimpleNamespace(headers=headers, params=params,
                           get_header=lambda name: headers.get(name), get_param=lambda name: params.get(name),
                           context={})


class Response:
    def __init__(self):
        self.headers = {}

    def set_header(self, name, value):
        self.headers[name] = value


def load_source_handler():
    repository = ROOT.parents[4] / "backend-tss-api_v2"
    original = subprocess.check_output(["git", "show", f"{prepare.COMMIT}:{prepare.SOURCE_PATH}"], cwd=repository, text=True)
    candidate = prepare.candidate(original)
    selected = next(node for node in ast.parse(candidate).body if isinstance(node, ast.ClassDef) and node.name == "PosInvoiceShop")
    module = ast.fix_missing_locations(ast.Module(body=[selected], type_ignores=[]))
    return original, module


def run_source_handler(req=None, fail=False):
    req = req or request()
    reads, writes, links = [], [], []
    class Column:
        def __eq__(self, _value):
            return True
    order_model = SimpleNamespace(id=Column())
    mapping_model = SimpleNamespace(order_id=Column())
    raw_order_id = req.params["order_id"]
    order = SimpleNamespace(id=int(raw_order_id) if isinstance(raw_order_id, str) else 0,
                            user_id=777, created_at="2026-11-16 10:00:00", coupon_used=0, voucher_used=0)
    mapping = SimpleNamespace(order_invoice="FIXTURE/INV/1")
    class ReadOnlySession:
        def query(self, model):
            reads.append("order" if model is order_model else "mapping")
            return SimpleNamespace(filter=lambda *_: SimpleNamespace(first=lambda: order if model is order_model else mapping))
        def expunge(self, _record):
            pass
        def add(self, *_args):
            writes.append("add")
            raise AssertionError("Invoice attempted a write")
        def commit(self):
            writes.append("commit")
            raise AssertionError("Invoice attempted a commit")
    session = ReadOnlySession()
    req.context = {"session": session, "session_r": session}
    class Template:
        def render(self, context):
            if fail:
                raise RuntimeError("PRIVATE-BODY EMAIL@example.test COOKIE-CANARY SQL-CANARY")
            return "<html><body><table><tr><th>GST</th><td>18.00</td></tr></table>" + context["qr_image"] + "</body></html>"
    globals_ = {
        "falcon": falcon, "settings": settings, "SessionR": session,
        "OrderModel": order_model, "OrderStoreModel": mapping_model,
        "require_invoice_scope": lambda request_, kind: security.require_invoice_scope(request_, kind, ENV), "feedback_url": security.feedback_url,
        "stamp_invoice_response": security.stamp_invoice_response, "clear_invoice_scope": security.clear_invoice_scope,
        "logger": security.safe_invoice_logger(), "get_base64_barcode": lambda _id: "data:image/png;base64,AAAA",
        "add_user_info_to_order": lambda value: value, "order_point_cashback_eligibility_check": lambda _id: (False, 0),
        "get_has_products": lambda _id: [{"rowid": 1}], "get_bought_gift_vouchers": lambda _id: [],
        "get_priority_reason": lambda _order: "", "do_tss_hacks_pos": lambda *_args, **_kw: {},
        "generate_qr_base64": lambda value: links.append(value) or '<img src="data:image/png;base64,AAAA">',
        "template_env": SimpleNamespace(get_template=lambda _name: Template()),
        "create_token": lambda *_: (_ for _ in ()).throw(AssertionError("Customer credential creation forbidden")),
        "user_token_log": lambda *_: (_ for _ in ()).throw(AssertionError("Customer log write forbidden")),
    }
    _, module = load_source_handler()
    exec(compile(module, "<pinned-private-invoice-handler>", "exec"), globals_)
    response = Response()
    globals_["PosInvoiceShop"]().on_get(req, response)
    return {"headers": response.headers, "html": response.text, "url": links[0], "reads": reads, "writes": writes,
            "orderId": req.params["order_id"], "operatorId": req.headers["X-POS-Operator-ID"],
            "requestId": req.headers["X-Request-ID"], "nonce": req.headers["X-POS-Invoice-Nonce"]}


class SecurityChecks(unittest.TestCase):
    def tearDown(self):
        security.clear_invoice_scope()

    def test_saved_patch_is_read_only_and_removes_customer_credentials(self):
        manifest = prepare.build()
        self.assertFalse(manifest["enabled"])
        self.assertEqual(manifest["contract"], security.INVOICE_CONTRACT)

    def test_entire_literal_candidate_imports_without_customer_or_writer_modules(self):
        original, _ = load_source_handler()
        output = prepare.candidate(original)
        modules = {}

        def module(name, **values):
            result = ModuleType(name)
            result.__dict__.update(values)
            modules[name] = result
            return result

        module("barcode")
        module("barcode.writer", ImageWriter=object)
        module("jinja2", Environment=lambda **_kwargs: SimpleNamespace(globals={}), FileSystemLoader=lambda *_args: None)
        module("jwt")
        module("database.database", SessionR=object(), redis_object=object())
        module("models.Order", **{name: object for name in ("OrderModel", "OrderStoreModel", "StoreModel", "PosFranchise", "PosTerminalTransaction")})
        module("models.GiftVoucher", **{name: object for name in ("GiftVoucherModal", "OrderGiftVoucherModal", "Coupon")})
        module("models.User", Address=object, User=object)
        module("constants.StatusEnum", PosPaymentMode=object)
        module("constants.Constants", FREEBIE_PRODUCT_TYPE=0)
        module("sqlalchemy", text=lambda value: value)
        module("num2words", num2words=lambda value: str(value))
        module("qrcode")
        modules["controllers.PosInvoiceSecurity"] = security
        settings.IMAGE_URL = "https://images.example.test/"
        scope = {"__file__": str(ROOT / "fixture/controller.py")}
        with patch.dict(sys.modules, modules):
            exec(compile(output, "<entire-pinned-invoice-controller>", "exec"), scope)
        self.assertTrue(callable(scope["PosInvoiceShop"]))
        self.assertIsInstance(scope["logger"], security._ClosedInvoiceLogger)
        self.assertNotIn("create_token", scope)

    def test_cache_miss_setting_values_are_preserved_without_redis_writes(self):
        original, _ = load_source_handler()
        selected = []
        for source in (original, prepare.candidate(original)):
            node = next(item for item in ast.parse(source).body if isinstance(item, ast.FunctionDef) and item.name == "check_show_freebie")
            selected.append(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])))
        for value in (0, 1, None):
            answers, writes = [], []
            for index, code in enumerate(selected):
                class Cache:
                    def get(self, _key):
                        return None
                    def set(self, key, cached):
                        writes.append((index, key, cached))
                globals_ = {"redis_object": Cache(), "text": lambda query: query, "logger": security.safe_invoice_logger(),
                            "SessionR": SimpleNamespace(execute=lambda query, params: SimpleNamespace(fetchone=lambda: (value,))) }
                exec(compile(code, "<literal-settings-helper>", "exec"), globals_)
                answers.append(globals_["check_show_freebie"]())
            self.assertEqual(answers[0], answers[1])
            self.assertFalse(any(index == 1 for index, _key, _value in writes))

    def test_source_digest_fence_rejects_an_unpatched_controller_before_import(self):
        from tempfile import TemporaryDirectory
        factory_tree = ast.parse((ROOT / "factory.py").read_text())
        node = next(item for item in factory_tree.body if isinstance(item, ast.FunctionDef) and item.name == "verify_sources")
        code = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
        manifest = prepare.build()
        globals_ = {"hashlib": hashlib, "hmac": __import__("hmac"), "Path": Path,
                    "CONTROLLER_SHA256": manifest["candidateSha256"], "HELPER_SHA256": manifest["helperSha256"]}
        exec(compile(code, "<literal-digest-fence>", "exec"), globals_)
        original, _ = load_source_handler()
        with TemporaryDirectory(prefix="invoice-source-fence-") as temporary:
            target = Path(temporary) / "controllers"
            target.mkdir()
            (target / "InvoiceController.py").write_text(prepare.candidate(original))
            (target / "PosInvoiceSecurity.py").write_text((ROOT / "pos_invoice_security.py").read_text())
            globals_["verify_sources"](temporary)
            (target / "InvoiceController.py").write_text(original)
            with self.assertRaisesRegex(RuntimeError, "reviewed artifact"):
                globals_["verify_sources"](temporary)

    def test_literal_source_handler_only_reads_and_signs_exact_response(self):
        result = run_source_handler()
        self.assertEqual(result["writes"], [])
        self.assertEqual(result["reads"], ["order", "mapping"])
        self.assertIn("18.00", result["html"])
        self.assertEqual(result["headers"]["X-POS-Invoice-Contract"], security.INVOICE_CONTRACT)
        self.assertIn("feedback_proof=", urlsplit(result["url"]).fragment)
        self.assertEqual(urlsplit(result["url"]).query, "")
        self.assertIsNone(security._scope.get())

    def test_legacy_query_token_and_wrong_private_headers_cannot_reach_sql(self):
        for header in ["X-POS-Invoice-Key", "X-POS-Invoice-Contract", "X-POS-Feedback-Contract"]:
            req = request()
            req.headers[header] = "PRIVATE-CANARY"
            with self.assertRaises(falcon.HTTPUnauthorized):
                run_source_handler(req)
        req = request()
        req.params["pos_token"] = settings.POS_INVOICE_KEY
        with self.assertRaises(falcon.HTTPUnauthorized):
            run_source_handler(req)
        for changed in ({"has_product_ids": "1"}, {"token": "PRIVATE-CANARY"}, {"order_id": ["1", "2"]}):
            req = request()
            req.params.update(changed)
            with self.assertRaises(falcon.HTTPBadRequest):
                run_source_handler(req)

    def test_separate_signing_keys_and_explicit_validity_are_required(self):
        for changed in [
            {"POS_INVOICE_FEEDBACK_KEY": settings.SECRET_KEY},
            {"POS_INVOICE_FEEDBACK_KEY": settings.SECRET_KEY_512},
            {"POS_INVOICE_FEEDBACK_KEY": ENV["POS_INVOICE_SERVICE_KEY"]},
            {"POS_INVOICE_SERVICE_KEY": settings.POS_INVOICE_KEY},
            {"POS_INVOICE_FEEDBACK_TTL_SECONDS": ""}, {"POS_INVOICE_FEEDBACK_TTL_SECONDS": "2678401"},
            {"POS_INVOICE_FEEDBACK_URL": "https://feedback.example.test/?token=PRIVATE"},
            {"POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT": "legacy"},
        ]:
            with self.assertRaises(falcon.HTTPServiceUnavailable):
                security._configuration({**ENV, **changed})

    def test_read_failure_has_static_response_and_closed_logs(self):
        stream = io.StringIO()
        logger = logging.getLogger("pos.invoice")
        handler = logging.StreamHandler(stream)
        logger.addHandler(handler)
        try:
            with self.assertRaises(falcon.HTTPBadRequest) as caught:
                run_source_handler(fail=True)
            self.assertEqual(caught.exception.description, "The private invoice could not be generated.")
        finally:
            logger.removeHandler(handler)
        line = json.loads(stream.getvalue())
        self.assertEqual(set(line), {"module", "resource", "eventId", "requestId", "userId"})
        self.assertEqual(line["userId"], "44")
        self.assertNotIn("PRIVATE", stream.getvalue())
        self.assertNotIn("EMAIL@", stream.getvalue())
        self.assertIsNone(security._scope.get())

    def test_request_scopes_are_isolated_under_concurrent_source_execution(self):
        def execute(index):
            req = request(str(9007199254740993 + index), str(44 + index), (str(index % 10) * 32))
            return run_source_handler(req)
        # The real service context uses contextvars; the fixture environment is
        # identical across workers, so no request-specific environment state exists.
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(execute, range(16)))
        for index, result in enumerate(results):
            self.assertEqual(result["operatorId"], str(44 + index))
            self.assertEqual(result["orderId"], str(9007199254740993 + index))
            self.assertEqual(result["headers"]["X-POS-Invoice-Nonce"], str(index % 10) * 32)

    def test_gunicorn_access_and_process_errors_never_serialize_raw_values(self):
        stream = io.StringIO()
        class StubLogger:
            pass
        gunicorn = ModuleType("gunicorn.glogging")
        gunicorn.Logger = StubLogger
        with patch.dict(sys.modules, {"gunicorn.glogging": gunicorn, "controllers.PosInvoiceSecurity": security}):
            namespace = {}
            exec(compile((ROOT / "closed_gunicorn.py").read_text(), "<closed-gunicorn>", "exec"), namespace)
        logger = namespace["ClosedInvoiceLogger"]()
        logger.error_log = SimpleNamespace(error=lambda value: stream.write(value + "\n"))
        security.require_invoice_scope(request(), "store", ENV)
        for method in (logger.error, logger.warning, logger.critical, logger.exception):
            method("PRIVATE-BODY %s", "PRIVATE-TOKEN COOKIE-CANARY EMAIL@example.test", exc_info=RuntimeError("SQL-CANARY"))
        logger.access({"authorization": "PRIVATE-TOKEN"})
        logger.info("PRIVATE-TOKEN")
        events = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual(len(events), 4)
        for event in events:
            self.assertEqual(event, {"module": "checkout", "resource": "tax-invoice",
                                     "eventId": "checkout.tax-invoice.runtime-error",
                                     "requestId": "invoice-fixture-44", "userId": "44"})


if __name__ == "__main__":
    unittest.main()
