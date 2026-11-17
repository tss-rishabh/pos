import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { Order, OrderStore, HasProduct, MUser } from '../../db/legacy-schema.js';
import { checkoutHeaderHashSql } from '../checkout/projection.js';
import {
  importCompletedProofSchema,
  sourceOrderReceiptSchema,
  type SourceOrderReceipt,
  type ImportCompletedProof,
  type ImportFinancialState,
} from './financial-adapter-contracts.js';
import {
  financialImportOrderBindings,
  financialImportProofs,
  financialImportSourceReceipts,
} from './financial-adapter-schema.js';
import {
  financialImportHash,
  financialSourceHash,
  equalImportHash,
  importFinancialError,
} from './financial-adapter-crypto.js';
import { assertCompletedImportCorrection } from './financial-adapter-corrections.js';
import {
  validateCsvMembershipCompletionSnapshot,
  assertCsvMembershipPublication,
} from './membership-profile/completion.js';
import { validateCsvFinancialBenefitSnapshot } from './benefit-profile/completion.js';
import { readCsvBenefitDescriptors } from './benefit-profile/native.js';
/** Native financial/address/date digests never serialize a MySQL FLOAT through JavaScript. */
export const importOrderHeaderHashExpression = `LOWER(SHA2(CAST(JSON_OBJECT('financial_header_hash',${checkoutHeaderHashSql},'created_at',DATE_FORMAT(orders.created_at,'%Y-%m-%d %H:%i:%s'),'currency',orders.currency,'currency_conv_rate',orders.currency_conv_rate,'shipping_amt',orders.shipping_amt,'order_amt',orders.order_amt,'fraction_value',orders.fraction_value,'first_name',orders.first_name,'last_name',orders.last_name,'address1',orders.address1,'address2',orders.address2,'address3',orders.address3,'phone_no',orders.phone_no,'country_id',orders.country_id,'zone_id',orders.zone_id,'postal_code',orders.postal_code,'city',orders.city) AS CHAR CHARACTER SET utf8mb4),256))`;
export const importOrderLineHashExpression =
  "LOWER(SHA2(CAST(JSON_OBJECT('id',has_products.id,'product_id',has_products.prod_id,'sub_product_id',has_products.sub_prod_id,'quantity',has_products.qty,'price',has_products.price,'gst',has_products.gst,'pre_gst_amt',has_products.pre_gst_amt,'disc',has_products.disc,'wallet_disc',has_products.wallet_disc,'voucher_disc',has_products.voucher_disc,'points',has_products.hp_tss_points_used,'refundable',has_products.amount_to_be_refunded,'fraction_value',has_products.fraction_value) AS CHAR CHARACTER SET utf8mb4),256))";
export function importLinesDigest(
  lines: readonly { id: string; productId: string; quantity: number; inputHash: string }[],
) {
  return createHash('sha256')
    .update(
      [...lines]
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        .map((line) => `${line.id}:${line.productId}:${line.quantity}:${line.inputHash}`)
        .join('\n'),
    )
    .digest('hex');
}
export async function nativeImportOrder(tx: AdministrationTransaction, orderId: string) {
  const headers = await tx
    .select({
      id: Order.id,
      customerId: Order.user,
      createdAt: Order.created_at,
      updatedAt: Order.updated_at,
      method: Order.payment_methods,
      status: Order.order_statuses,
      paymentStatus: Order.payment_statuses,
      payable: Order.pay_amt,
      orderRef: Order.order_ref_no,
      headerHash: sql<string>`${sql.raw(importOrderHeaderHashExpression)}`,
      stockReduced: Order.is_stock_reduced,
    })
    .from(Order)
    .where(eq(Order.id, BigInt(orderId)))
    .limit(1)
    .for('update');
  const header = headers[0];
  if (!header) throw importFinancialError('ORDER_IMPORT_ORDER_UNCONFIRMED');
  const mappings = await tx
    .select()
    .from(OrderStore)
    .where(eq(OrderStore.order, BigInt(orderId)))
    .limit(2)
    .for('update');
  const lines = await tx
    .select({
      id: HasProduct.id,
      productId: HasProduct.product,
      subProductId: HasProduct.sub_prod_id,
      quantity: HasProduct.qty,
      status: HasProduct.status,
      createdAt: HasProduct.created_at,
      updatedAt: HasProduct.updated_at,
      inputHash: sql<string>`${sql.raw(importOrderLineHashExpression)}`,
    })
    .from(HasProduct)
    .where(eq(HasProduct.order, BigInt(orderId)))
    .orderBy(asc(HasProduct.id))
    .limit(1001)
    .for('update');
  if (
    mappings.length !== 1 ||
    !lines.length ||
    lines.length > 1000 ||
    lines.some((line) => line.quantity < 1 || line.quantity > 999 || line.subProductId !== 0n)
  )
    throw importFinancialError('ORDER_IMPORT_ORDER_UNCONFIRMED');
  const values = lines.map((line) => ({
    id: String(line.id),
    productId: String(line.productId),
    quantity: Number(line.quantity),
    inputHash: line.inputHash,
  }));
  return {
    header,
    mapping: mappings[0]!,
    lines: values,
    lineStates: lines,
    lineHash: importLinesDigest(values),
  };
}
export async function readSourceOrderReceipt(
  tx: AdministrationTransaction,
  operationId: string,
  sourceKey: string,
): Promise<SourceOrderReceipt | null> {
  const [row] = await tx
    .select()
    .from(financialImportSourceReceipts)
    .where(
      and(
        eq(financialImportSourceReceipts.operationId, operationId),
        eq(financialImportSourceReceipts.kind, 'order'),
        eq(financialImportSourceReceipts.status, 'completed'),
        sql`OCTET_LENGTH(${financialImportSourceReceipts.proof})<=1000000`,
      ),
    )
    .limit(1)
    .for('share');
  if (!row) return null;
  const proof = sourceOrderReceiptSchema.parse(row.proof);
  if (
    proof.operationId !== operationId ||
    proof.requestHash !== row.requestHash ||
    !equalImportHash(row.proofHash, financialSourceHash(sourceKey, 'order', proof))
  )
    throw importFinancialError('ORDER_IMPORT_SOURCE_PROOF_INVALID');
  return proof;
}
/** Authenticate frozen evidence without current profile/contact/entitlement work
 * or any Order lock. Callers can establish customer-before-Order authority next. */
