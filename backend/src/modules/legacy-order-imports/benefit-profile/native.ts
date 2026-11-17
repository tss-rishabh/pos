import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Order, Product } from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { nativeImportOrder } from '../financial-adapter-proof.js';
import { financialImportSourceReceipts } from '../financial-adapter-schema.js';
import { equalImportHash } from '../financial-adapter-crypto.js';
import { benefitDigest } from './crypto.js';
import {
  benefitError,
  benefitReceiptHash,
  couponActivationSchema,
  verifyBenefitSeal,
  type CouponActivation,
} from './contracts.js';
import { verifyCsvBenefitComposition, type BenefitCompositionInput } from './ownership.js';
import {
  importBenefitLines,
  importBenefitCouponControls,
  importBirthdayClaims,
  importCouponLogs,
  importCouponUsers,
  importFreebieGrants,
  importFreebieTriggers,
} from './schema.js';
import { couponHistoryScopeSchema } from './history.js';

export const couponUserHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('id',coupons_users.id,'coupon_id',coupons_users.c_id,'customer_id',coupons_users.user_id,'allowed',coupons_users.coupon_allowed_count,'used',coupons_users.coupon_used_count,'monthly_allowed',coupons_users.coupon_month_allowed_count) AS CHAR CHARACTER SET utf8mb4),256))";
export const couponLogHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('id',order_coupon_log.id,'user_id',order_coupon_log.user_id,'order_id',order_coupon_log.order_id,'coupon_id',order_coupon_log.coupon_id,'status',order_coupon_log.status,'created_at',DATE_FORMAT(order_coupon_log.created_at,'%Y-%m-%d %H:%i:%s'),'updated_at',DATE_FORMAT(order_coupon_log.updated_at,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))";
export const freebieGrantHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('id',order_freebies.id,'order_id',order_freebies.order_id,'has_product_id',order_freebies.has_product_id,'freebie_prod_id',order_freebies.freebie_prod_id,'freebie_id',order_freebies.freebie_id,'freebie_sale_id',order_freebies.freebie_sale_id,'grant_level',order_freebies.grant_level,'trigger_id',order_freebies.trigger_id,'trigger_key',order_freebies.trigger_key,'mov',order_freebies.mov,'qualified_value',order_freebies.qualified_value,'is_exclusive_order',order_freebies.is_exclusive_order,'base_field',order_freebies.base_field,'status',order_freebies.status,'revoked_at',DATE_FORMAT(order_freebies.revoked_at,'%Y-%m-%d %H:%i:%s'),'revoke_reason',order_freebies.revoke_reason,'created_at',DATE_FORMAT(order_freebies.created_at,'%Y-%m-%d %H:%i:%s'),'updated_at',DATE_FORMAT(order_freebies.updated_at,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))";
export const benefitRefundHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('id',has_products.id,'disc',has_products.disc,'refundable',has_products.amount_to_be_refunded) AS CHAR CHARACTER SET utf8mb4),256))";
export const complementaryProductHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('id',products.id,'type',products.prod_type,'price',products.price,'special_price',products.spl_price) AS CHAR CHARACTER SET utf8mb4),256))";
export const couponControlHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('id',coupons.id,'voucher_type',coupons.voucher_type,'disc_apply_items',coupons.disc_apply_items,'min_order_amt',coupons.min_order_amt,'voucher_code',coupons.voucher_code,'voucher_val',coupons.voucher_val,'voucher_valid_for',coupons.voucher_valid_for,'platform',coupons.platform,'voucher_percentage_max_val',coupons.voucher_percentage_max_val,'for_new_user',coupons.for_new_user,'user_specific',coupons.user_specific,'buyable_quantity',coupons.buyable_quantity,'free_quantity',coupons.free_quantity,'is_applicable_on_discounted_products',coupons.is_applicable_on_discounted_products,'voucher_mxn_type',coupons.voucher_mxn_type,'no_times_allowed',coupons.no_times_allowed,'coupon_lot_no',coupons.coupon_lot_no,'unique_no_times_allowed',coupons.unique_no_times_allowed,'message',coupons.message,'user_type',coupons.user_type,'default_country_id',coupons.default_country_id,'is_deleted',coupons.is_deleted,'start_date',DATE_FORMAT(coupons.start_date,'%Y-%m-%d %H:%i:%s'),'end_date',DATE_FORMAT(coupons.end_date,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))";

