import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { bigint, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import { HasProduct, MUser, Order } from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { operationHash } from '../crypto.js';
import { checkoutHeaderHashSql } from '../projection.js';
import {
  issuedVouchers,
  giftCardIssuances,
  giftCardIssuanceHashSql,
  assertPendingGiftCardIssuance,
  assertCompletedGiftCardIssuance,
} from '../gift-card-issuance.js';
import { assertNativeMembershipFence } from '../cancellations/membership-fence.js';
import {
  cancellationMembershipRows as eav,
  cancellationMembershipVersions as versions,
  cancellationMembershipProvenance as provenance,
} from '../cancellations/benefit-schema.js';
import {
  applyCancellationMembership,
  lockCancellationMembership,
  cancellationMembershipHashSql,
} from '../cancellations/membership.js';
import type { CancellationBenefitProfile } from '../cancellations/benefit-contracts.js';
import {
  csvMembershipProvenanceSchema,
  membershipProvenanceHash,
  stagedMembershipContract,
  activatedMembershipContract,
} from '../../legacy-order-imports/membership-profile/domain.js';
import { publicScreeningBenefitSchema, type PublicScreeningBenefits } from './benefit-contracts.js';
import {
  publicScreeningHash,
  screeningReconciliationRequired,
  type PublicScreeningCreation,
} from './proof.js';

export const publicScreeningBenefits = mysqlTable('pos_rewrite_public_screening_benefits', {
  operationId: varchar('operation_id', { length: 36 }).primaryKey(),
  orderId: varchar('order_id', { length: 32 }).notNull(),
  data: json('data').$type<PublicScreeningBenefits>().notNull(),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
});
export interface PublicBenefitVerification {
  membershipProofKey?: string;
}
const publicBenefitCache = mysqlTable('pos_rewrite_public_screening_benefit_cache', {
  operationId: varchar('operation_id', { length: 36 }).primaryKey(),
  data: json('data').$type<unknown>().notNull(),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
});
// Verified native column is absent from the inherited Django model mapping.
const giftLines = mysqlTable('has_products', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  order: bigint('order_id', { mode: 'bigint' }).notNull(),
  product: bigint('prod_id', { mode: 'bigint' }).notNull(),
  quantity: bigint('qty', { mode: 'bigint' }).notNull(),
  voucher: bigint('gift_voucher_id', { mode: 'bigint' }).notNull(),
});
/** Immutable source evidence only. Current entitlement is deliberately separate
 * so a completed receipt can be read after a later legitimate membership edit. */
