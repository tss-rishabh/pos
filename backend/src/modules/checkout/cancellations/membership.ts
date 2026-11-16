import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HasProduct, MUser, Order } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { assertNativeMembershipFence } from './membership-fence.js';
import { activeCheckoutCustomer } from '../customer-access.js';
import { operationHash } from '../crypto.js';
import { checkoutHeaderHashSql } from '../projection.js';
import {
  cancellationMembershipContract,
  stagedCancellationMembershipContract,
  type CancellationBenefitProfile,
  type CancellationBenefitScope,
  type CancellationBenefitSummary,
} from './benefit-contracts.js';
import {
  cancellationMembershipRows as eav,
  cancellationMembershipVersions as versions,
  cancellationMembershipProvenance as provenance,
  type MembershipStateRow,
} from './benefit-schema.js';

const attributes = ['EXCLUSIVE_EXPIRY', 'EXCLUSIVE_MEMBER'] as const;
const rowSchema = z
  .object({
    attribute: z.enum(attributes),
    value: z.string().max(65535).nullable(),
    active: z.number().int().nullable(),
    createdAt: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
    updatedAt: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const rowsSchema = z
  .array(rowSchema)
  .max(2)
  .refine((rows) => new Set(rows.map((row) => row.attribute)).size === rows.length);
const refusal = () =>
  new AppError(
    409,
    'CANCELLATION_MEMBERSHIP_RESTORATION_UNVERIFIED',
    'Original membership ownership and current entitlement require reconciliation.',
  );
/** Exact native value identity. Do not hash JavaScript timestamp/number reserializations. */
export const cancellationMembershipHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('attribute',user_eav.attribute,'value',user_eav.value,'active',user_eav.is_active,'created_at',UNIX_TIMESTAMP(user_eav.created_at),'updated_at',UNIX_TIMESTAMP(user_eav.updated_at)) AS CHAR CHARACTER SET utf8mb4),256))";
interface MemberScope {
  orderId: string;
  customerId: string;
  headerHash: string;
  timestamp: string;
}
interface Captured {
  tx: AdministrationTransaction;
  scope: MemberScope;
  entity: string;
  revision: bigint;
  before: MembershipStateRow[];
  operationId: string;
  secret: string;
  used: boolean;
}
export interface MembershipCapture {
  readonly orderId: string;
}
const captured = new WeakMap<MembershipCapture, Captured>();
function ready(profile: CancellationBenefitProfile) {
  if (
    profile.membershipWriterContract !== cancellationMembershipContract ||
    profile.membershipCacheContract !== 'pos-membership-fresh-reader-v1' ||
    !profile.membershipProofKey ||
    Buffer.byteLength(profile.membershipProofKey) < 32
  )
    throw refusal();
  return profile.membershipProofKey;
}
function coherent(rows: MembershipStateRow[], complete = false) {
  if (!rows.length) return !complete;
  if (rows.length !== 2 || rows.some((row) => ![0, 1].includes(row.active ?? -1))) return false;
  const member = rows.find((row) => row.attribute === 'EXCLUSIVE_MEMBER')!,
    expiry = rows.find((row) => row.attribute === 'EXCLUSIVE_EXPIRY')!;
  if (!['1', '2', '3', '4', '5', '6'].includes(member.value ?? '') || !expiry.value) return false;
  try {
    Temporal.PlainDateTime.from(expiry.value.replace(' ', 'T'));
    return true;
  } catch {
    return false;
  }
}
async function current(
  tx: AdministrationTransaction,
  entity: string,
): Promise<MembershipStateRow[]> {
  const rows = await tx
    .select({
      attribute: eav.attribute,
      value: eav.value,
      active: eav.active,
      createdAt: sql<string>`DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(${eav.createdAt}),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s')`,
      updatedAt: sql<string>`DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(${eav.updatedAt}),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s')`,
      hash: sql<string>`${sql.raw(cancellationMembershipHashSql)}`,
    })
    .from(eav)
    .where(and(eq(eav.entity, entity), inArray(eav.attribute, [...attributes])))
    .orderBy(asc(eav.attribute))
    .limit(3)
    .for('update');
  const parsed = rowsSchema.safeParse(rows);
  if (!parsed.success) throw refusal();
  return parsed.data;
}
async function lockIdentity(tx: AdministrationTransaction, scope: MemberScope) {
  identifier.parse(scope.orderId);
  identifier.parse(scope.customerId);
  const [order] = await tx
    .select({ customerId: Order.user, hash: sql<string>`${sql.raw(checkoutHeaderHashSql)}` })
    .from(Order)
    .where(eq(Order.id, BigInt(scope.orderId)))
    .for('update');
  if (!order || String(order.customerId) !== scope.customerId || order.hash !== scope.headerHash)
    throw refusal();
  const [customer] = await tx
    .select({
      id: MUser.id,
      email: MUser.email,
      active: MUser.status,
      blocked: MUser.is_block,
      disabled: MUser.is_disabled,
    })
    .from(MUser)
    .where(eq(MUser.id, order.customerId))
    .for('update');
  if (!customer || !activeCheckoutCustomer(customer) || !customer.email) throw refusal();
  const duplicates = await tx
    .select({ id: MUser.id })
    .from(MUser)
    .where(eq(MUser.email, customer.email))
    .orderBy(asc(MUser.id))
    .limit(2)
    .for('share');
  if (duplicates.length !== 1 || duplicates[0]!.id !== customer.id) throw refusal();
  await assertNativeMembershipFence(tx);
  return customer.email;
}
function proofHash(
  row: {
    orderId: bigint;
    customerId: bigint;
    revision: bigint;
    headerHash: string;
    before: MembershipStateRow[];
    confirmed: MembershipStateRow[];
    contract: string;
    operationId: string;
    createdAt: string;
    entityDigest: string;
  },
  secret: string,
) {
  return operationHash(
    'pending-cancellation.membership-provenance.v2',
    {
      headerHash: row.headerHash,
      before: row.before,
      confirmed: row.confirmed,
      contract: row.contract,
      operationId: row.operationId,
      createdAt: row.createdAt,
      orderId: String(row.orderId),
      customerId: String(row.customerId),
      revision: String(row.revision),
      entityDigest: row.entityDigest,
    },
    secret,
  );
}
/** Compatibility producer: must surround the actual original membership staging/activation in ONE TX. */
export async function captureCancellationMembership(
  tx: AdministrationTransaction,
  scope: MemberScope,
  profile: CancellationBenefitProfile,
  operationId: string,
  membershipProductIds: readonly string[],
): Promise<MembershipCapture> {
  const secret = ready(profile);
  z.uuid().parse(operationId);
  if (secret.length < 32 || !membershipProductIds.length || membershipProductIds.length > 1000)
    throw refusal();
  for (const id of membershipProductIds) identifier.parse(id);
  const entity = await lockIdentity(tx, scope),
    lines = await tx
      .select({ id: HasProduct.id })
      .from(HasProduct)
      .where(
        and(
          eq(HasProduct.order, BigInt(scope.orderId)),
          inArray(
            HasProduct.product,
            membershipProductIds.map((id) => BigInt(id)),
          ),
        ),
      )
      .limit(1)
      .for('update');
  if (!lines.length) throw refusal();
  await tx
    .insert(versions)
    .values({ customerId: BigInt(scope.customerId), revision: 0n })
    .onDuplicateKeyUpdate({ set: { customerId: sql`${versions.customerId}` } });
  const [version] = await tx
    .select()
    .from(versions)
    .where(eq(versions.customerId, BigInt(scope.customerId)))
    .for('update');
  const [existing] = await tx
    .select({ id: provenance.orderId })
    .from(provenance)
    .where(eq(provenance.orderId, BigInt(scope.orderId)))
    .for('update');
  if (!version || existing) throw refusal();
  const before = await current(tx, entity);
  if (!coherent(before)) throw refusal();
  const token = Object.freeze({ orderId: scope.orderId });
  captured.set(token, {
    tx,
    scope,
    entity,
    revision: version.revision,
    before,
    operationId,
    secret,
    used: false,
  });
  return token;
}
/** No post-hoc backfill: an ordinary capture token cannot cross transactions or be reused. */
export async function sealCancellationMembership(
  tx: AdministrationTransaction,
  token: MembershipCapture,
): Promise<void> {
  const state = captured.get(token);
  if (!state || state.tx !== tx || state.used) throw refusal();
  state.used = true;
  const entity = await lockIdentity(tx, state.scope);
  if (entity !== state.entity) throw refusal();
  const [version] = await tx
    .select()
    .from(versions)
    .where(eq(versions.customerId, BigInt(state.scope.customerId)))
    .for('update');
  const confirmed = await current(tx, entity);
  if (!version || version.revision < state.revision || !coherent(confirmed, true)) throw refusal();
  const record = {
    orderId: BigInt(state.scope.orderId),
    customerId: BigInt(state.scope.customerId),
    revision: version.revision + 1n,
    headerHash: state.scope.headerHash,
    before: state.before,
    confirmed,
    contract: cancellationMembershipContract,
    operationId: state.operationId,
    createdAt: state.scope.timestamp,
    entityDigest: operationHash('pending-cancellation.membership-entity.v1', entity, state.secret),
  };
  await tx
    .update(versions)
    .set({ revision: record.revision })
    .where(eq(versions.customerId, record.customerId));
  await tx.insert(provenance).values({ ...record, proofHash: proofHash(record, state.secret) });
}
interface Restore {
  entity: string;
  revision: bigint;
  before: MembershipStateRow[];
  confirmed: MembershipStateRow[];
  customerId: bigint;
  used: boolean;
  tx: AdministrationTransaction;
}
export interface LockedCancellationMembership {
  readonly fingerprint: string;
  readonly outcome: CancellationBenefitSummary['membership'];
}
const restorations = new WeakMap<LockedCancellationMembership, Restore>();
export async function lockCancellationMembership(
  tx: AdministrationTransaction,
  scope: CancellationBenefitScope,
  profile: CancellationBenefitProfile,
): Promise<LockedCancellationMembership> {
  const secret = ready(profile);
  const entity = await lockIdentity(tx, scope);
  const [version] = await tx
    .select()
    .from(versions)
    .where(eq(versions.customerId, BigInt(scope.customerId)))
    .for('update');
  const [record] = await tx
    .select()
    .from(provenance)
    .where(eq(provenance.orderId, BigInt(scope.orderId)))
    .for('update');
  if (
    !version ||
    !record ||
    record.customerId !== BigInt(scope.customerId) ||
    record.revision !== version.revision ||
    record.headerHash !== scope.headerHash ||
    ![cancellationMembershipContract, stagedCancellationMembershipContract].includes(
      record.contract,
    ) ||
    !record.entityDigest ||
    record.entityDigest !==
      operationHash('pending-cancellation.membership-entity.v1', entity, secret)
  )
    throw refusal();
  const parsedBefore = rowsSchema.safeParse(record.before),
    parsedConfirmed = rowsSchema.safeParse(record.confirmed);
  if (!parsedBefore.success || !parsedConfirmed.success) throw refusal();
  const before = parsedBefore.data,
    confirmed = parsedConfirmed.data,
    present = await current(tx, entity);
  if (
    !coherent(before) ||
    !coherent(confirmed, true) ||
    record.proofHash !==
      proofHash({ ...record, before, confirmed, entityDigest: record.entityDigest! }, secret) ||
    JSON.stringify(present) !== JSON.stringify(confirmed)
  )
    throw refusal();
  const restored = before.some((row) => row.attribute === 'EXCLUSIVE_MEMBER' && row.active === 1),
    unchanged = JSON.stringify(before) === JSON.stringify(confirmed);
  const plan = Object.freeze({
    fingerprint: record.proofHash,
    outcome: unchanged ? 'unchanged' : restored ? 'prior-entitlement-restored' : 'deactivated',
  } as const);
  restorations.set(plan, {
    entity,
    revision: record.revision,
    before,
    confirmed,
    customerId: record.customerId,
    used: false,
    tx,
  });
  return plan;
}
export async function applyCancellationMembership(
  tx: AdministrationTransaction,
  plan: LockedCancellationMembership,
): Promise<void> {
  const state = restorations.get(plan);
  if (!state || state.tx !== tx || state.used) throw refusal();
  state.used = true;
  const present = await current(tx, state.entity);
  if (JSON.stringify(present) !== JSON.stringify(state.confirmed)) throw refusal();
  for (const attribute of attributes) {
    const before = state.before.find((row) => row.attribute === attribute),
      where = and(eq(eav.entity, state.entity), eq(eav.attribute, attribute));
    if (before)
      await tx
        .update(eav)
        .set({
          value: before.value,
          active: before.active,
          createdAt: sql`FROM_UNIXTIME(${Number(Temporal.PlainDateTime.from(before.createdAt.replace(' ', 'T')).toZonedDateTime('UTC').epochMilliseconds / 1000)})`,
          updatedAt: sql`FROM_UNIXTIME(${Number(Temporal.PlainDateTime.from(before.updatedAt.replace(' ', 'T')).toZonedDateTime('UTC').epochMilliseconds / 1000)})`,
        })
        .where(where);
    else await tx.delete(eav).where(where);
  }
  await tx
    .update(versions)
    .set({ revision: sql`${versions.revision} + 1` })
    .where(eq(versions.customerId, state.customerId));
}
