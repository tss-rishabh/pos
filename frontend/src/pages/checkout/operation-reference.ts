import type { Checkout } from './client';

/** Copy commands have a separate recovery protocol, never /operations/:id. */
export function checkoutOperationReference(
  state: Pick<Checkout, 'busyOperationId' | 'orderCopy'>,
  saved: string | null = null,
): string | null {
  const reference = state.busyOperationId || saved;
  return reference && reference !== state.orderCopy?.commandId ? reference : null;
}