export async function readPublicBenefits(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  key: string,
): Promise<PublicScreeningBenefits | null> {
  if (!creation.benefitsHash) return null;
  const [row] = await tx
    .select()
    .from(publicScreeningBenefits)
    .where(
      and(
        eq(publicScreeningBenefits.operationId, creation.operationId),
        sql`OCTET_LENGTH(${publicScreeningBenefits.data})<=64000`,
      ),
    )
    .limit(1)
    .for('share');
  if (!row) throw screeningReconciliationRequired();
  const value = publicScreeningBenefitSchema.parse(row.data);
  if (
    row.orderId !== creation.orderId ||
    row.proofHash !== creation.benefitsHash ||
    publicScreeningHash(key, 'benefits', value) !== row.proofHash ||
    [
      'operationId',
      'checkoutId',
      'actorId',
      'customerId',
      'storeId',
      'counterId',
      'requestHash',
      'cartHash',
      'orderId',
    ].some(
      (name) => value[name as keyof typeof value] !== creation[name as keyof typeof creation],
    ) ||
    value.createdAt !== creation.createdAt ||
    new Set(value.gifts.map((gift) => gift.voucherId)).size !== value.gifts.length ||
    new Set(value.gifts.map((gift) => gift.lineId)).size !== value.gifts.length
  )
    throw screeningReconciliationRequired();
  return value;
}
async function verifyGiftLines(tx: AdministrationTransaction, value: PublicScreeningBenefits) {
  const vouchers = await tx
    .select({
      id: issuedVouchers.id,
      order: issuedVouchers.orderId,
      customer: issuedVouchers.customerId,
      collection: issuedVouchers.collectionId,
      serial: issuedVouchers.serial,
      hash: sql<string>`${sql.raw(giftCardIssuanceHashSql)}`,
    })
    .from(issuedVouchers)
    .where(eq(issuedVouchers.orderId, BigInt(value.orderId)))
    .orderBy(asc(issuedVouchers.id))
    .limit(101)
    .for('update');
  if (vouchers.length !== value.gifts.length) throw screeningReconciliationRequired();
  for (const expected of value.gifts) {
    const actual = vouchers.find((row) => String(row.id) === expected.voucherId);
    const [line] = await tx
      .select()
      .from(giftLines)
      .where(eq(giftLines.id, BigInt(expected.lineId)))
      .limit(1)
      .for('update');
    if (
      !actual ||
      String(actual.order) !== value.orderId ||
      String(actual.customer) !== value.customerId ||
      String(actual.collection) !== expected.collectionId ||
      String(actual.serial) !== expected.serial ||
      actual.hash !== expected.inputHash ||
      !line ||
      String(line.order) !== value.orderId ||
      String(line.product) !== expected.productId ||
      line.quantity !== 1n ||
      String(line.voucher) !== expected.voucherId
    )
      throw screeningReconciliationRequired();
  }
}
async function verifyMembership(
  tx: AdministrationTransaction,
  value: PublicScreeningBenefits,
  options: PublicBenefitVerification,
  phase: 'staged' | 'confirmed' | 'settled',
) {
  const member = value.membership;
  if (!member) return;
  const key = options.membershipProofKey;
  if (!key || !/^[!-~]{32,4096}$/.test(key)) throw screeningReconciliationRequired();
  const [customer] = await tx
    .select({ id: MUser.id, email: MUser.email })
    .from(MUser)
    .where(eq(MUser.id, BigInt(value.customerId)))
    .limit(1)
    .for('update');
  if (!customer?.email) throw screeningReconciliationRequired();
  const duplicates = await tx
    .select({ id: MUser.id })
    .from(MUser)
    .where(eq(MUser.email, customer.email))
    .limit(2)
    .for('share');
  if (duplicates.length !== 1 || duplicates[0]!.id !== customer.id)
    throw screeningReconciliationRequired();
  await assertNativeMembershipFence(tx);
  const [record] = await tx
    .select()
    .from(provenance)
    .where(eq(provenance.orderId, BigInt(value.orderId)))
    .limit(1)
    .for('update');
  const [version] = await tx
    .select()
    .from(versions)
    .where(eq(versions.customerId, customer.id))
    .limit(1)
    .for('update');
  const [line] = await tx
    .select({
      order: HasProduct.order,
      product: HasProduct.product,
      quantity: HasProduct.qty,
      price: HasProduct.price,
    })
    .from(HasProduct)
    .where(eq(HasProduct.id, BigInt(member.lineId)))
    .limit(1)
    .for('update');
  const [header] = await tx
    .select({ hash: sql<string>`${sql.raw(checkoutHeaderHashSql)}` })
    .from(Order)
    .where(eq(Order.id, BigInt(value.orderId)))
    .limit(1)
    .for('update');
  if (!record || !version || !line || !header) throw screeningReconciliationRequired();
  const current = csvMembershipProvenanceSchema.parse({
    ...record,
    orderId: String(record.orderId),
    customerId: String(record.customerId),
    revision: String(record.revision),
  });
  const staged = member.provenance;
  if (
    staged.contract !== stagedMembershipContract ||
    membershipProvenanceHash(staged, key) !== staged.proofHash ||
    current.proofHash !== membershipProvenanceHash(current, key) ||
    current.orderId !== value.orderId ||
    current.customerId !== value.customerId ||
    current.revision !== String(version.revision) ||
    current.headerHash !== header.hash ||
    current.headerHash !== staged.headerHash ||
    current.operationId !== staged.operationId ||
    current.createdAt !== staged.createdAt ||
    current.entityDigest !== staged.entityDigest ||
    current.entityDigest !==
      operationHash('pending-cancellation.membership-entity.v1', customer.email, key) ||
    JSON.stringify(current.before) !== JSON.stringify(staged.before) ||
    current.contract !==
      (phase === 'staged' ? stagedMembershipContract : activatedMembershipContract) ||
    (phase === 'staged' && current.proofHash !== staged.proofHash) ||
    String(line.order) !== value.orderId ||
    String(line.product) !== member.productId ||
    line.quantity !== 1n ||
    (member.kind === 'auto-free' && line.price !== 0)
  )
    throw screeningReconciliationRequired();
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
    .where(
      and(
        eq(eav.entity, customer.email),
        inArray(eav.attribute, ['EXCLUSIVE_EXPIRY', 'EXCLUSIVE_MEMBER']),
      ),
    )
    .orderBy(asc(eav.attribute))
    .limit(3)
    .for('update');
  if (JSON.stringify(rows) !== JSON.stringify(current.confirmed))
    throw screeningReconciliationRequired();
}
export async function assertPublicBenefits(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  key: string,
  options: PublicBenefitVerification,
  phase: 'staged' | 'confirmed' | 'settled',
) {
  const value = await readPublicBenefits(tx, creation, key);
  if (!value) return null;
  await verifyMembership(tx, value, options, phase);
  if (value.gifts.length) {
    // The shared issuance validator acquires sorted collection rows before
    // vouchers. Keep that prefix before taking any descriptor voucher locks.
    if (phase !== 'settled') await assertPendingGiftCardIssuance(tx, creation.orderId);
    else await assertCompletedGiftCardIssuance(tx, creation.orderId);
  }
  await verifyGiftLines(tx, value);
  return value;
}
/** Called only after the original order's complete no-financial-effect checks,
 * under customer/Order locks. Never delete/reissue a staged physical card. */
