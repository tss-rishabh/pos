import { timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { MUser } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { readCurrentContactRevision } from '../customer-contacts/revisions.js';
import { activeCheckoutCustomer } from './customer-access.js';

const revision = /^(?:0|[1-9]\d{0,19})$/;
export const customerContactBindingSchema = z
  .object({
    revision: z
      .string()
      .regex(revision)
      .refine((value) => revision.test(value) && BigInt(value) <= 18446744073709551615n),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CustomerContactBinding = z.infer<typeof customerContactBindingSchema>;
/** Native bytes, shared verbatim with the ordinary projection adapter. Never log this digest. */
export const customerContactDigestExpression =
  "LOWER(SHA2(CAST(JSON_OBJECT('customer_id',users.id,'email',users.email,'telephone',users.telephone) AS CHAR CHARACTER SET utf8mb4),256))";
export const customerContactDigestSql = sql<string>`${sql.raw(customerContactDigestExpression)}`;
export async function readCustomerContactBinding(
  transaction: AdministrationTransaction,
  customerId: string,
): Promise<CustomerContactBinding> {
  identifier.parse(customerId);
  const [customer] = await transaction
    .select({
      active: MUser.status,
      blocked: MUser.is_block,
      disabled: MUser.is_disabled,
      digest: customerContactDigestSql,
    })
    .from(MUser)
    .where(eq(MUser.id, BigInt(customerId)))
    .limit(1)
    .for('share');
  if (!customer || !activeCheckoutCustomer(customer))
    throw new AppError(
      409,
      'CHECKOUT_CUSTOMER_UNAVAILABLE',
      'The customer account could not be confirmed.',
    );
  const current = await readCurrentContactRevision(transaction, customerId);
  return customerContactBindingSchema.parse({ revision: String(current), digest: customer.digest });
}
export function sameCustomerContact(
  left: CustomerContactBinding | null | undefined,
  right: CustomerContactBinding | null | undefined,
) {
  const a = customerContactBindingSchema.safeParse(left),
    b = customerContactBindingSchema.safeParse(right);
  return (
    a.success &&
    b.success &&
    a.data.revision === b.data.revision &&
    timingSafeEqual(Buffer.from(a.data.digest, 'hex'), Buffer.from(b.data.digest, 'hex'))
  );
}
