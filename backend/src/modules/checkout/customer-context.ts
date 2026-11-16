import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';

export const customerContextContract = 'pos-customer-context-v1';
export interface CustomerContextConfiguration {
  customerContextContract?: string;
  customerContextKey?: string;
  hs256?: string;
  hs512?: string;
}

export function assertCustomerContextReady(environment: CustomerContextConfiguration): void {
  if (!customerContextConfigured(environment))
    throw new AppError(
      503,
      'CUSTOMER_CONTEXT_CONTRACT_UNVERIFIED',
      'Fresh customer context is not configured for checkout.',
    );
}
export function customerContextConfigured(environment: CustomerContextConfiguration): boolean {
  return (
    environment.customerContextContract === customerContextContract &&
    typeof environment.customerContextKey === 'string' &&
    /^[\x21-\x7e]{32,4096}$/.test(environment.customerContextKey)
  );
}

/** Only the JWTs issued by this backend can bind a private context response. */
export function checkoutTokenSubject(
  token: string | undefined,
  environment: CustomerContextConfiguration,
  now = Date.now(),
): string {
  const invalid = () =>
    new AppError(
      503,
      'CUSTOMER_CONTEXT_IDENTITY_INVALID',
      'The checkout identity could not be verified.',
    );
  if (!token || token.length > 8192) throw invalid();
  const twoFactor = token.startsWith('2f.');
  const parts = (twoFactor ? token.slice(3) : token).split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const key = twoFactor ? environment.hs512 : environment.hs256;
  if (!key || key.length < 32) throw invalid();
  const expected = createHmac(twoFactor ? 'sha512' : 'sha256', key)
    .update(`${encodedHeader}.${encodedClaims}`)
    .digest();
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (
    signature.toString('base64url') !== encodedSignature ||
    signature.length !== expected.length ||
    !timingSafeEqual(expected, signature)
  )
    throw invalid();
  try {
    const header = z
      .object({ alg: z.literal(twoFactor ? 'HS512' : 'HS256'), typ: z.literal('JWT') })
      .strict()
      .parse(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')));
    const claims = z
      .object({
        sub: identifier,
        iat: z.number().int().nonnegative(),
        exp: z.number().int().positive(),
        iev: z.literal(true).optional(),
      })
      .strict()
      .parse(JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')));
    if (
      header.alg !== (twoFactor ? 'HS512' : 'HS256') ||
      claims.iat > Math.floor(now / 1000) + 30 ||
      claims.exp <= Math.floor(now / 1000) ||
      claims.exp <= claims.iat
    )
      throw invalid();
    return claims.sub;
  } catch {
    throw invalid();
  }
}

export const customerContextSegments = [
  'cart',
  'pos/cart',
  'pos/product',
  'pos/order',
  'validatecheckout',
  'processorder',
  'coupon',
  'wallet',
  'giftvoucher',
  'pg',
  'store-discount-pg',
] as const;
export function usesCustomerContext(segment: string): boolean {
  return customerContextSegments.some((candidate) => candidate === segment);
}