export async function readAuthenticatedImportCompletion(
  tx: AdministrationTransaction,
  operationId: string,
  secret: string,
): Promise<ImportCompletedProof | null> {
  const rows = await tx
    .select({
      id: financialImportProofs.id,
      orderId: financialImportProofs.orderId,
      requestHash: financialImportProofs.requestHash,
      proofHash: financialImportProofs.proofHash,
      finalizedAt: financialImportProofs.finalizedAt,
      bytes: sql<string>`CAST(OCTET_LENGTH(${financialImportProofs.data}) AS CHAR)`,
      data: sql<unknown>`CASE WHEN OCTET_LENGTH(${financialImportProofs.data})<=1000000 THEN ${financialImportProofs.data} ELSE NULL END`,
    })
    .from(financialImportProofs)
    .where(eq(financialImportProofs.operationId, operationId))
    .limit(2)
    .for('share');
  if (!rows.length) return null;
  const row = rows[0]!;
  if (
    rows.length !== 1 ||
    !/^\d{1,10}$/.test(row.bytes) ||
    BigInt(row.bytes) < 1n ||
    BigInt(row.bytes) > 1000000n
  )
    throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
  let raw: unknown = row.data;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
    }
  }
  const parsed = importCompletedProofSchema.safeParse(raw);
  if (!parsed.success) throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
  const proof = parsed.data;
  if (
    proof.scope.operationId !== operationId ||
    proof.receiptId !== row.id ||
    proof.order.orderId !== row.orderId ||
    proof.requestHash !== row.requestHash ||
    proof.finalizedAt !== row.finalizedAt ||
    !equalImportHash(row.proofHash, financialImportHash(secret, 'completed', proof))
  )
    throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
  assertCompletedImportCorrection(proof);
  if (proof.membership !== undefined) {
    validateCsvMembershipCompletionSnapshot(proof.membership, proof);
  } else {
    // Old ordinary HMACs retain field absence. A retained member descriptor
    // cannot be promoted to qualified completion by that compatibility rule.
    const [member] = await tx
      .select({ id: financialImportSourceReceipts.id })
      .from(financialImportSourceReceipts)
      .where(
        and(
          eq(financialImportSourceReceipts.operationId, operationId),
          eq(financialImportSourceReceipts.kind, 'membership'),
        ),
      )
      .limit(1)
      .for('share');
    if (member) throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID');
  }
  assertCsvMembershipPublication(proof.membership ?? null, proof.publication);
  if (proof.benefits !== undefined) validateCsvFinancialBenefitSnapshot(proof.benefits, proof);
  else if (Object.keys(await readCsvBenefitDescriptors(tx, operationId, proof.requestHash)).length)
    throw importFinancialError('ORDER_IMPORT_BENEFIT_PROOF_INVALID');
  return proof;
}
export async function assertImportCompletionOwnership(
  tx: AdministrationTransaction,
  proof: ImportCompletedProof,
) {
  // Later legitimate payment/status/refund/contact/stock changes cannot erase
  // the original sealed import. Immutable order/line ownership remains required.
  const [order] = await tx
    .select({ id: Order.id, customerId: Order.user })
    .from(Order)
    .where(eq(Order.id, BigInt(proof.order.orderId)))
    .limit(1)
    .for('share');
  const mappings = await tx
    .select({ storeId: OrderStore.store, counterId: OrderStore.counter })
    .from(OrderStore)
    .where(eq(OrderStore.order, BigInt(proof.order.orderId)))
    .limit(2)
    .for('share');
  const lines = await tx
    .select({
      id: HasProduct.id,
      productId: HasProduct.product,
      quantity: HasProduct.qty,
      subProductId: HasProduct.sub_prod_id,
    })
    .from(HasProduct)
    .where(eq(HasProduct.order, BigInt(proof.order.orderId)))
    .orderBy(asc(HasProduct.id))
    .limit(1001)
    .for('share');
  if (
    !order ||
    String(order.customerId) !== proof.authority.customerId ||
    mappings.length !== 1 ||
    String(mappings[0]!.storeId) !== proof.scope.storeId ||
    String(mappings[0]!.counterId) !== proof.scope.counterId ||
    lines.length !== proof.order.lines.length ||
    lines.some((line, index) => {
      const expected = proof.order.lines[index];
      return (
        !expected ||
        String(line.id) !== expected.id ||
        String(line.productId) !== expected.productId ||
        line.quantity !== BigInt(expected.quantity) ||
        line.subProductId !== 0n
      );
    })
  )
    throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
  return proof;
}
/** Immutable recovery is permitted by a verified financial seal, never a
 * completed/unknown flag. Caller already holds Store + original operation. */
