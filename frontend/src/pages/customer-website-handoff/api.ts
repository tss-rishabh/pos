import { z } from 'zod';
import { request } from '../../api/client';

const contract = z.literal('pos-customer-website-handoff-v1');
const positiveId = z.string().regex(/^[1-9]\d{0,18}$/);
export const websiteCapabilitiesSchema = z
  .object({
    contract,
    available: z.boolean(),
    requiresVerification: z.boolean(),
    checkoutVersion: z.number().int().nonnegative().nullable(),
    receiverOrigin: z.url().nullable(),
  })
  .strict();
export const websiteGrantSchema = z
  .object({
    contract,
    id: z.uuid(),
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    checkoutVersion: z.number().int().nonnegative(),
    url: z.url().max(2048),
    serverNow: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type WebsiteGrant = z.infer<typeof websiteGrantSchema>;
export function websiteHandoffUrl(value: string, receiverOrigin: string) {
  const url = new URL(value),
    origin = new URL(receiverOrigin);
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin.origin ||
    receiverOrigin !== origin.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== '/pos/secure-login' ||
    !/^#[A-Za-z0-9_-]{43}$/.test(url.hash)
  )
    throw new Error('The customer website destination is unavailable.');
  return url.href;
}
const base = (storeId: string, checkoutId: string) =>
  `/api/v1/stores/${positiveId.parse(storeId)}/checkout-sessions/${z.uuid().parse(checkoutId)}/customer-website-handoffs`;
export function websiteCapabilities(
  ownerId: string,
  storeId: string,
  checkoutId: string,
  signal: AbortSignal,
) {
  return request(
    base(storeId, checkoutId) + '/capabilities',
    {
      operatorId: ownerId,
      signal,
      cache: 'no-store',
      redirect: 'error',
    },
    websiteCapabilitiesSchema,
  );
}
export async function issueWebsiteHandoff(
  ownerId: string,
  storeId: string,
  checkoutId: string,
  expectedVersion: number,
  operationId: string,
  signal: AbortSignal,
) {
  const result = await request(
    base(storeId, checkoutId),
    {
      method: 'POST',
      operatorId: ownerId,
      signal,
      cache: 'no-store',
      redirect: 'error',
      body: JSON.stringify({
        operationId: z.uuid().parse(operationId),
        expectedVersion,
        customerConsent: true,
      }),
    },
    websiteGrantSchema,
  );
  if (
    result.checkoutId !== checkoutId ||
    result.checkoutVersion !== expectedVersion ||
    result.operationId !== operationId ||
    result.expiresAt <= result.serverNow ||
    result.expiresAt - result.serverNow > 120000
  )
    throw new Error('This customer or sale changed. Prepare a new website link.');
  return result;
}
export function revokeWebsiteHandoff(
  ownerId: string,
  storeId: string,
  checkoutId: string,
  id: string,
  signal: AbortSignal,
) {
  return request(
    base(storeId, checkoutId) + '/' + z.uuid().parse(id),
    {
      method: 'DELETE',
      operatorId: ownerId,
      signal,
      cache: 'no-store',
      redirect: 'error',
    },
    z.object({ id: z.uuid(), state: z.enum(['ISSUED', 'CONSUMED', 'REVOKED']) }).strict(),
  );
}
