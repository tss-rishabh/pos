import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { AppError } from '../../../domain/errors.js';
import type { OrderSearchInput } from './contracts.js';
import type { OrderSearchOptions } from './options.js';
const weight = z.string().regex(/^(?:[a-f0-9]{2})+$/);
export function searchContactKeys(options: OrderSearchOptions) {
  return (purpose: 'order-phone' | 'user-phone' | 'email', value: string) =>
    options.ORDER_SEARCH_CONTACT_KEY
      ? createHmac('sha256', options.ORDER_SEARCH_CONTACT_KEY)
          .update('pos-order-search-contact-v1\0' + purpose + '\0' + weight.parse(value))
          .digest('hex')
      : '';
}
export function searchContactSelection(db: Databases, options: OrderSearchOptions) {
  const digest = searchContactKeys(options);
  return async (input: OrderSearchInput) => {
    if (!input.mobile && !input.email) return { orderPhone: '', userPhone: '', email: '' };
    if (!options.ORDER_SEARCH_CONTACT_KEY)
      throw new AppError(
        503,
        'ORDER_SEARCH_CONTACT_KEY_REQUIRED',
        'A private comparison-key configuration is required for this historical filter.',
      );
    // Match the actual MySQL per-column collations; this reads no historical facts.
    // utf8mb3 cannot represent astral characters. Do not silently replace them with '?'.
    if (/[\u{10000}-\u{10ffff}]/u.test(input.email))
      throw new AppError(
        400,
        'ORDER_SEARCH_EMAIL_UNREPRESENTABLE',
        'This email filter cannot be represented by the source database.',
      );
    const result = await db.get('primary').execute(sql`SELECT
    LOWER(HEX(WEIGHT_STRING(CONVERT(${input.mobile} USING latin1) COLLATE latin1_swedish_ci AS CHAR(32)))) AS order_phone,
    LOWER(HEX(WEIGHT_STRING(CONVERT(${input.mobile} USING utf8mb3) COLLATE utf8mb3_general_ci AS CHAR(32)))) AS user_phone,
    LOWER(HEX(WEIGHT_STRING(CONVERT(${input.email} USING utf8mb3) COLLATE utf8mb3_general_ci AS CHAR(96)))) AS email`);
    const parsed = z
        .array(z.object({ order_phone: weight, user_phone: weight, email: weight }))
        .length(1)
        .parse(result[0]),
      row = parsed[0]!;
    return {
      orderPhone: digest('order-phone', row.order_phone),
      userPhone: digest('user-phone', row.user_phone),
      email: digest('email', row.email),
    };
  };
}
