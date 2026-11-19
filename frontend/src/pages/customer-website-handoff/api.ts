import { z } from 'zod';
import { request } from '../../api/client';

const positiveId = z.string().regex(/^[1-9]\d{0,18}$/);
export const websiteHandoffSchema = z
  .object({ webUrl: z.url().max(4096), sessionMinutes: z.number().int().positive() })
  .strict();
export type WebsiteHandoff = z.infer<typeof websiteHandoffSchema>;
/** Only the legacy website login page over HTTPS may be opened. */
export function websiteHandoffUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/pos/login/')
    throw new Error('The customer website destination is unavailable.');
  return url.href;
}
const base = (storeId: string, checkoutId: string) =>
  `/api/v1/stores/${positiveId.parse(storeId)}/checkout-sessions/${z.uuid().parse(checkoutId)}/customer-website-handoffs`;
/** Legacy `ajax-online-order/`: a website login URL for the checkout's verified customer. */
export function issueWebsiteHandoff(
  ownerId: string,
  storeId: string,
  checkoutId: string,
  signal: AbortSignal,
) {
  return request(
    base(storeId, checkoutId),
    {
      method: 'POST',
      operatorId: ownerId,
      signal,
      cache: 'no-store',
      redirect: 'error',
      body: JSON.stringify({}),
    },
    websiteHandoffSchema,
  );
}
