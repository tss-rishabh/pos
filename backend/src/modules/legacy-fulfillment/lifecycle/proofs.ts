import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { HasProduct, Order } from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { DeliverySnapshot } from './contracts.js';
import { reconciliation } from './domain.js';
import { cancellationRows } from './proof-schema.js';

export async function freezeCancellation(
  tx: AdministrationTransaction,
  snapshot: DeliverySnapshot,
): Promise<DeliverySnapshot> {
  const [prior] = await tx
    .select({ id: cancellationRows.id })
    .from(cancellationRows)
    .where(eq(cancellationRows.orderId, BigInt(snapshot.orderId)))
    .orderBy(desc(cancellationRows.id))
    .limit(1)
    .for('share');
  return { ...snapshot, cancellationBaselineId: prior ? String(prior.id) : null };
}
export async function assertCancelledProjection(
  tx: AdministrationTransaction,
  snapshot: DeliverySnapshot,
) {
  const selected = snapshot.lines.filter((line) => !snapshot.split || line.platform === '4'),
    ids = new Set(selected.map((line) => line.id)),
    byId = new Map(snapshot.lines.map((line) => [line.id, line])),
    linked = new Set<string>();
  const rows = await tx
    .select()
    .from(cancellationRows)
    .where(
      and(
        eq(cancellationRows.orderId, BigInt(snapshot.orderId)),
        snapshot.cancellationBaselineId
          ? gt(cancellationRows.id, BigInt(snapshot.cancellationBaselineId))
          : undefined,
      ),
    )
    .orderBy(asc(cancellationRows.id))
    .limit(1001)
    .for('share');
  const fingerprint = (sku: string, quantity: number) => sku + ':' + quantity,
    expected = selected.map((line) => fingerprint(line.productId, line.quantity)).sort(),
    actual = rows.map((row) => fingerprint(String(row.productId), row.quantity)).sort();
  for (const row of rows)
    if (row.hasProductId !== null) {
      const id = String(row.hasProductId),
        line = byId.get(id);
      if (
        linked.has(id) ||
        !line ||
        !ids.has(id) ||
        String(row.productId) !== line.productId ||
        row.quantity !== line.quantity
      )
        throw reconciliation();
      linked.add(id);
    }
  if (
    rows.some(
      (row) =>
        row.status !== 4 ||
        row.subProductId !== 0n ||
        (row.hasProductId !== null && !ids.has(String(row.hasProductId))),
    ) ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  )
    throw reconciliation();
  const current = await tx
    .select({ id: HasProduct.id, status: HasProduct.status })
    .from(HasProduct)
    .where(eq(HasProduct.order, BigInt(snapshot.orderId)))
    .orderBy(asc(HasProduct.id))
    .limit(1001)
    .for('share');
  if (
    current.length !== snapshot.lines.length ||
    current.some((row) =>
      ids.has(String(row.id))
        ? row.status !== 'CANCELLED'
        : row.status !== byId.get(String(row.id))?.status,
    )
  )
    throw reconciliation();
}
export async function assertConvertedProjection(
  tx: AdministrationTransaction,
  snapshot: DeliverySnapshot,
  newOrderId: string,
) {
  const [child] = await tx
    .select({
      id: Order.id,
      parentId: Order.hl_parent_order_id,
      customerId: Order.user,
      paymentStatus: Order.payment_statuses,
    })
    .from(Order)
    .where(eq(Order.id, BigInt(newOrderId)))
    .limit(1)
    .for('share');
  if (
    !child ||
    String(child.parentId) !== snapshot.orderId ||
    String(child.customerId) !== snapshot.customerId ||
    child.paymentStatus !== 4n
  )
    throw reconciliation();
  const lines = await tx
    .select({ productId: HasProduct.product, quantity: HasProduct.qty })
    .from(HasProduct)
    .where(eq(HasProduct.order, child.id))
    .orderBy(asc(HasProduct.id))
    .limit(1001)
    .for('share');
  if (lines.length > 1000) throw reconciliation();
  const aggregate = (rows: { productId: string; quantity: bigint }[]) => {
    const totals = new Map<string, bigint>();
    for (const row of rows)
      totals.set(row.productId, (totals.get(row.productId) || 0n) + row.quantity);
    return [...totals]
      .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
      .map(([id, quantity]) => [id, String(quantity)]);
  };
  const expected = aggregate(
      snapshot.lines
        .filter((line) => !snapshot.split || line.platform === '4')
        .map((line) => ({ productId: line.productId, quantity: BigInt(line.quantity) })),
    ),
    actual = aggregate(
      lines.map((line) => ({ productId: String(line.productId), quantity: BigInt(line.quantity) })),
    );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw reconciliation();
}
