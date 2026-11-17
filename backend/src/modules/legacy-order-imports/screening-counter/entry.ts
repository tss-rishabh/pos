import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { Databases } from '../../../db/pools.js';
import { assertScreeningCustomer } from '../screening-transactions.js';
import { counterCustomer, counterRowSchema, counterError } from './contracts.js';
import { qualifyCounterWriterDefinitions } from './reader.js';

export interface CounterWriterParents {
  customerId: string;
  orderIds: readonly string[];
  lineIds: readonly string[];
}
const ordered = (values: readonly string[]) =>
  [...new Set(values)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
/** Internal cooperative-writer entry, not a financial/actor authorization port.
 * Caller holds its existing current user authority before parent rows. There
 * are no waits/retries on advisory locks and no definer routine is called. */
export async function withScreeningCounterWriter<T>(
  tx: AdministrationTransaction,
  input: CounterWriterParents,
  work: () => Promise<T>,
): Promise<T> {
  const customerId = counterCustomer.parse(input.customerId);
  assertScreeningCustomer(tx, customerId);
  return enter(
    tx,
    { customerIds: [customerId], orderIds: input.orderIds, lineIds: input.lineIds },
    work,
  );
}
export interface CounterMutationParents {
  customerIds: readonly string[];
  orderIds: readonly string[];
  lineIds: readonly string[];
}
/** Dedicated cooperative maintenance writer. Owns RC and locks all affected
 * customers in numeric order BEFORE every Order/HP/marker. Input is an internal
 * bounded hint, rechecked after those parent locks; it grants no user authority. */
export function screeningCounterMutation<T>(
  db: Databases,
  input: CounterMutationParents,
  work: (tx: AdministrationTransaction) => Promise<T>,
): Promise<T> {
  const customerIds = ordered(z.array(counterCustomer).min(1).max(1000).parse(input.customerIds));
  return db.get('writer').transaction(
    async (tx) => {
      for (const customer of customerIds) {
        const [raw] = await tx.execute(
          sql`SELECT CAST(id AS CHAR) AS id FROM users WHERE id=${BigInt(customer)} FOR UPDATE`,
        );
        if (
          !z
            .array(z.object({ id: z.literal(customer) }))
            .length(1)
            .safeParse(raw).success
        )
          throw counterError('WRITER_SCOPE_CHANGED');
      }
      return enter(tx, { ...input, customerIds }, () => work(tx));
    },
    { isolationLevel: 'read committed' },
  );
}
async function enter<T>(
  tx: AdministrationTransaction,
  input: CounterMutationParents,
  work: () => Promise<T>,
): Promise<T> {
  const customerIds = ordered(z.array(counterCustomer).min(1).max(1000).parse(input.customerIds));
  const orderIds = ordered(
    z.array(counterRowSchema.shape.orderId).max(10000).parse(input.orderIds),
  );
  const lineIds = ordered(z.array(counterRowSchema.shape.lineId).max(10000).parse(input.lineIds));
  await qualifyCounterWriterDefinitions(tx);
  const names: string[] = [];
  async function acquire(kind: 'u' | 'o' | 'p', id: string) {
    const [raw] = await tx.execute(
      sql`SELECT CONCAT('pos-screening:',LEFT(SHA2(DATABASE(),256),16),':',${kind},':',${id}) AS name`,
    );
    const name = z
      .array(z.object({ name: z.string().max(64) }))
      .length(1)
      .parse(raw)[0]!.name;
    const [lock] = await tx.execute(sql`SELECT GET_LOCK(${name},0) AS acquired`);
    if (
      !z
        .array(z.object({ acquired: z.union([z.literal(1), z.literal('1')]) }))
        .length(1)
        .safeParse(lock).success
    )
      throw counterError('WRITER_BUSY');
    names.push(name);
  }
  try {
    for (const customer of customerIds) await acquire('u', customer);
    for (const id of orderIds)
      await tx.execute(sql`SELECT id FROM orders WHERE id=${BigInt(id)} FOR UPDATE`);
    for (const id of lineIds) {
      const [raw] = await tx.execute(
        sql`SELECT CAST(id AS CHAR) AS id,CAST(order_id AS CHAR) AS parent FROM has_products WHERE id=${BigInt(id)} FOR UPDATE`,
      );
      const lines = z
        .array(z.object({ id: z.string(), parent: z.string().nullable() }))
        .max(1)
        .safeParse(raw);
      if (
        !lines.success ||
        lines.data.some(
          (row) => row.parent !== null && row.parent !== '0' && !orderIds.includes(row.parent),
        )
      )
        throw counterError('WRITER_SCOPE_CHANGED');
    }
    for (const id of orderIds) await acquire('o', id);
    for (const id of lineIds) await acquire('p', id);
    if (orderIds.length || lineIds.length) {
      const conditions = [];
      if (orderIds.length)
        conditions.push(
          sql`order_id IN (${sql.join(
            orderIds.map((id) => sql`${BigInt(id)}`),
            sql`,`,
          )})`,
        );
      if (lineIds.length)
        conditions.push(
          sql`has_product_id IN (${sql.join(
            lineIds.map((id) => sql`${BigInt(id)}`),
            sql`,`,
          )})`,
        );
      const [affected] =
        await tx.execute(sql`SELECT CAST(user_id AS CHAR) AS customerId,CAST(order_id AS CHAR) AS orderId,CAST(has_product_id AS CHAR) AS lineId FROM spiderman_screening_orders
        WHERE (${sql.join(conditions, sql` OR `)}) AND user_id>0 LIMIT 10001`);
      const users = z
        .array(
          z.object({
            customerId: counterCustomer,
            orderId: counterRowSchema.shape.orderId,
            lineId: counterRowSchema.shape.lineId,
          }),
        )
        .max(10000)
        .safeParse(affected);
      if (
        !users.success ||
        users.data.some(
          (row) =>
            !customerIds.includes(row.customerId) ||
            !orderIds.includes(row.orderId) ||
            !lineIds.includes(row.lineId),
        )
      )
        throw counterError('WRITER_SCOPE_CHANGED');
    }
    return await work();
  } finally {
    for (const name of names.reverse()) await tx.execute(sql`SELECT RELEASE_LOCK(${name})`);
  }
}
