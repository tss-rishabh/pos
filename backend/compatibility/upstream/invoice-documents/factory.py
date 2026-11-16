"""Extension of the already reviewed isolated invoice worker, never API-v2 main."""
import hashlib
import hmac
from pathlib import Path

BASE_FACTORY_SHA256 = "@@BASE_FACTORY_SHA256@@"
RESOURCE_SHA256 = "@@RESOURCE_SHA256@@"
HISTORY_SHA256 = "@@HISTORY_SHA256@@"
NATIVE_SHA256 = "@@NATIVE_SHA256@@"
SCOPED_SHA256 = "@@SCOPED_SHA256@@"
EXPRESS_RESOURCE_SHA256 = "@@EXPRESS_RESOURCE_SHA256@@"
EXPRESS_CONTROLLER_SHA256 = "@@EXPRESS_CONTROLLER_SHA256@@"
TEMPLATE_SHA256 = {}  # @@TEMPLATE_SHA256@@


def verify_inputs(root):
    root = Path(root)
    for path, expected in {
        "pos_invoice_factory.py": BASE_FACTORY_SHA256,
        "pos_invoice_documents.py": RESOURCE_SHA256,
        "pos_invoice_documents_history.py": HISTORY_SHA256,
        "pos_invoice_documents_native.py": NATIVE_SHA256,
        "pos_invoice_documents_scoped.py": SCOPED_SHA256,
        "pos_invoice_documents_express.py": EXPRESS_RESOURCE_SHA256,
        "controllers/PosExpressInvoiceController.py": EXPRESS_CONTROLLER_SHA256,
        **TEMPLATE_SHA256,
    }.items():
        digest = hashlib.sha256((root / path).read_bytes()).hexdigest()
        if not hmac.compare_digest(digest, expected):
            raise RuntimeError("Online invoice source is not the reviewed artifact")


def create_app():
    verify_inputs(Path(__file__).resolve().parent)
    import pos_invoice_factory
    create_private_invoice = pos_invoice_factory.create_app
    original_engine = pos_invoice_factory.reader_engine

    def repeatable_reader(url, ca):
        return original_engine(url, ca).execution_options(isolation_level="REPEATABLE READ")

    pos_invoice_factory.reader_engine = repeatable_reader
    # This performs the original controller/helper digest checks, installs the
    # scoped read-only engine, closed errors/logging and private middleware.
    app = create_private_invoice()
    from controllers import InvoiceController
    from pos_invoice_documents_history import InvoiceHistoryReader
    InvoiceController.SessionR = InvoiceHistoryReader(InvoiceController.SessionR)
    from pos_invoice_documents import OnlineInvoiceResource
    app.add_route("/internal/pos/invoices/online", OnlineInvoiceResource())
    from controllers import PosExpressInvoiceController
    from pos_invoice_documents_scoped import SelectedReader
    PosExpressInvoiceController.SessionR = SelectedReader(InvoiceController.SessionR)
    from pos_invoice_documents_express import ExpressInvoiceResource
    app.add_route("/internal/pos/invoices/express", ExpressInvoiceResource())
    return app
