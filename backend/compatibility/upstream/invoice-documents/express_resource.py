"""Original selected-shop renderer with a private, native-checked line scope."""
import falcon
from controllers.PosInvoiceSecurity import require_invoice_scope, clear_invoice_scope, safe_invoice_logger
from pos_invoice_documents_scoped import require_selected, stamp_selected, _active


class ExpressInvoiceResource:
    def on_get(self, req, resp):
        from controllers import InvoiceController
        from controllers import PosExpressInvoiceController
        try:
            scope = require_invoice_scope(req, "store")
            selected = require_selected(req, scope, InvoiceController.SessionR.reader)
            PosExpressInvoiceController.PosInvoiceShop().on_get(req, resp)
            stamp_selected(resp, resp.text, selected, scope["service_key"])
        except falcon.HTTPError:
            raise
        except Exception:
            safe_invoice_logger().error("source-error")
            raise falcon.HTTPServiceUnavailable(title="Invoice unavailable", description="The selected invoice could not be generated.") from None
        finally:
            _active.set(None)
            clear_invoice_scope()
