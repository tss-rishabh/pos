import { createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../../domain/errors.js';
import type { CustomerIdentity } from './contracts.js';

export function issueCustomerToken(
  customer: CustomerIdentity,
  keys: { hs256?: string; hs512?: string },
  now = Date.now(),
  expirySeconds = 3600,
): string {
  if (!customer.active)
    throw new AppError(403, 'CUSTOMER_DISABLED', 'This customer account is disabled.');
  const key = customer.twoFactor ? keys.hs512 : keys.hs256;
  if (!key || key.length < 32)
    throw new AppError(
      503,
      'CHECKOUT_IDENTITY_UNAVAILABLE',
      'Checkout identity signing is not configured.',
    );
  const algorithm = customer.twoFactor ? 'HS512' : 'HS256';
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: customer.id,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + expirySeconds,
      // Legacy checkout tokens never carry `iev`: every checkout caller of
      // Helpers.create_token passes only user_id (helpers/helpers.py:535-564,
      // order/views.py:1522, 1534, 2010, 2060).
    }),
  ).toString('base64url');
  const message = `${header}.${payload}`,
    signature = createHmac(customer.twoFactor ? 'sha512' : 'sha256', key)
      .update(message)
      .digest('base64url');
  return `${customer.twoFactor ? '2f.' : ''}${message}.${signature}`;
}
export function newTabId(): number {
  return Number(BigInt('0x' + randomBytes(6).toString('hex'))) + 1;
}
export function newGiftItemId(): string {
  const value = BigInt('0x' + randomBytes(8).toString('hex')) & ((1n << 63n) - 1n);
  return (value || 1n).toString();
}
export function operationHash(kind: string, input: unknown, secret: string): string {
  if (secret.length < 32)
    throw new AppError(
      503,
      'CHECKOUT_IDENTITY_UNAVAILABLE',
      'Checkout identity signing is not configured.',
    );
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, normalize(v)]),
          )
        : value;
  return createHmac('sha256', secret)
    .update(JSON.stringify({ kind, input: normalize(input) }))
    .digest('hex');
}