export async function readCouponUsers(
  tx: AdministrationTransaction,
  customerId: string,
  couponId: string,
) {
  const values = await tx
    .select({
      id: importCouponUsers.id,
      used: importCouponUsers.used,
      allowed: importCouponUsers.allowed,
      monthlyAllowed: importCouponUsers.monthlyAllowed,
      inputHash: sql<string>`${sql.raw(couponUserHashSql)}`,
    })
    .from(importCouponUsers)
    .where(
      and(
        eq(importCouponUsers.customerId, BigInt(customerId)),
        eq(importCouponUsers.couponId, BigInt(couponId)),
      ),
    )
    .orderBy(asc(importCouponUsers.id))
    .limit(1001)
    .for('update');
  if (values.length > 1000) throw benefitError();
  return values.map((row) => ({
    ...row,
    id: String(row.id),
    used: String(row.used),
    allowed: String(row.allowed),
    monthlyAllowed: String(row.monthlyAllowed),
  }));
}
/** Additional checks AFTER existing command, current actor/session/store/customer,
 * order status/hold and source receipt authentication, under the SAME writer TX.
 * No HTTP, BQ, history SELECT or independent transaction is performed here.
 */
export async function assertNativeCsvBenefits(
  tx: AdministrationTransaction,
  input: BenefitCompositionInput & {
    phase: 'staged' | 'settled';
    activation?: { value: unknown; seal: string; confirmationHash: string };
  },
) {
  const result = verifyCsvBenefitComposition(input),
    { order } = input;
  const native = await nativeImportOrder(tx, order.orderId);
  if (
    native.header.headerHash !== order.headerHash ||
    native.lineHash !== order.lineHash ||
    JSON.stringify(native.lines) !== JSON.stringify(order.lines)
  )
    throw benefitError();
  const rows = await tx
    .select({
      id: importBenefitLines.id,
      productId: importBenefitLines.productId,
      type: importBenefitLines.type,
      hash: sql<string>`${sql.raw(benefitRefundHashSql)}`,
      nativePrice: importBenefitLines.price,
      price: sql<string>`CAST(CAST(${importBenefitLines.price} AS DECIMAL(12,2)) AS CHAR)`,
      discount: sql<string>`CAST(CAST(${importBenefitLines.discount} AS DECIMAL(12,2)) AS CHAR)`,
      refundable: sql<string>`CAST(CAST(${importBenefitLines.refundable} AS DECIMAL(12,2)) AS CHAR)`,
    })
    .from(importBenefitLines)
    .where(eq(importBenefitLines.orderId, BigInt(order.orderId)))
    .orderBy(asc(importBenefitLines.id))
    .limit(1001)
    .for('update');
  if (rows.length !== order.lines.length) throw benefitError();
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const owned of result.ownership) {
    if (owned.owner === 'pos-complementary') continue;
    const line = byId.get(owned.id),
      declared = input.plan.lines.find((row) => row.productId === owned.productId);
    // Match the pinned DOUBLE constructor's multiplication, without using this
    // floating-point value for a ledger amount or serializing its native digest.
    const expected = declared ? Number(declared.unitPrice) * owned.quantity : 0;
    if (
      !line ||
      !Number.isFinite(line.nativePrice) ||
      line.nativePrice !== expected ||
      (!declared && owned.owner !== 'membership')
    )
      throw benefitError();
  }
  const free = result.complementary;
  const grants = await tx
    .select({
      id: importFreebieGrants.id,
      lineId: importFreebieGrants.lineId,
      productId: importFreebieGrants.productId,
      freebieId: importFreebieGrants.freebieId,
      saleId: importFreebieGrants.saleId,
      level: importFreebieGrants.level,
      triggerId: importFreebieGrants.triggerId,
      triggerKey: importFreebieGrants.triggerKey,
      mov: importFreebieGrants.mov,
      value: importFreebieGrants.qualifiedValue,
      exclusive: importFreebieGrants.exclusive,
      base: importFreebieGrants.baseField,
      status: importFreebieGrants.status,
      revoked: importFreebieGrants.revokedAt,
      reason: importFreebieGrants.reason,
      hash: sql<string>`${sql.raw(freebieGrantHashSql)}`,
    })
    .from(importFreebieGrants)
    .where(eq(importFreebieGrants.orderId, BigInt(order.orderId)))
    .orderBy(asc(importFreebieGrants.id))
    .limit(1001)
    .for('update');
  const triggers = await tx
    .select({ id: importFreebieTriggers.id })
    .from(importFreebieTriggers)
    .where(eq(importFreebieTriggers.orderId, BigInt(order.orderId)))
    .limit(1)
    .for('update');
  if (grants.length !== (free?.selections.length ?? 0) || triggers.length) throw benefitError();
  const selectedIds = new Set(free?.selections.map((row) => row.line.id));
  if (rows.some((row) => row.type === 'FREEBIE' && !selectedIds.has(String(row.id))))
    throw benefitError();
  if (free) {
    const products = await tx
      .select({
        id: Product.id,
        type: Product.prod_type,
        base: sql<string>`CAST(CAST(IF(${Product.spl_price}>0,${Product.spl_price},${Product.price}) AS DECIMAL(12,2)) AS CHAR)`,
        hash: sql<string>`${sql.raw(complementaryProductHashSql)}`,
      })
      .from(Product)
      .where(
        inArray(
          Product.id,
          free.selections.map((row) => BigInt(row.productId)),
        ),
      )
      .orderBy(asc(Product.id))
      .limit(1001)
      .for('share');
    for (const selected of free.selections) {
      const hp = byId.get(selected.line.id),
        grant = grants.find((row) => String(row.id) === selected.grant.id),
        product = products.find((row) => String(row.id) === selected.productId);
      if (
        !hp ||
        hp.type !== 'FREEBIE' ||
        hp.price !== selected.line.price ||
        hp.discount !== '0.00' ||
        hp.refundable !== selected.line.refundable ||
        hp.hash !== selected.line.refundInputHash ||
        !product ||
        product.type !== 4n ||
        product.hash !== selected.productInputHash ||
        product.base !== selected.catalogBasePrice ||
        !grant ||
        String(grant.lineId) !== selected.line.id ||
        String(grant.productId) !== selected.productId ||
        grant.freebieId !== 0n ||
        grant.saleId !== 0n ||
        grant.triggerId !== 0n ||
        grant.level !== 'POS_MANUAL' ||
        grant.triggerKey !== 'pos_manual:0' ||
        grant.mov !== 0 ||
        grant.value !== '0.00' ||
        grant.exclusive !== 0 ||
        grant.base !== null ||
        grant.status !== 'ACTIVE' ||
        grant.revoked !== null ||
        grant.reason !== null ||
        grant.hash !== selected.grant.inputHash
      )
        throw benefitError();
    }
  }
  const coupon = result.coupon;
  const [header] = await tx
    .select({
      couponId: Order.coupon_used,
      amount: sql<string | null>`CAST(CAST(${Order.coupon_amt_used} AS DECIMAL(12,2)) AS CHAR)`,
      safe: sql<number>`(${Order.cashback_used} IS NULL OR ${Order.cashback_used}=0) AND (${Order.tss_money_used} IS NULL OR ${Order.tss_money_used}=0) AND (${Order.tss_points_used} IS NULL OR ${Order.tss_points_used}=0) AND (${Order.voucher_used} IS NULL OR ${Order.voucher_used}=0) AND (${Order.voucher_amt_used} IS NULL OR ${Order.voucher_amt_used}=0)`.mapWith(
        Number,
      ),
    })
    .from(Order)
    .where(eq(Order.id, BigInt(order.orderId)))
    .limit(1)
    .for('update');
  if (!header || header.safe !== 1) throw benefitError();
  const logs = await tx
    .select({
      id: importCouponLogs.id,
      customerId: importCouponLogs.customerId,
      couponId: importCouponLogs.couponId,
      status: importCouponLogs.status,
      hash: sql<string>`${sql.raw(couponLogHashSql)}`,
    })
    .from(importCouponLogs)
    .where(eq(importCouponLogs.orderId, BigInt(order.orderId)))
    .orderBy(asc(importCouponLogs.id))
    .limit(2)
    .for('update');
  if (!coupon) {
    if (logs.length || input.activation || (header.couponId !== null && header.couponId !== 0n))
      throw benefitError();
    return result;
  }
  if (BigInt(coupon.couponId) > 2147483647n) throw benefitError();
  const couponControls = await tx
    .select({ hash: sql<string>`${sql.raw(couponControlHashSql)}` })
    .from(importBenefitCouponControls)
    .where(eq(importBenefitCouponControls.id, Number(coupon.couponId)))
    .limit(1)
    .for('update');
  if (couponControls.length !== 1 || couponControls[0]!.hash !== coupon.couponInputHash)
    throw benefitError();
  if (
    (header.couponId === null || header.couponId === 0n ? null : String(header.couponId)) !==
      coupon.headerCouponId ||
    header.amount !== coupon.headerCouponAmount
  )
    throw benefitError();
  const [claim] = await tx
    .select()
    .from(importBirthdayClaims)
    .where(eq(importBirthdayClaims.operationId, input.state.scope.operationId))
    .limit(1)
    .for('share');
  const parsedClaim = z
    .object({
      scope: couponHistoryScopeSchema,
      id: z.uuid(),
      keyHash: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: z.number().int().safe().positive(),
    })
    .strict()
    .safeParse(claim?.receipt);
  if (
    !claim ||
    !parsedClaim.success ||
    claim.requestHash !== input.state.requestHash ||
    claim.claimId !== coupon.birthdayClaim.id ||
    parsedClaim.data.id !== claim.claimId ||
    parsedClaim.data.expiresAt !== coupon.birthdayClaim.expiresAt ||
    parsedClaim.data.keyHash !== coupon.birthdayClaim.keyHash ||
    claim.proofHash !== coupon.birthdayClaim.receiptHash ||
    !equalImportHash(
      claim.proofHash,
      benefitDigest('birthday-claim', parsedClaim.data, input.sourceProofKey),
    ) ||
    parsedClaim.data.scope.customerId !== coupon.scope.customerId ||
    parsedClaim.data.scope.couponId !== coupon.couponId ||
    parsedClaim.data.scope.operationId !== coupon.scope.operationId ||
    parsedClaim.data.scope.requestHash !== coupon.scope.requestHash ||
    parsedClaim.data.scope.planHash !== coupon.scope.planHash ||
    parsedClaim.data.scope.asOf !== coupon.scope.asOf ||
    parsedClaim.data.scope.configurationHash !== coupon.configurationHash ||
    benefitDigest('coupon-history-scope', parsedClaim.data.scope, input.sourceProofKey) !==
      coupon.history.scopeHash
  )
    throw benefitError();
  for (const allocated of coupon.allocations) {
    const hp = byId.get(allocated.id);
    if (
      !hp ||
      hp.hash !== allocated.refundInputHash ||
      hp.discount !== allocated.discount ||
      hp.refundable !== allocated.refundable
    )
      throw benefitError();
  }
  const current = await readCouponUsers(tx, order.customerId, coupon.couponId);
  if (input.phase === 'staged' || order.method === 15) {
    if (
      logs.length ||
      input.activation ||
      benefitDigest('coupon-users', current, input.sourceProofKey) !==
        benefitDigest('coupon-users', coupon.couponUsersBefore, input.sourceProofKey)
    )
      throw benefitError();
  } else {
    if (!input.activation || logs.length !== 1) throw benefitError();
    const parsed = couponActivationSchema.safeParse(input.activation.value);
    if (!parsed.success) throw benefitError();
    const activation = parsed.data,
      log = logs[0]!;
    verifyBenefitSeal(
      'coupon-consumption',
      activation,
      input.activation.seal,
      input.sourceProofKey,
    );
    if (
      JSON.stringify(activation.scope) !== JSON.stringify(coupon.scope) ||
      activation.couponId !== coupon.couponId ||
      activation.stagedReceiptHash !== benefitReceiptHash('coupon', coupon, input.sourceProofKey) ||
      !equalImportHash(activation.sourceConfirmationHash, input.activation.confirmationHash) ||
      String(log.id) !== activation.log.id ||
      log.hash !== activation.log.inputHash ||
      log.status !== 1 ||
      String(log.customerId) !== order.customerId ||
      String(log.couponId) !== coupon.couponId ||
      activation.changes.length !== coupon.couponUsersBefore.length ||
      current.length !== activation.changes.length
    )
      throw benefitError();
    for (const change of activation.changes) {
      const before = coupon.couponUsersBefore.find((row) => row.id === change.id),
        now = current.find((row) => row.id === change.id);
      if (
        !before ||
        !now ||
        before.used !== change.before ||
        now.used !== change.after ||
        now.inputHash !== change.inputHash ||
        before.allowed !== now.allowed ||
        before.monthlyAllowed !== now.monthlyAllowed
      )
        throw benefitError();
    }
  }
  return result;
}
/** Reads only the new purpose kinds; never treats an absent selected descriptor as permission. */
export async function readCsvBenefitDescriptors(
  tx: AdministrationTransaction,
  operationId: string,
  requestHash: string,
) {
  const rows = await tx
    .select({
      kind: financialImportSourceReceipts.kind,
      requestHash: financialImportSourceReceipts.requestHash,
      status: financialImportSourceReceipts.status,
      proofHash: financialImportSourceReceipts.proofHash,
      oversized: sql<number>`OCTET_LENGTH(${financialImportSourceReceipts.proof})>500000`.mapWith(
        Number,
      ),
      proof:
        sql<unknown>`CASE WHEN OCTET_LENGTH(${financialImportSourceReceipts.proof})<=500000 THEN ${financialImportSourceReceipts.proof} ELSE NULL END`.mapWith(
          financialImportSourceReceipts.proof,
        ),
    })
    .from(financialImportSourceReceipts)
    .where(
      and(
        eq(financialImportSourceReceipts.operationId, operationId),
        inArray(financialImportSourceReceipts.kind, [
          'coupon-benefit',
          'pos-complement',
          'coupon-consume',
        ]),
      ),
    )
    .orderBy(asc(financialImportSourceReceipts.kind))
    .limit(4)
    .for('share');
  if (
    rows.length > 3 ||
    rows.some(
      (row) => row.oversized !== 0 || row.requestHash !== requestHash || row.status !== 'completed',
    ) ||
    new Set(rows.map((row) => row.kind)).size !== rows.length
  )
    throw benefitError();
  return Object.fromEntries(
    rows.map((row) => [row.kind, { value: row.proof, seal: row.proofHash }]),
  );
}
export type { CouponActivation };
