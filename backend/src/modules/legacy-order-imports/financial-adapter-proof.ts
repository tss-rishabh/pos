import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { Order, OrderStore, HasProduct } from '../../db/legacy-schema.js';
import { checkoutHeaderHashSql } from '../checkout/projection.js';
import {
  importCompletedProofSchema,
  sourceOrderReceiptSchema,
  type SourceOrderReceipt,
  type ImportCompletedProof,
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
export async function verifiedImportCompletion(
  tx: AdministrationTransaction,
  operationId: string,
  secret: string,
): Promise<ImportCompletedProof | null> {
  const [row] = await tx
    .select()
    .from(financialImportProofs)
    .where(eq(financialImportProofs.operationId, operationId))
    .limit(1)
    .for('share');
  if (!row) return null;
  const proof = importCompletedProofSchema.parse(row.data);
  if (
    proof.scope.operationId !== operationId ||
    proof.receiptId !== row.id ||
    proof.order.orderId !== row.orderId ||
    proof.requestHash !== row.requestHash ||
    proof.finalizedAt !== row.finalizedAt ||
    !equalImportHash(row.proofHash, financialImportHash(secret, 'completed', proof))
  )
    throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
  // Later legitimate payment/status/refund/contact/stock changes cannot erase
  // the original sealed import. Immutable order/line ownership remains required.
  const [order] = await tx
    .select({ id: Order.id, customerId: Order.user })
    .from(Order)
    .where(eq(Order.id, BigInt(row.orderId)))
    .limit(1);
  const mappings = await tx
    .select({ storeId: OrderStore.store, counterId: OrderStore.counter })
    .from(OrderStore)
    .where(eq(OrderStore.order, BigInt(row.orderId)))
    .limit(2);
  const lines = await tx
    .select({
      id: HasProduct.id,
      productId: HasProduct.product,
      quantity: HasProduct.qty,
      subProductId: HasProduct.sub_prod_id,
    })
    .from(HasProduct)
    .where(eq(HasProduct.order, BigInt(row.orderId)))
    .orderBy(asc(HasProduct.id))
    .limit(1001);
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