export async function recoverImportCompletion(
  tx: AdministrationTransaction,
  context: { state: ImportFinancialState; plan: { kind: 'offline' | 'shopify' } },
  secret: string,
) {
  const proof = await readAuthenticatedImportCompletion(
    tx,
    context.state.scope.operationId,
    secret,
  );
  if (!proof) return null;
  const { state } = context;
  const binding = (value: {
    scope: ImportCompletedProof['scope'];
    planHash: string;
    requestHash: string;
    authority: ImportCompletedProof['authority'];
    kind: 'offline' | 'shopify';
    correction?: ImportCompletedProof['correction'];
    benefitContracts?: ImportCompletedProof['benefitContracts'];
  }) => ({
    scope: value.scope,
    planHash: value.planHash,
    requestHash: value.requestHash,
    authority: value.authority,
    kind: value.kind,
    ...(value.correction ? { correction: value.correction } : {}),
    ...(value.benefitContracts ? { benefitContracts: value.benefitContracts } : {}),
  });
  if (
    state.status === 'rejected' ||
    !equalImportHash(
      financialImportHash(secret, 'completion-context', binding(proof)),
      financialImportHash(
        secret,
        'completion-context',
        binding({ ...state, kind: context.plan.kind }),
      ),
    )
  )
    throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
  const [customer] = await tx
    .select({ id: MUser.id })
    .from(MUser)
    .where(eq(MUser.id, BigInt(proof.authority.customerId)))
    .limit(1)
    .for('update');
  if (!customer) throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
  return assertImportCompletionOwnership(tx, proof);
}
/** Generic already-locked financial mutations retain their established lock
 * order. Mutable membership state/keys are not part of this immutable guard. */
export async function verifiedImportCompletion(
  tx: AdministrationTransaction,
  operationId: string,
  secret: string,
): Promise<ImportCompletedProof | null> {
  const proof = await readAuthenticatedImportCompletion(tx, operationId, secret);
  return proof ? assertImportCompletionOwnership(tx, proof) : null;
}
/** Generic writers never receive an allowed-operation bypass. Only immutable
 * native completion releases the hold; the private owner uses its own journal. */
export async function assertImportOrderMutationAvailable(
  tx: AdministrationTransaction,
  orderId: string,
  secret = process.env.LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1 ?? '',
) {
  const [binding] = await tx
    .select()
    .from(financialImportOrderBindings)
    .where(eq(financialImportOrderBindings.orderId, orderId))
    .limit(1)
    .for('share');
  if (!binding) return;
  if (binding.status !== 'completed' || secret.length < 32)
    throw importFinancialError('ORDER_IMPORT_ORDER_HELD');
  const proof = await verifiedImportCompletion(tx, binding.operationId, secret);
  if (
    !proof ||
    proof.order.orderId !== orderId ||
    proof.requestHash !== binding.requestHash ||
    !equalImportHash(
      binding.proofHash,
      financialImportHash(secret, 'order-binding', {
        orderId,
        operationId: binding.operationId,
        requestHash: binding.requestHash,
      }),
    )
  )
    throw importFinancialError('ORDER_IMPORT_ORDER_HELD');
}
