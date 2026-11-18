import { asc, eq, sql } from 'drizzle-orm';
import {
  bigint,
  char,
  datetime,
  double,
  mysqlEnum,
  mysqlTable,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { Databases } from '../../db/pools.js';
import { GiftCardCollection, Order } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { decodeGiftCardSerial } from './gift-cards.js';

export const giftCardContract = 'pos-gift-card-v2';
export const giftCardIssuanceContract = 'pos-gift-card-issuance-v1';
export function assertGiftCardContract(configuration: { giftCardContract?: string }): void {
  if (configuration.giftCardContract !== giftCardContract)
    throw new AppError(
      503,
      'GIFT_CARD_CONTRACT_UNVERIFIED',
      'Gift card value, item handling and atomic funding must be verified before continuing.',
    );
}

/** Physical fields verified in mysql-global-benefits-schema.json. */
export const issuedVouchers = mysqlTable('gift_vouchers', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  customerId: bigint('from_id', { mode: 'bigint' }).notNull(),
  code: varchar('voucher_code', { length: 25 }).notNull(),
  initialValue: double('voucher_initial_value'),
  kind: mysqlEnum('gv_type', ['GIFT_VOUCHER', 'GIFT_CARD']).notNull(),
  collectionId: bigint('collection_no', { mode: 'bigint' }).notNull(),
  serial: bigint('gift_card_srno', { mode: 'bigint' }).notNull(),
  status: tinyint('status').notNull(),
  startsAt: datetime('start_date', { mode: 'string' }).notNull(),
  expiresAt: datetime('end_date', { mode: 'string' }).notNull(),
});

export const giftCardIssuances = mysqlTable('pos_rewrite_gift_card_issuances', {
  voucherId: bigint('voucher_id', { mode: 'bigint' }).primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  collectionId: bigint('collection_id', { mode: 'bigint' }).notNull(),
  serial: bigint('serial', { mode: 'bigint' }).notNull(),
  inputHash: char('input_hash', { length: 64 }).notNull(),
  contract: varchar('contract_version', { length: 40 }).notNull(),
  activatedAt: datetime('activated_at', { mode: 'string' }).notNull(),
});

// Execute on native MySQL values in both Node and the upstream Go transaction.
// Spendable value/status are mutable after redemption and are deliberately absent.
export const giftCardIssuanceHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('voucher_id',gift_vouchers.id,'order_id',gift_vouchers.order_id,'customer_id',gift_vouchers.from_id,'collection_id',gift_vouchers.collection_no,'serial',gift_vouchers.gift_card_srno,'voucher_code',gift_vouchers.voucher_code,'initial_value',gift_vouchers.voucher_initial_value,'start_date',gift_vouchers.start_date,'end_date',gift_vouchers.end_date) AS CHAR CHARACTER SET utf8mb4),256))";

