import { z } from 'zod';
const identifier = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((id) => /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n);
const scopeSchema = z.object({ operatorId: identifier, storeId: identifier }).strict();
export interface OrderLinkScope {
  operatorId: string;
  storeId: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export function orderLink(search: URLSearchParams, state: unknown, scope: OrderLinkScope) {
  const values = search.getAll('orderId'),
    parsed = values.length === 1 ? identifier.safeParse(values[0]) : null;
  const previous = record(state) ? scopeSchema.safeParse(state.orderSelection) : null;
  const bound = previous?.success ? previous.data : null;
  const mismatch = Boolean(
    bound && (bound.operatorId !== scope.operatorId || bound.storeId !== scope.storeId),
  );
  return {
    id: parsed?.success && !mismatch ? parsed.data : '',
    invalid: values.length > 0 && !parsed?.success,
    needsBinding: Boolean(parsed?.success && !bound),
    mismatch,
  };
}
export function orderLinkState(state: unknown, scope: OrderLinkScope | null) {
  const next = record(state) ? { ...state } : {};
  delete next.orderSelection;
  if (scope) next.orderSelection = scopeSchema.parse(scope);
  return next;
}
