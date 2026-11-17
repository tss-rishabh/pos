import { asc, eq } from 'drizzle-orm';
import { bigint, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { Order, HasProduct } from '../../db/legacy-schema.js';
import {
  originCommandSchema, originDigest, originError, sameOriginHash,
  type ScreeningOriginCommand,
} from './contracts.js';

const commands = mysqlTable('pos_rewrite_screening_origin_commands', {
  id: varchar('id', { length: 36 }).primaryKey(),
  origin: varchar('origin', { length: 32 }).notNull(),
  customerId: bigint('customer_id', { mode: 'bigint' }).notNull(),
  phase: varchar('phase', { length: 16 }).notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }),
  data: json('data').$type<unknown>().notNull(),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
});
const creations = mysqlTable('pos_rewrite_screening_origin_creations', {
  commandId: varchar('command_id', { length: 36 }).primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  data: json('data').$type<unknown>().notNull(),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
});
const closures = mysqlTable('pos_rewrite_screening_origin_closures', {
  commandId: varchar('command_id', { length: 36 }).primaryKey(),
  data: json('data').$type<unknown>().notNull(),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
});
const payments = mysqlTable('pos_rewrite_screening_origin_payments', {
  commandId: varchar('command_id', { length: 36 }).primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  data: json('data').$type<unknown>().notNull(),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
});
function document(value: unknown): Record<string, unknown> {
  try {
    if (typeof value === 'string') value = JSON.parse(value);
    return z.record(z.string(), z.unknown()).parse(value);
  } catch { throw originError(); }
}
function checked(row: typeof commands.$inferSelect, secret: string): ScreeningOriginCommand {
  let value: ScreeningOriginCommand;
  try { value = originCommandSchema.parse(document(row.data)); }
  catch { throw originError(); }
  if (row.id !== value.id || row.origin !== value.origin || row.phase !== value.phase ||
    String(row.customerId) !== value.customerId || (row.orderId === null ? null : String(row.orderId)) !== value.orderId ||
    !sameOriginHash(originDigest(secret, 'command', value), row.proofHash)) throw originError();
  return value;
}
async function verifyCreation(tx: AdministrationTransaction, value: ScreeningOriginCommand, secret: string) {
  const rows = await tx.select().from(creations).where(eq(creations.commandId, value.id)).limit(2).for('share');
  const row = rows[0];
  if (rows.length !== 1 || !row) throw originError();
  const proof = document(row.data);
  if (proof.contract !== 'pos-screening-origin-creation-v1' || proof.commandId !== value.id || proof.origin !== value.origin ||
      proof.customerId !== value.customerId || proof.orderId !== value.orderId || String(row.orderId) !== value.orderId ||
      proof.requestHash !== value.requestHash || proof.cartHash !== value.cartHash || proof.authorityHash !== value.authorityHash ||
      row.proofHash !== value.creationHash || !sameOriginHash(originDigest(secret, 'creation', proof), row.proofHash)) throw originError();
}
/** Caller already holds the exact global customer lock in its owned RC writer
 * transaction. No customer token, browser nonce, or public bypass is accepted. */
export async function readOtherOriginScreeningCredits(
  tx: AdministrationTransaction,
  customerId: string,
  secret = process.env.POS_SCREENING_ORIGIN_PROOF_KEY ?? '',
): Promise<number> {
  const rows = await tx.select().from(commands)
    .where(eq(commands.customerId, BigInt(customerId))).orderBy(asc(commands.id)).limit(1001);
  if (rows.length > 1000) throw originError('SCREENING_ORIGIN_COHORT_TOO_LARGE');
  let pending = 0;
  for (const row of rows) {
    const value = checked(row, secret);
    if (value.phase === 'RESERVED') { pending += value.markerRows; continue; }
    if (value.phase === 'BOUND' || value.phase === 'COUNTED') {
      await verifyCreation(tx, value, secret);
      if (value.phase === 'COUNTED') {
        const proofs = await tx.select().from(payments).where(eq(payments.commandId, value.id)).limit(2).for('share');
        const payment = proofs[0];
        if (proofs.length !== 1 || !payment) throw originError();
        const proof = document(payment.data);
        if (proof.contract !== 'pos-screening-origin-payment-v1' || proof.status !== 'CONFIRMED' || proof.commandId !== value.id || proof.customerId !== customerId ||
            proof.orderId !== value.orderId || proof.creationHash !== value.creationHash || String(payment.orderId) !== value.orderId ||
            !sameOriginHash(originDigest(secret, 'payment', proof), payment.proofHash)) throw originError();
        // Current mutable status/refund/contact changes do not erase the old
        // Go receipt. The operational projection supplies today's literal COUNT.
        continue;
      }
      const current = await tx.select({ status: Order.order_status, customer: Order.user }).from(Order)
        .where(eq(Order.id, BigInt(value.orderId!))).limit(2).for('share');
      if (current.length !== 1 || String(current[0]!.customer) !== customerId) throw originError();
      const lines = await tx.select({ id: HasProduct.id, productId: HasProduct.product, quantity: HasProduct.qty })
        .from(HasProduct).where(eq(HasProduct.order, BigInt(value.orderId!))).orderBy(asc(HasProduct.id)).limit(1001).for('share');
      if (lines.length > 1000) throw originError();
      const ticket = lines.filter((line) => String(line.productId) === '390238');
      if (ticket.length !== value.lines.length || ticket.some((line, index) => String(line.id) !== value.lines[index]!.id || line.quantity !== value.lines[index]!.quantity)) throw originError();
      if (current[0]!.status === null || current[0]!.status === 0 || current[0]!.status === 17) pending += value.markerRows;
    } else if (value.phase === 'REJECTED') {
      const proofs = await tx.select().from(closures).where(eq(closures.commandId, value.id)).limit(2).for('share');
      const row = proofs[0];
      if (proofs.length !== 1 || !row) throw originError();
      const proof = document(row.data);
      if (proof.commandId !== value.id || proof.customerId !== customerId || proof.noFinancialEffects !== true ||
          row.proofHash !== value.closureHash || !sameOriginHash(originDigest(secret, 'closure', proof), row.proofHash)) throw originError();
    }
  }
  return pending;
}
