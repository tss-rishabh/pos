import { and, desc, eq } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { MUser, PosUser, Store, StoreDayClose } from '../../db/legacy-schema.js';
import { operatorAuthEpochs } from '../../auth/revocation.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  readCustomerContactBinding,
  sameCustomerContact,
} from '../checkout/customer-contact-authority.js';
import { contactActorVersion } from '../customer-contacts/authority.js';
import { authorizeLegacyOrderImport } from './authorization.js';
import type { ImportFinancialScope } from './financial-contracts.js';
import type { LegacyOrderImportPlan } from './plans.js';
import type { Config } from '../../config.js';
import {
  financialImportAuthoritySchema,
  financialImportCloseSchema,
  type FinancialImportAuthority,
} from './financial-adapter-contracts.js';
import { importFinancialError } from './financial-adapter-crypto.js';
export async function lockFinancialImportScope(
  tx: AdministrationTransaction,
  scope: ImportFinancialScope,
  lock: 'share' | 'update' = 'update',
) {
  const [actor] = await tx
    .select({
      id: PosUser.id,
      active: PosUser.is_active,
      role: PosUser.role,
      userType: PosUser.user_type,
    })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(scope.actorId)))
    .limit(1)
    .for('share');
  if (!actor?.active || actor.userType !== 1 || ![1, 2, 3].includes(actor.role))
    throw importFinancialError('ORDER_IMPORT_ADMINISTRATION_DENIED', 403);
  const version = await contactActorVersion(tx, scope.actorId),
    [epoch] = await tx
      .select({ value: operatorAuthEpochs.epoch })
      .from(operatorAuthEpochs)
      .where(eq(operatorAuthEpochs.userId, scope.actorId))
      .limit(1)
      .for('share');
  const [store] = await tx
    .select({ id: Store.id })
    .from(Store)
    .where(eq(Store.id, BigInt(scope.storeId)))
    .limit(1)
    .for(lock);
  if (!store) throw importFinancialError('ORDER_IMPORT_STORE_UNAVAILABLE');
  await authorizeLegacyOrderImport(tx, scope.actorId, [
    { storeId: scope.storeId, counterId: scope.counterId },
  ]);
  return { actorVersion: version, actorEpoch: String(epoch?.value ?? 0n) };
}
export async function currentImportClose(
  tx: AdministrationTransaction,
  scope: ImportFinancialScope,
  date: string,
) {
  const [row] = await tx
    .select({ id: StoreDayClose.id, version: StoreDayClose.version, status: StoreDayClose.status })
    .from(StoreDayClose)
    .where(
      and(eq(StoreDayClose.store_id, Number(scope.storeId)), eq(StoreDayClose.close_date, date)),
    )
    .orderBy(desc(StoreDayClose.version))
    .limit(1)
    .for('update');
  return row
    ? financialImportCloseSchema.parse({
        id: String(row.id),
        version: row.version,
        status: row.status,
      })
    : null;
}
export async function resolveImportCustomer(
  tx: AdministrationTransaction,
  scope: ImportFinancialScope,
  plan: LegacyOrderImportPlan,
) {
  let matches = plan.email
    ? await tx
        .select({ id: MUser.id })
        .from(MUser)
        .where(eq(MUser.email, plan.email))
        .orderBy(MUser.id)
        .limit(2)
        .for('update')
    : [];
  if (matches.length > 1) throw importFinancialError('ORDER_IMPORT_CUSTOMER_AMBIGUOUS');
  if (!matches.length && plan.kind === 'offline')
    matches = await tx
      .select({ id: MUser.id })
      .from(MUser)
      .where(and(eq(MUser.pos_admin_id, BigInt(scope.actorId)), eq(MUser.user_type, '8')))
      .orderBy(MUser.id)
      .limit(2)
      .for('update');
  if (matches.length !== 1) throw importFinancialError('ORDER_IMPORT_CUSTOMER_UNAVAILABLE');
  const customerId = String(matches[0]!.id),
    contact = await readCustomerContactBinding(tx, customerId);
  return { customerId, contact };
}
export async function captureFinancialImportAuthority(
  tx: AdministrationTransaction,
  config: Config,
  scope: ImportFinancialScope,
  plan: LegacyOrderImportPlan,
  now: number,
) {
  if (plan.storeId !== scope.storeId) throw importFinancialError('ORDER_IMPORT_SCOPE_CHANGED');
  const created = Temporal.PlainDateTime.from(plan.createdAt.replace(' ', 'T'))
    .toZonedDateTime(config.BUSINESS_TIMEZONE)
    .toInstant();
  if (created.epochMilliseconds > now) throw importFinancialError('ORDER_IMPORT_FUTURE_DATE');
  const actor = await lockFinancialImportScope(tx, scope, 'share'),
    close = await currentImportClose(tx, scope, plan.createdAt.slice(0, 10)),
    customer = await resolveImportCustomer(tx, scope, plan);
  return financialImportAuthoritySchema.parse({ ...actor, ...customer, close, approvalId: null });
}
export async function assertFinancialImportAuthority(
  tx: AdministrationTransaction,
  scope: ImportFinancialScope,
  original: FinancialImportAuthority,
) {
  const actor = await lockFinancialImportScope(tx, scope),
    contact = await readCustomerContactBinding(tx, original.customerId);
  if (
    actor.actorVersion !== original.actorVersion ||
    actor.actorEpoch !== original.actorEpoch ||
    !sameCustomerContact(contact, original.contact)
  )
    throw importFinancialError('ORDER_IMPORT_AUTHORITY_CHANGED');
  return original;
}
export function importNeedsPeriodApproval(
  config: Config,
  plan: LegacyOrderImportPlan,
  authority: FinancialImportAuthority,
  now: number,
) {
  const today = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
    .toPlainDate()
    .toString();
  return plan.createdAt.slice(0, 10) !== today || authority.close !== null;
}