export async function abandonPublicBenefits(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  key: string,
  options: PublicBenefitVerification,
  now: number,
) {
  const value = await assertPublicBenefits(tx, creation, key, options, 'staged');
  if (!value) return null;
  if (value.gifts.length) {
    const funded = await tx
      .select({ id: giftCardIssuances.voucherId })
      .from(giftCardIssuances)
      .where(eq(giftCardIssuances.orderId, BigInt(creation.orderId)))
      .limit(1)
      .for('share');
    if (funded.length) throw screeningReconciliationRequired();
  }
  let membership: 'unchanged' | 'deactivated' | 'prior-entitlement-restored' = 'unchanged';
  if (value.membership) {
    const profile: CancellationBenefitProfile = {
      policy: 'pos-cancellation-original-expiry-v1',
      walletWriterContract: 'pos-wallet-user-lock-v1',
      voucherWriterContract: 'pos-voucher-user-lock-v1',
      membershipWriterContract: activatedMembershipContract,
      membershipCacheContract: 'pos-membership-fresh-reader-v1',
      membershipProofKey: options.membershipProofKey,
    };
    const plan = await lockCancellationMembership(
      tx,
      {
        orderId: creation.orderId,
        customerId: creation.customerId,
        voucherId: '0',
        headerHash: value.membership.provenance.headerHash,
        money: 0,
        points: 0,
        voucher: 0,
        lines: [],
        membership: true,
        timestamp: value.membership.provenance.createdAt,
      },
      profile,
    );
    await applyCancellationMembership(tx, plan);
    membership = plan.outcome;
    const [cache] = await tx
      .select()
      .from(publicBenefitCache)
      .where(eq(publicBenefitCache.operationId, creation.operationId))
      .limit(1)
      .for('update');
    if (!cache) throw screeningReconciliationRequired();
    const value = z
      .object({
        contract: z.literal('pos-public-screening-membership-cache-v1'),
        operationId: z.uuid(),
        benefitHash: z.string().regex(/^[a-f0-9]{64}$/),
        completionHash: z.null(),
        status: z.literal('pending'),
        createdAt: z.number().int().positive().safe(),
        updatedAt: z.number().int().positive().safe(),
      })
      .strict()
      .parse(cache.data);
    if (
      cache.status !== 'pending' ||
      value.operationId !== creation.operationId ||
      value.benefitHash !== creation.benefitsHash ||
      value.createdAt !== creation.createdAt ||
      cache.proofHash !== publicScreeningHash(key, 'benefit-cache', value)
    )
      throw screeningReconciliationRequired();
    const cancelled = { ...value, status: 'cancelled', updatedAt: now };
    await tx
      .update(publicBenefitCache)
      .set({
        data: cancelled,
        status: 'cancelled',
        proofHash: publicScreeningHash(key, 'benefit-cache', cancelled),
      })
      .where(eq(publicBenefitCache.operationId, creation.operationId));
  }
  return {
    sourceHash: creation.benefitsHash!,
    membership,
    quarantinedVoucherIds: value.gifts.map((gift) => gift.voucherId),
  };
}