type IssuanceTransaction = Pick<ReturnType<Databases['get']>, 'select' | 'insert'>;
type IssuedVoucher = Awaited<ReturnType<typeof cards>>[number];
function review(): never {
  throw new AppError(
    409,
    'GIFT_CARD_ISSUANCE_UNCONFIRMED',
    'Gift card funding requires review. Keep the order and payment references before retrying.',
  );
}
async function cards(tx: Pick<IssuanceTransaction, 'select'>, orderId: string, lock = false) {
  const query = tx
    .select({
      id: issuedVouchers.id,
      collectionId: issuedVouchers.collectionId,
      serial: issuedVouchers.serial,
      initialValue: issuedVouchers.initialValue,
      customerId: issuedVouchers.customerId,
      orderCustomerId: Order.user,
      kind: issuedVouchers.kind,
      status: issuedVouchers.status,
      inputHash: sql<string>`${sql.raw(giftCardIssuanceHashSql)}`,
    })
    .from(issuedVouchers)
    .innerJoin(Order, eq(Order.id, issuedVouchers.orderId))
    .where(eq(issuedVouchers.orderId, BigInt(orderId)))
    .orderBy(asc(issuedVouchers.id))
    .limit(101);
  const rows = await (lock ? query.for('update') : query);
  if (rows.length > 100) review();
  return rows.filter((row) => row.kind === 'GIFT_CARD');
}
function validCard(row: IssuedVoucher) {
  if (
    row.id < 1n ||
    row.collectionId < 1n ||
    row.serial < 1n ||
    row.customerId < 1n ||
    row.customerId !== row.orderCustomerId ||
    !Number.isFinite(row.initialValue) ||
    row.initialValue === null ||
    row.initialValue <= 0 ||
    ![0, 1].includes(row.status) ||
    !/^[a-f0-9]{64}$/.test(row.inputHash)
  )
    review();
}
/** Collection first, voucher second matches the upstream issuance/block lock order. */
async function pendingCards(tx: Pick<IssuanceTransaction, 'select'>, orderId: string) {
  const before = await cards(tx, orderId);
  const collectionIds = [...new Set(before.map((row) => row.collectionId))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const collections = new Map<bigint, number>();
  for (const id of collectionIds) {
    const [collection] = await tx
      .select({
        size: GiftCardCollection.size,
        blocked: GiftCardCollection.is_block,
        completed: GiftCardCollection.is_completed,
        printed: GiftCardCollection.is_printed,
      })
      .from(GiftCardCollection)
      .where(eq(GiftCardCollection.id, id))
      .limit(1)
      .for('update');
    if (
      !collection ||
      collection.blocked !== 0 ||
      collection.completed !== 1 ||
      collection.printed !== 1 ||
      !Number.isInteger(collection.size) ||
      collection.size < 1
    )
      review();
    collections.set(id, collection.size);
  }
  const current = await cards(tx, orderId, true);
  if (
    current.length !== before.length ||
    current.some(
      (row, index) => row.id !== before[index]?.id || row.inputHash !== before[index]?.inputHash,
    )
  )
    review();
  for (const row of current) {
    validCard(row);
    let serial: ReturnType<typeof decodeGiftCardSerial>;
    try {
      serial = decodeGiftCardSerial(String(row.serial));
    } catch {
      review();
    }
    const size = collections.get(row.collectionId);
    if (
      serial.collectionId !== String(row.collectionId) ||
      size === undefined ||
      !/^[1-9]\d*$/.test(serial.serialDigits) ||
      BigInt(serial.serialDigits) > BigInt(size)
    )
      review();
  }
  return current;
}

/** Call under the writer order lock before dispatch, or while settling paid cash/provider funds. */
export async function assertPendingGiftCardIssuance(
  tx: Pick<IssuanceTransaction, 'select'>,
  orderId: string,
): Promise<void> {
  const rows = await pendingCards(tx, orderId);
  if (rows.some((row) => row.status !== 0)) review();
  const existing = await tx
    .select({ id: giftCardIssuances.voucherId })
    .from(giftCardIssuances)
    .where(eq(giftCardIssuances.orderId, BigInt(orderId)))
    .limit(1)
    .for('update');
  if (existing.length) review();
}

/** Call after activation, in the SAME transaction that records the confirmed payment. */
export async function recordGiftCardIssuance(
  tx: IssuanceTransaction,
  orderId: string,
): Promise<void> {
  const rows = await pendingCards(tx, orderId);
  if (rows.some((row) => row.status !== 1)) review();
  if (!rows.length) return;
  await tx.insert(giftCardIssuances).values(
    rows.map((row) => ({
      voucherId: row.id,
      orderId: BigInt(orderId),
      collectionId: row.collectionId,
      serial: row.serial,
      inputHash: row.inputHash,
      contract: giftCardIssuanceContract,
      activatedAt: sql`CURRENT_TIMESTAMP`,
    })),
  );
}

/** Historical funded value remains provable after a later batch block or card redemption. */
export async function assertCompletedGiftCardIssuance(
  tx: Pick<IssuanceTransaction, 'select'>,
  orderId: string,
): Promise<void> {
  const rows = await cards(tx, orderId, true);
  const proofs = await tx
    .select()
    .from(giftCardIssuances)
    .where(eq(giftCardIssuances.orderId, BigInt(orderId)))
    .orderBy(asc(giftCardIssuances.voucherId))
    .limit(101)
    .for('update');
  if (rows.length !== proofs.length || proofs.length > 100) review();
  rows.forEach((row, index) => {
    validCard(row);
    const proof = proofs[index];
    if (
      !proof ||
      proof.voucherId !== row.id ||
      proof.collectionId !== row.collectionId ||
      proof.serial !== row.serial ||
      proof.contract !== giftCardIssuanceContract ||
      proof.inputHash !== row.inputHash
    )
      review();
  });
}
