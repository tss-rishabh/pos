"""Only mounted by the digest-checked isolated read-only invoice factory."""
from controllers import InvoiceController
import falcon
from controllers.PosInvoiceSecurity import (
    require_invoice_scope, stamp_invoice_response, clear_invoice_scope,
    safe_invoice_logger,
)
from pos_invoice_documents_global import stamp_global
from pos_invoice_documents_history import require_history, clear_history, stamp_history


class OnlineInvoiceResource:
    def on_get(self, req, resp):
        try:
            scope = require_invoice_scope(req, "online")
            history = require_history(req, scope, InvoiceController.SessionR.reader)
            # Invoke the pinned original calculator/template selection unchanged.
            # The factory supplies only its transaction-read-only SessionR.
            html = InvoiceController.generate_invoice(int(scope["order_id"]), skip_auth=True)
            resp.text = html
            resp.content_type = "text/html; charset=utf-8"
            stamp_invoice_response(resp, html, scope)
            stamp_history(resp, html, history, scope["service_key"])
            if history.get("global_capability"):
                stamp_global(resp, html, history["global_capability"], scope["service_key"])
        except Exception as error:
            # Log only static identifiers while the validated correlation is
            # still present; never pass the source exception or HTML to logs.
            safe_invoice_logger().error("source-error")
            if isinstance(error, falcon.HTTPError):
                raise
            raise falcon.HTTPServiceUnavailable(title="Invoice unavailable", description="The private invoice could not be generated.") from None
        finally:
            clear_history()
            clear_invoice_scope()
