/**
 * @deprecated The rewrite-only payment correction (HMAC receipts, cash ledger, managed-order
 * baseline) is deleted. Legacy `AjaxPaymentStatusView` (order/views.py:685-775) is restored as
 * `POST /api/v1/stores/:storeId/orders/:orderId/payment-status` in checkout/payments.
 * These empty options remain only for the existing app.ts call site.
 */
export type PaymentReversalOptions = Record<string, never>;
export function paymentReversalOptions(
  _env: NodeJS.ProcessEnv = process.env,
): PaymentReversalOptions {
  return {};
}
