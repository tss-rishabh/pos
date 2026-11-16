"""Only for pos_invoice_factory, never the ordinary API-v2 main process."""
import os
import re

port = os.environ.get("POS_INVOICE_PORT", "")
if not re.fullmatch(r"[0-9]{2,5}", port) or not 1 <= int(port) <= 65535:
    raise RuntimeError("Private invoice port is not configured")

bind = "0.0.0.0:" + port
wsgi_app = "pos_invoice_factory:create_app()"
workers = 2
worker_class = "gthread"
threads = 4
timeout = 20
graceful_timeout = 10
keepalive = 5
preload_app = False
accesslog = None
errorlog = "-"
loglevel = "warning"
logger_class = "pos_invoice_gunicorn.ClosedInvoiceLogger"
capture_output = False
