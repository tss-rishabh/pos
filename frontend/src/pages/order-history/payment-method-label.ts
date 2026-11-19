/**
 * Display form of the legacy order-list payment method. Legacy `get_method_name`
 * (order/datatables/orders_datatable.py:264-303) returns `f"{pay_method}: {cash} {other} {online}"`,
 * so an order without a payment-method name reads ": CASH  " and the split parts carry padding.
 * The server keeps that exact value (and the page CSV exports it); the table shows the two parts
 * joined only when both exist, with the padding collapsed.
 */
export function paymentMethodLabel(value: unknown): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const split = /^([^:]*):(.*)$/s.exec(text);
  if (!split) return text.trim();
  const method = split[1]!.trim(),
    parts = split[2]!.split(/\s+/).filter(Boolean).join(' ');
  if (!parts) return method;
  if (!method) return parts;
  return `${method}: ${parts}`;
}
