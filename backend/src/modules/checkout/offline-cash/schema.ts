import {
  bigint,
  date,
  index,
  int,
  smallint,
  mediumtext,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

export const offlineCashDevices = mysqlTable(
  'pos_rewrite_offline_cash_devices',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    publicKey: text('public_key_json').notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at_ms', { mode: 'number' }),
  },
  (table) => [index('ix_offline_cash_device_operator').on(table.operatorId, table.storeId)],
);

export const offlineCashAuthorizations = mysqlTable(
  'pos_rewrite_offline_cash_authorizations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    deviceId: varchar('device_id', { length: 36 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    envelope: text('authorization_json').notNull(),
    snapshot: mediumtext('snapshot_json').notNull(),
    snapshotHash: varchar('snapshot_hash', { length: 64 }).notNull(),
    acceptedReceipts: int('accepted_receipts').notNull(),
    acceptedCents: bigint('accepted_cents', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at_ms', { mode: 'number' }),
  },
  (table) => [index('ix_offline_cash_authorization_device').on(table.deviceId, table.createdAt)],
);

export const offlineCashReceipts = mysqlTable(
  'pos_rewrite_offline_cash_receipts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    authorizationId: varchar('authorization_id', { length: 36 }).notNull(),
    deviceId: varchar('device_id', { length: 36 }).notNull(),
    sequence: int('sequence').notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    draftId: varchar('draft_id', { length: 36 }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    completedAt: bigint('completed_at_ms', { mode: 'number' }).notNull(),
    acceptedAt: bigint('accepted_at_ms', { mode: 'number' }).notNull(),
    receiptNumber: varchar('receipt_number', { length: 40 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    envelope: mediumtext('receipt_json').notNull(),
    payableCents: bigint('payable_cents', { mode: 'number' }).notNull(),
    cashReceivedCents: bigint('cash_received_cents', { mode: 'number' }).notNull(),
    changeCents: bigint('change_cents', { mode: 'number' }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    conflicts: text('conflicts_json').notNull(),
    version: int('version').notNull(),
    orderId: varchar('order_id', { length: 32 }),
    requestId: varchar('request_id', { length: 128 }),
  },
  (table) => [
    uniqueIndex('uq_offline_cash_receipt_sequence').on(table.authorizationId, table.sequence),
    uniqueIndex('uq_offline_cash_receipt_draft').on(table.operatorId, table.draftId),
    uniqueIndex('uq_offline_cash_receipt_number').on(table.receiptNumber),
    uniqueIndex('uq_offline_cash_receipt_order').on(table.orderId),
    index('ix_offline_cash_receipt_finance').on(table.storeId, table.businessDate, table.id),
    index('ix_offline_cash_receipt_queue').on(
      table.storeId,
      table.status,
      table.acceptedAt,
      table.id,
    ),
    index('ix_offline_cash_receipt_device').on(table.deviceId, table.acceptedAt, table.id),
  ],
);

// Only the reviewed importer may write this link, in the transaction that
// finalizes the exact cash order/payment/projection. Finance excludes that
// ordinary order once and always retains the immutable offline receipt.
export const offlineCashOrderLinks = mysqlTable(
  'pos_rewrite_offline_cash_order_links',
  {
    receiptId: varchar('receipt_id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    payableCents: bigint('payable_cents', { mode: 'number' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    projectionHash: varchar('projection_hash', { length: 64 }).notNull(),
    finalizedAt: bigint('finalized_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [uniqueIndex('uq_offline_cash_link_order').on(table.orderId)],
);

export const offlineCashEvents = mysqlTable(
  'pos_rewrite_offline_cash_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    receiptId: varchar('receipt_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    details: text('details_json').notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('ix_offline_cash_event_receipt').on(table.receiptId, table.createdAt, table.id),
  ],
);

export const offlineCashCloseImpacts = mysqlTable(
  'pos_rewrite_offline_cash_close_impacts',
  {
    receiptId: varchar('receipt_id', { length: 36 }).notNull(),
    closeId: bigint('close_id', { mode: 'bigint' }).notNull(),
    priorStatus: varchar('prior_status', { length: 16 }).notNull(),
    priorReason: varchar('prior_reason', { length: 64 }),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.receiptId, table.closeId] })],
);

export const offlineCashReceiptLines = mysqlTable(
  'pos_rewrite_offline_cash_receipt_lines',
  {
    receiptId: varchar('receipt_id', { length: 36 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    productId: varchar('product_id', { length: 32 }).notNull(),
    quantity: smallint('quantity', { unsigned: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.receiptId, table.productId] }),
    index('ix_offline_cash_pending_stock').on(table.storeId, table.productId, table.receiptId),
  ],
);
export const offlineCashSigningKeys = mysqlTable('pos_rewrite_offline_cash_signing_keys', {
  keyId: varchar('key_id', { length: 64 }).primaryKey(),
  publicKey: text('public_key_json').notNull(),
  createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
});
export const offlineCashImportProofs = mysqlTable(
  'pos_rewrite_offline_cash_import_proofs',
  {
    receiptId: varchar('receipt_id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    keyId: varchar('key_id', { length: 64 }).notNull(),
    proof: mediumtext('proof_json').notNull(),
    signature: varchar('signature', { length: 86 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [uniqueIndex('uq_offline_cash_import_proof_order').on(table.orderId)],
);
