"""Isolated read-only invoice WSGI factory for the pinned, patched source image.

Run only in its own process. The ordinary API-v2 application is not imported.
"""
import json
import hashlib
import hmac
import os
from pathlib import Path
import re
import sys
from types import ModuleType
from urllib.parse import urlsplit

CONTROLLER_SHA256 = "@@CONTROLLER_SHA256@@"
HELPER_SHA256 = "@@HELPER_SHA256@@"


def verify_sources(root):
    for filename, digest in (("InvoiceController.py", CONTROLLER_SHA256), ("PosInvoiceSecurity.py", HELPER_SHA256)):
        actual = hashlib.sha256((Path(root) / "controllers" / filename).read_bytes()).hexdigest()
        if not hmac.compare_digest(actual, digest):
            raise RuntimeError("Private invoice source is not the reviewed artifact")


def reader_engine(url, ca_path=None, local_test=False):
    from sqlalchemy import create_engine, event
    parsed = urlsplit(url)
    if parsed.scheme not in ("mysql", "mysql+pymysql") or not parsed.hostname or parsed.query or parsed.fragment:
        raise RuntimeError("Private invoice reader configuration is invalid")
    connection_options = {"connect_timeout": 5, "read_timeout": 12, "write_timeout": 5}
    if local_test:
        if parsed.hostname not in ("localhost", "127.0.0.1") or not re.fullmatch(r"/pos_rewrite_invoice_test_[a-f0-9]{12}", parsed.path):
            raise RuntimeError("Invoice tests require an isolated local schema")
    else:
        if not ca_path or not Path(ca_path).is_file():
            raise RuntimeError("Private invoice reader TLS configuration is required")
        connection_options["ssl"] = {"ca": ca_path, "check_hostname": True}
    engine = create_engine("mysql+pymysql" + url[url.index(":"):],
                           echo=False, hide_parameters=True, pool_pre_ping=True,
                           pool_size=4, max_overflow=4, pool_recycle=300, pool_timeout=5,
                           connect_args=connection_options)

    @event.listens_for(engine, "connect")
    def read_only(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("SET SESSION TRANSACTION READ ONLY")
            cursor.execute("SET SESSION MAX_EXECUTION_TIME=8000")
        finally:
            cursor.close()

    return engine


def create_app():
    verify_sources(Path(__file__).resolve().parent)
    import falcon
    from sqlalchemy.orm import scoped_session, sessionmaker
    from controllers.PosInvoiceSecurity import clear_invoice_scope, safe_invoice_logger, _configuration

    _configuration()
    url = os.environ.get("POS_INVOICE_MYSQL_READER_URL", "")
    ca = os.environ.get("POS_INVOICE_MYSQL_SSL_CA", "")
    engine = reader_engine(url, ca)
    sessions = scoped_session(sessionmaker(bind=engine, autoflush=False, expire_on_commit=False))
    if "database.database" in sys.modules:
        raise RuntimeError("Private invoice requires an isolated process")
    # Loading the legacy database module would create writer/Redis bindings.
    # Supply only the two bindings used by this exact, digest-checked controller.
    database = ModuleType("database.database")
    database.SessionR = sessions

    class NoSettingsCache:
        def get(self, _key):
            # Execute the literal source cache-miss SELECT against the reader.
            # This process neither connects to nor populates Redis.
            return None

    database.redis_object = NoSettingsCache()
    sys.modules["database.database"] = database
    from controllers import InvoiceController
    # Every source invoice helper uses this request/thread-scoped reader. No
    # writer session, Redis authentication or customer-token middleware is wired.
    InvoiceController.SessionR = sessions
    logger = safe_invoice_logger()

    class ReaderContext:
        def process_request(self, req, _resp):
            clear_invoice_scope()
            req.context["session"] = sessions()
            req.context["session_r"] = req.context["session"]

        def process_response(self, req, _resp, _resource, _succeeded):
            try:
                session = req.context.get("session")
                if session is not None:
                    try:
                        session.rollback()
                    except Exception:
                        logger.error("source-error")
            finally:
                try:
                    sessions.remove()
                except Exception:
                    logger.error("source-error")
                finally:
                    clear_invoice_scope()

    def error_handler(_error, _req, resp, _params):
        logger.error("source-error")
        resp.status = falcon.HTTP_503
        resp.content_type = "application/json"
        resp.text = json.dumps({"error": {"code": "INVOICE_UNAVAILABLE"}})

    app = falcon.App(middleware=[ReaderContext()])
    app.add_error_handler(Exception, error_handler)
    app.add_route("/internal/pos/invoices/store", InvoiceController.PosInvoiceShop())
    return app
