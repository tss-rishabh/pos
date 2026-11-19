import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';

export const legacyId = z.string().regex(/^[1-9]\d{0,19}$/);
const optionalUrl = z.string().url().nullable();

/** GET /api/v1/stores/:storeId/legacy-fulfillment/orders/:orderId (legacy online-order HL block). */
export const localDeliveryStatus = z
  .object({
    orderId: legacyId,
    storeId: z.string().nullable(),
    split: z.boolean(),
    orderStatusId: z.string(),
    paymentStatusId: z.string(),
    transferred: z.boolean(),
    nextStoreIds: z.array(legacyId),
    eligibleStoreIds: z.array(z.string()),
    childOrderId: legacyId.nullable(),
    courier: z
      .object({
        action: z.enum(['ACCEPTED', 'DECLINED', 'NO_ACTION', 'CREATION_FAILED', 'CONVERT_ONLINE']),
        courierOrderId: z.string().nullable(),
        created: z.boolean(),
        packed: z.boolean(),
        rto: z.boolean(),
        rtoReceived: z.boolean(),
        refunded: z.boolean(),
        sourceTrackingUrl: optionalUrl,
        destinationTrackingUrl: optionalUrl,
      })
      .nullable(),
    check: z.object({ status: z.enum(['200', '400']), message: z.string(), error: z.string() }),
  })
  .strict();
export type LocalDeliveryStatus = z.infer<typeof localDeliveryStatus>;
export const actionReply = z.object({ status: z.string(), message: z.string() }).passthrough();

/** Legacy pass-order reasons (`order/templates/order/online/show.html:569-576`). */
export const passReasons = [
  'Product not available at store',
  'Packaging material not available at store',
  'Printer not available at store',
  'Bandwidth issue at store',
] as const;
/** Legacy `hl_cancel_reason` (`order/views.py:627-632`); chosen in the UI, not sent (as legacy). */
export const cancelReasons = [
  'Delivery Not possible',
  'Stock not availble',
  'Testing order',
  'Courier partner unavailable',
] as const;
const terminal = ['ACCEPTED', 'DECLINED', 'CONVERT_ONLINE'];
/** Order status 28/29 = RTO, as the legacy template checks (`show.html:132`). */
export const rtoOrder = (status: LocalDeliveryStatus) =>
  status.orderStatusId === '28' || status.orderStatusId === '29' || !!status.courier?.rto;
/** Legacy accept/pass visibility (`show.html:220-228`): no terminal action, paid, still placed. */
export const awaitingAcceptance = (status: LocalDeliveryStatus) =>
  !terminal.includes(status.courier?.action ?? '') &&
  status.paymentStatusId === '4' &&
  (status.orderStatusId === '1' || status.split);

export const deliveryQueryKey = (user: Principal, storeId: string, orderId: string) => [
  user.id,
  'local-delivery',
  storeId,
  orderId,
];
export function useLocalDeliveryStatus(
  user: Principal,
  storeId: string,
  orderId: string,
  online: boolean,
) {
  return useQuery({
    queryKey: deliveryQueryKey(user, storeId, orderId),
    enabled: online,
    retry: false,
    gcTime: 0,
    queryFn: ({ signal }) => {
      legacyId.parse(storeId);
      legacyId.parse(orderId);
      return request(
        `/api/v1/stores/${storeId}/legacy-fulfillment/orders/${orderId}`,
        { operatorId: user.id, signal, cache: 'no-store' },
        z.object({ data: localDeliveryStatus }),
      );
    },
  });
}
export function deliveryAction(
  user: Principal,
  storeId: string,
  orderId: string,
  path:
    | 'packing'
    | 'rto-receipts'
    | 'courier-requests'
    | 'cancellations'
    | 'transfers'
    | 'online-conversions',
  body: Record<string, string>,
) {
  legacyId.parse(storeId);
  legacyId.parse(orderId);
  const base = ['packing', 'rto-receipts'].includes(path)
    ? `/api/v1/stores/${storeId}/legacy-fulfillment/orders/${orderId}/`
    : `/api/v1/stores/${storeId}/local-deliveries/orders/${orderId}/`;
  return request(
    base + path,
    {
      method: path === 'packing' ? 'PUT' : 'POST',
      body: JSON.stringify(body),
      operatorId: user.id,
    },
    actionReply,
  );
}
