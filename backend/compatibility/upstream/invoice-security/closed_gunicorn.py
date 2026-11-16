"""Closed process-error logging for this isolated worker, not the ordinary API."""
import json
from gunicorn.glogging import Logger
from controllers.PosInvoiceSecurity import invoice_log_event


class ClosedInvoiceLogger(Logger):
    def access(self, *_args, **_kwargs):
        pass

    def debug(self, *_args, **_kwargs):
        pass

    info = debug

    def error(self, *_args, **_kwargs):
        # Never interpolate Gunicorn's exception, request, headers, URL or args.
        self.error_log.error(json.dumps(invoice_log_event(runtime=True), separators=(",", ":")))

    exception = error
    critical = error
    warning = error
