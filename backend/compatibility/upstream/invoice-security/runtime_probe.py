"""Start the entire pinned controller with actual locked dependencies, no source writes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
from unittest.mock import patch

import falcon.testing
import prepare

ROOT = Path(__file__).resolve().parent


def run_runtime(url):
    repository = ROOT.parents[4] / "backend-tss-api_v2"
    manifest = prepare.build()
    original = subprocess.check_output(["git", "show", f"{prepare.COMMIT}:{prepare.SOURCE_PATH}"], cwd=repository, text=True)
    candidate = prepare.candidate(original)
    helper = (ROOT / "pos_invoice_security.py").read_text()
    factory = ((ROOT / "factory.py").read_text()
               .replace("@@CONTROLLER_SHA256@@", hashlib.sha256(candidate.encode()).hexdigest())
               .replace("@@HELPER_SHA256@@", hashlib.sha256(helper.encode()).hexdigest()))
    if hashlib.sha256(factory.encode()).hexdigest() != manifest["factorySha256"]:
        raise RuntimeError("Invoice runtime artifact changed")
    env = {
        "POS_INVOICE_SERVICE_KEY": "private-invoice-service-key-" * 3,
        "POS_INVOICE_FEEDBACK_KEY": "separate-feedback-signing-key-" * 3,
        "POS_INVOICE_FEEDBACK_KEY_ID": "invoice-fixture-1",
        "POS_INVOICE_FEEDBACK_TTL_SECONDS": "3600",
        "POS_INVOICE_FEEDBACK_URL": "https://feedback.example.test/invoice-feedback",
        "POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT": "pos-feedback-proof-v1",
        "POS_INVOICE_MYSQL_READER_URL": url,
    }
    settings = ModuleType("settings")
    settings.SECRET_KEY = "customer-signing-key-" * 3
    settings.SECRET_KEY_512 = "second-customer-key-" * 3
    settings.POS_INVOICE_KEY = "legacy-invoice-key-" * 3
    settings.TIMEZONE_IST = "Asia/Kolkata"
    settings.IMAGE_URL = "https://images.example.test/"
    settings.TSS_STORE_URL = "https://store.example.test/"
    settings.TSS_API_URL = "https://api.example.test/"
    settings.SKIP_COMPLEMENTARY_PRODUCT_STATUSES = [5, 19, 20, 42]
    with TemporaryDirectory(prefix="pinned-invoice-runtime-") as temporary:
        root = Path(temporary)
        for path in ("controllers/__init__.py", "models/__init__.py", "constants/__init__.py", "database/__init__.py"):
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            (root / path).write_text("")
        for path in ("models/Order.py", "models/GiftVoucher.py", "models/User.py", "constants/StatusEnum.py", "constants/Constants.py"):
            content = subprocess.check_output(["git", "show", f"{prepare.COMMIT}:{path}"], cwd=repository)
            (root / path).write_bytes(content)
        (root / "controllers/InvoiceController.py").write_text(candidate)
        (root / "controllers/PosInvoiceSecurity.py").write_text(helper)
        (root / "pos_invoice_factory.py").write_text(factory)
        with patch.dict(os.environ, env), patch.dict(sys.modules, {"settings": settings}):
            if "database.database" in sys.modules:
                raise RuntimeError("Probe must run in its own process")
            sys.path.insert(0, str(root))
            spec = importlib.util.spec_from_file_location("private_invoice_full_runtime", root / "pos_invoice_factory.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            actual_reader = module.reader_engine
            module.reader_engine = lambda supplied, _ca: actual_reader(supplied, local_test=True)
            try:
                app = module.create_app()
                client = falcon.testing.TestClient(app)
                rejected = client.simulate_get("/internal/pos/invoices/store", params={"order_id": "9007199254740993", "pos_token": "PRIVATE-CANARY"})
                absent = client.simulate_get("/pos-shop", params={"order_id": "1"})
                invalid = client.simulate_get("/internal/pos/invoices/store", params={"order_id": "9223372036854775808"}, headers={
                    "X-POS-Invoice-Key": env["POS_INVOICE_SERVICE_KEY"], "X-POS-Invoice-Contract": "pos-invoice-security-v1",
                    "X-POS-Feedback-Contract": "pos-feedback-proof-v1", "X-POS-Invoice-Nonce": "a" * 32,
                    "X-POS-Operator-ID": "44", "X-Request-ID": "invoice-runtime-fixture",
                })
                bindings = sys.modules["database.database"]
                return {"privateHeaderRequired": rejected.status_code == 401,
                        "legacyRouteAbsent": absent.status_code == 404,
                        "oversizedIdRejected": invalid.status_code == 400,
                        "writerBindingsAbsent": not hasattr(bindings, "Session") and not hasattr(bindings, "SessionC"),
                        "redisWriterAbsent": not hasattr(bindings.redis_object, "set"),
                        "runtime": "locked-python312-falcon4-sqlalchemy2"}
            finally:
                sys.path.pop(0)
                for name in list(sys.modules):
                    if name == "database.database" or name.split(".")[0] in ("controllers", "models", "constants", "database"):
                        sys.modules.pop(name, None)


if __name__ == "__main__":
    print(json.dumps(run_runtime(json.load(sys.stdin)["url"])))
