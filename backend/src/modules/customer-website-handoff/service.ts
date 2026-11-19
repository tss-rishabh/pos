import { createHmac } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { MUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { customerCheckoutScope } from '../customer-insights/checkout-scope.js';
import type { WebsiteHandoffResult, WebsiteHandoffScope } from './contracts.js';
import {
  handoffUnavailable,
  readCustomerWebsiteHandoffOptions,
  websiteBase,
  type CustomerWebsiteHandoffOptions,
} from './options.js';

/**
 * PyJWT 2.8 `jwt.encode(payload, key, algorithm)` as legacy `Helpers.encodeJwt` /
 * `encodeJwt512` call it: header keys sorted (`{"alg":…,"typ":"JWT"}`), compact separators,
 * payload keys in insertion order, base64url without padding.
 */
export function encodeLegacyJwt(
  payload: Record<string, string | number | boolean>,
  key: string,
  algorithm: 'HS256' | 'HS512',
): string {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: 'JWT' })).toString('base64url'),
    body = Buffer.from(JSON.stringify(payload)).toString('base64url'),
    message = `${header}.${body}`,
    signature = createHmac(algorithm === 'HS512' ? 'sha512' : 'sha256', key)
      .update(message)
      .digest('base64url');
  return `${message}.${signature}`;
}
/**
 * Legacy `Helpers.create_token(user_id, expiry_in_min=JWT_CUSTOM_EXPIRY_MIN)`
 * (`helpers/helpers.py:533-564`): `{sub, iat, exp}` as epoch seconds (float), HS512 with a
 * `2f.` prefix when `users.is_two_fa == 1`, else HS256. No `iev` claim (email is not passed).
 */
export function legacyCustomerToken(
  customerId: string,
  twoFactor: boolean,
  options: CustomerWebsiteHandoffOptions,
  now: number,
): string {
  const key = twoFactor ? options.TSS_JWT_HS512_KEY : options.TSS_JWT_HS256_KEY;
  if (!key) throw handoffUnavailable();
  const payload = {
    sub: customerId,
    iat: now / 1000,
    exp: (now + options.JWT_CUSTOM_EXPIRY_MIN * 60_000) / 1000,
  };
  return twoFactor
    ? '2f.' + encodeLegacyJwt(payload, key, 'HS512')
    : encodeLegacyJwt(payload, key, 'HS256');
}
/** `f"{WEB_URL}/pos/login/?token={token}&api_key={…}&pos_store_id={…}&pos_user_id={…}"`. */
export function legacyWebsiteUrl(
  base: string,
  token: string,
  apiKey: string,
  storeId: string,
  operatorCustomerId: string,
): string {
  return `${base}/pos/login/?token=${token}&api_key=${encodeURIComponent(apiKey)}&pos_store_id=${storeId}&pos_user_id=${operatorCustomerId}`;
}

export function customerWebsiteHandoffService(
  config: Config,
  db: Databases,
  options: CustomerWebsiteHandoffOptions = readCustomerWebsiteHandoffOptions(),
  clock: () => number = Date.now,
) {
  const withCheckout = customerCheckoutScope(config, db);
  return {
    /**
     * Legacy `AjaxOnlineOrderView.post` (`order/views.py:4495-4516`). Security (W5): legacy
     * signs a website login for any posted `user_id`; the rewrite only signs for the customer
     * attached to this operator's own checkout and only while that customer is verified,
     * which is exactly when the legacy page shows the link (`create_order.html:657`).
     */
    async issue(user: Principal, scope: WebsiteHandoffScope): Promise<WebsiteHandoffResult> {
      const base = websiteBase(options);
      return withCheckout(user, scope, 'share', async (tx, state) => {
        if (!state.verifiedCustomerUntil || state.verifiedCustomerUntil <= clock())
          throw new AppError(
            403,
            'CUSTOMER_VERIFICATION_REQUIRED',
            'Verify this customer before placing a website order.',
          );
        const [customer] = await tx
          .select({ twoFactor: MUser.is_two_fa })
          .from(MUser)
          .where(eq(MUser.id, BigInt(state.customerId)))
          .limit(1);
        if (!customer)
          throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'This customer account was not found.');
        // `MUser.objects.filter(pos_admin_id=request.user.id).first()`; 0 when missing.
        const [operatorCustomer] = await tx
          .select({ id: MUser.id })
          .from(MUser)
          .where(eq(MUser.pos_admin_id, BigInt(user.id)))
          .orderBy(asc(MUser.id))
          .limit(1);
        const token = legacyCustomerToken(
          state.customerId,
          customer.twoFactor === 1,
          options,
          clock(),
        );
        return {
          webUrl: legacyWebsiteUrl(
            base,
            token,
            options.WEB_LOGIN_API_KEY,
            scope.storeId,
            operatorCustomer ? String(operatorCustomer.id) : '0',
          ),
          sessionMinutes: options.JWT_CUSTOM_EXPIRY_MIN,
        };
      });
    },
  };
}
