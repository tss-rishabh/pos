import { z } from 'zod';
import { request } from '../../api/client';

export interface CustomerContactScope {
  operatorId: string;
  storeId: string;
  checkoutId: string;
  customerId: string;
}
const positiveId = z.string().regex(/^[1-9]\d{0,18}$/);
export const contactWorkspace = z
  .object({
    customerId: positiveId,
    email: z.string(),
    canAddTelephone: z.boolean(),
    canChangeEmail: z.boolean(),
  })
  .strict();
export type ContactWorkspace = z.infer<typeof contactWorkspace>;
/** Legacy client rule (`create_order.html:7836-7840`). */
export const mobilePattern = /^\d{10}$/;
/** Legacy client rule (`create_order.html:7952`), without exponential backtracking. */
export const emailPattern = /^\w+(?:[.-]\w+)*@\w+(?:[.-]\w+)*(?:\.\w{2,3})+$/;
const base = (scope: CustomerContactScope) =>
  `/api/v1/stores/${positiveId.parse(scope.storeId)}/checkout-sessions/${z.uuid().parse(scope.checkoutId)}/customer-contacts`;
export async function readContactWorkspace(scope: CustomerContactScope, signal: AbortSignal) {
  const value = await request(
    base(scope),
    { operatorId: scope.operatorId, signal, cache: 'no-store' },
    contactWorkspace,
  );
  if (value.customerId !== scope.customerId) throw new Error('The sale customer changed.');
  return value;
}
/** Legacy `ajax-m-user-mobile`. */
export function saveTelephone(
  scope: CustomerContactScope,
  phoneNumber: string,
  signal: AbortSignal,
) {
  return request(
    base(scope) + '/telephone',
    {
      method: 'POST',
      operatorId: scope.operatorId,
      signal,
      body: JSON.stringify({ phoneNumber }),
    },
    z.object({ message: z.string(), mobile: z.string() }).strict(),
  );
}
/** Legacy `ajax-m-user-email`. */
export function saveEmail(scope: CustomerContactScope, email: string, signal: AbortSignal) {
  return request(
    base(scope) + '/email',
    { method: 'POST', operatorId: scope.operatorId, signal, body: JSON.stringify({ email }) },
    z.object({ message: z.string(), email: z.string() }).strict(),
  );
}
