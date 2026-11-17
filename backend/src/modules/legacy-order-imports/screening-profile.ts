import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { bigint, index, json, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  HasProduct,
  MUser,
  Order,
  OrderStore,
  Product,
  ProductBarcode,
  ProductStore,
  Store,
} from '../../db/legacy-schema.js';
import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { operationHash } from '../checkout/crypto.js';
import {
  assertFinancialImportAuthority,
  lockFinancialImportScope,
} from './financial-adapter-authority.js';
import {
  equalImportHash,
  financialSourceHash,
  importFinancialError,
} from './financial-adapter-crypto.js';
import { sourceRejectionReceiptSchema } from './financial-adapter-contracts.js';
import { legacyImportFinancialJournal } from './financial-adapter-journal.js';
import {
  financialImportOrderBindings,
  financialImportSourceReceipts,
} from './financial-adapter-schema.js';
import { readSourceOrderReceipt, verifiedImportCompletion } from './financial-adapter-proof.js';
import { financialImportScopeSchema } from './financial-adapter-contracts.js';
import type { ImportFinancialScope } from './financial-contracts.js';

export const screeningProfileContract = 'pos-csv-screening-2960-v1';
export const screeningSchemaContract = 'pos-screening-schema-v1';
export const screeningWriterContract = 'pos-screening-all-writers-v1';
export const screeningTicketSku = '390238';
export const screeningMaximum = 2;
export const screeningSource = {
  apiCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
  helperHash: 'a3ec2d593ddfb990b6462fe4f71a8c70f5aa7b95a6704ffb4a0566b14e515e46',
  controllerHash: '821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad',
  modelHash: 'd9ee1cd52546e9d8dce0952e901ecba0d58fe1c1b68d95149781131e1553fca5',
} as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  count = z.string().regex(/^(?:0|[1-9]\d{0,19})$/),
  time = z.number().int().safe().positive();
export const screeningReservationSchema = z
  .object({
    contract: z.literal(screeningProfileContract),
    scope: financialImportScopeSchema,
    source: z
      .object({
        apiCommit: z.literal(screeningSource.apiCommit),
        helperHash: z.literal(screeningSource.helperHash),
        controllerHash: z.literal(screeningSource.controllerHash),
        modelHash: z.literal(screeningSource.modelHash),
      })
      .strict(),
    customerId: identifier,
    sku: z.literal(screeningTicketSku),
    kind: z.enum(['offline', 'shopify']),
    planHash: hash,
    requestHash: hash,
    authorityHash: hash,
    catalogHash: hash,
    quantity: z.number().int().min(1).max(screeningMaximum),
    lineItemsEnabled: z.boolean(),
    markerRows: z.number().int().min(1).max(screeningMaximum),
    sourceCountBefore: count,
    pendingBefore: z.number().int().min(0).max(2000),
    phase: z.enum(['RESERVED', 'BOUND', 'COUNTED', 'REJECTED']),
    orderId: identifier.nullable(),
    lines: z
      .array(
        z
          .object({ id: identifier, quantity: z.number().int().min(1).max(screeningMaximum) })
          .strict(),
      )
      .max(screeningMaximum),
    markers: z
      .array(z.object({ id: identifier, lineId: identifier }).strict())
      .max(screeningMaximum),
    sourceReceiptHash: hash.nullable(),
    completionHash: hash.nullable(),
    rejectionHash: hash.nullable(),
    version: z.number().int().positive().safe(),
    createdAt: time,
    updatedAt: time,
  })
  .strict()
  .superRefine((value, context) => {
    const bound = ['BOUND', 'COUNTED'].includes(value.phase);
    if (
      value.markerRows !== (value.lineItemsEnabled ? value.quantity : 1) ||
      bound !== (value.orderId !== null) ||
      (bound
        ? value.lines.length !== value.markerRows ||
          value.markers.length !== value.markerRows ||
          value.lines.reduce((sum, line) => sum + line.quantity, 0) !== value.quantity
        : value.lines.length !== 0 || value.markers.length !== 0) ||
      new Set(value.lines.map((line) => line.id)).size !== value.lines.length ||
      new Set(value.markers.map((row) => row.id)).size !== value.markers.length ||
      new Set(value.markers.map((row) => row.lineId)).size !== value.markers.length ||
      value.markers.some((row) => !value.lines.some((line) => line.id === row.lineId)) ||
      (value.phase === 'COUNTED' && (!value.completionHash || !value.sourceReceiptHash)) ||
      (value.phase === 'COUNTED') !== (value.completionHash !== null) ||
      (value.phase === 'REJECTED') !== (value.rejectionHash !== null) ||
      (!bound && value.sourceReceiptHash !== null) ||
      value.updatedAt < value.createdAt
    )
      context.addIssue({
        code: 'custom',
        message: 'The screening reservation structure is inconsistent.',
      });
  });
export type ScreeningReservation = z.infer<typeof screeningReservationSchema>;
export interface ScreeningProfileOptions {
  /** Unselected by default. Each contract requires separate deployment qualification. */
  contract?: typeof screeningProfileContract;
  schemaContract?: typeof screeningSchemaContract;
  writerContract?: typeof screeningWriterContract;
  proofKey: string;
  financialSecret: string;
  clock?: () => number;
}
/** Source-model mapping only; physical metadata qualification is a release input. */
export const screeningPurchases = mysqlTable('spiderman_screening_orders', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  lineId: bigint('has_product_id', { mode: 'bigint' }).notNull(),
  customerId: bigint('user_id', { mode: 'bigint' }).notNull(),
});
export const screeningReservations = mysqlTable(
  'pos_rewrite_import_screening_reservations',
  {
    operationId: varchar('operation_id', { length: 36 }).primaryKey(),
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    sku: varchar('sku', { length: 32 }).notNull(),
    orderId: varchar('order_id', { length: 32 }),
    data: json('data').$type<ScreeningReservation>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  },
  (table) => [
    index('ix_import_screening_customer').on(table.customerId, table.sku),
    uniqueIndex('uq_import_screening_order').on(table.orderId),
  ],
);
/** Reviewable DDL only. No startup path executes this or selects the profile. */
export const screeningReservationDdl = `CREATE TABLE pos_rewrite_import_screening_reservations (
 operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
 customer_id VARCHAR(32) NOT NULL,
 sku VARCHAR(32) NOT NULL,
 order_id VARCHAR(32) NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 INDEX ix_import_screening_customer(customer_id,sku),
 UNIQUE KEY uq_import_screening_order(order_id)
) ENGINE=InnoDB`;
export function screeningProof(
  key: string,
  purpose: 'ready' | 'state' | 'authority' | 'catalog' | 'completion',
  value: unknown,
) {
  if (!/^[!-~]{32,4096}$/.test(key))
    throw importFinancialError('ORDER_IMPORT_SCREENING_KEY_REQUIRED', 503);
  return operationHash('legacy-order-imports.source.screening-' + purpose + '.v1', value, key);
}
/** Exact source COUNT(*) join multiplicity, statuses and SKU filter. Current locking read. */
export async function readScreeningTicketCount(
  tx: AdministrationTransaction,
  customerId: string,
): Promise<bigint> {
  identifier.parse(customerId);
  try {
    const [row] = await tx
      .select({ value: sql<string>`CAST(COUNT(*) AS CHAR)` })
      .from(screeningPurchases)
      .innerJoin(Order, eq(Order.id, screeningPurchases.orderId))
      .innerJoin(HasProduct, eq(HasProduct.id, screeningPurchases.lineId))
      .where(
        and(
          eq(screeningPurchases.customerId, BigInt(customerId)),
          eq(HasProduct.product, BigInt(screeningTicketSku)),
          notInArray(Order.order_statuses, [0n, 17n]),
        ),
      )
      .for('share');
    return BigInt(count.parse(row?.value));
  } catch {
    throw importFinancialError('ORDER_IMPORT_SCREENING_COUNT_UNAVAILABLE', 503);
  }
}
export function enforceScreeningTicketLimit(bought: bigint, quantity: number, pending = 0) {
  if (
    typeof bought !== 'bigint' ||
    bought < 0n ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 999 ||
    !Number.isSafeInteger(pending) ||
    pending < 0
  )
    throw importFinancialError('ORDER_IMPORT_SCREENING_QUANTITY_INVALID', 422);
  if (bought + BigInt(pending) + BigInt(quantity) > BigInt(screeningMaximum))
    throw importFinancialError('ORDER_IMPORT_SCREENING_LIMIT', 409);
}
export function screeningImportProfile(
  config: Config,
  db: Databases,
  options: ScreeningProfileOptions,
) {
  const journal = legacyImportFinancialJournal(config, db, {
      secret: options.financialSecret,
      clock: options.clock,
    }),
    clock = options.clock ?? Date.now;
  function scopeValue(scope: ImportFinancialScope) {
    return financialImportScopeSchema.parse({
      actorId: scope.actorId,
      operationId: scope.operationId,
      storeId: scope.storeId,
      counterId: scope.counterId,
    });
  }
  function ready() {
    if (
      options.contract !== screeningProfileContract ||
      options.schemaContract !== screeningSchemaContract ||
      options.writerContract !== screeningWriterContract
    )
      throw importFinancialError('ORDER_IMPORT_SCREENING_UNQUALIFIED', 503);
    screeningProof(options.proofKey, 'ready', null);
  }
  function parsed(row: typeof screeningReservations.$inferSelect) {
    const value = screeningReservationSchema.safeParse(row.data);
    if (
      !value.success ||
      row.operationId !== value.data.scope.operationId ||
      row.customerId !== value.data.customerId ||
      row.sku !== value.data.sku ||
      row.orderId !== value.data.orderId ||
      !equalImportHash(row.proofHash, screeningProof(options.proofKey, 'state', value.data))
    )
      throw importFinancialError('ORDER_IMPORT_SCREENING_PROOF_INVALID', 503);
    return value.data;
  }
  async function save(tx: AdministrationTransaction, value: ScreeningReservation) {
    const data = screeningReservationSchema.parse({ ...value, updatedAt: clock() });
    await tx
      .update(screeningReservations)
      .set({
        orderId: data.orderId,
        data,
        proofHash: screeningProof(options.proofKey, 'state', data),
      })
      .where(eq(screeningReservations.operationId, data.scope.operationId));
    return data;
  }
  async function row(tx: AdministrationTransaction, scope: ImportFinancialScope) {
    const [found] = await tx
      .select()
      .from(screeningReservations)
      .where(eq(screeningReservations.operationId, scope.operationId))
      .limit(1)
      .for('update');
    if (!found) throw importFinancialError('ORDER_IMPORT_SCREENING_RESERVATION_REQUIRED');
    const value = parsed(found);
    if (JSON.stringify(value.scope) !== JSON.stringify(scopeValue(scope)))
      throw importFinancialError('ORDER_IMPORT_SCREENING_SCOPE_CHANGED', 403);
    return value;
  }
  async function retained(tx: AdministrationTransaction, scope: ImportFinancialScope) {
    const [hint] = await tx
      .select()
      .from(screeningReservations)
      .where(eq(screeningReservations.operationId, scope.operationId))
      .limit(1);
    if (!hint) throw importFinancialError('ORDER_IMPORT_SCREENING_RESERVATION_REQUIRED');
    const original = parsed(hint);
    if (JSON.stringify(original.scope) !== JSON.stringify(scopeValue(scope)))
      throw importFinancialError('ORDER_IMPORT_SCREENING_SCOPE_CHANGED', 403);
    await tx
      .select({ id: Store.id })
      .from(Store)
      .where(eq(Store.id, BigInt(scope.storeId)))
      .limit(1)
      .for('update');
    await tx
      .select({ id: MUser.id })
      .from(MUser)
      .where(eq(MUser.id, BigInt(original.customerId)))
      .limit(1)
      .for('update');
    const value = await row(tx, scope);
    if (value.customerId !== original.customerId)
      throw importFinancialError('ORDER_IMPORT_SCREENING_SCOPE_CHANGED');
    return value;
  }
  async function structural(tx: AdministrationTransaction, value: ScreeningReservation) {
    if (!value.orderId) throw importFinancialError('ORDER_IMPORT_SCREENING_ORDER_UNCONFIRMED');
    const orderId = BigInt(value.orderId),
      [order] = await tx
        .select({ customerId: Order.user, status: Order.order_statuses })
        .from(Order)
        .where(eq(Order.id, orderId))
        .limit(1)
        .for('share');
    const stores = await tx
      .select({ storeId: OrderStore.store, counterId: OrderStore.counter })
      .from(OrderStore)
      .where(eq(OrderStore.order, orderId))
      .limit(2)
      .for('share');
    const lines = await tx
      .select({ id: HasProduct.id, quantity: HasProduct.qty, subProductId: HasProduct.sub_prod_id })
      .from(HasProduct)
      .where(and(eq(HasProduct.order, orderId), eq(HasProduct.product, BigInt(screeningTicketSku))))
      .orderBy(asc(HasProduct.id))
      .limit(3)
      .for('share');
    const markers = await tx
      .select()
      .from(screeningPurchases)
      .where(eq(screeningPurchases.orderId, orderId))
      .orderBy(asc(screeningPurchases.id))
      .limit(3)
      .for('share');
    if (
      !order ||
      String(order.customerId) !== value.customerId ||
      stores.length !== 1 ||
      String(stores[0]!.storeId) !== value.scope.storeId ||
      String(stores[0]!.counterId) !== value.scope.counterId ||
      lines.length !== value.markerRows ||
      markers.length !== value.markerRows ||
      lines.some((line) => line.subProductId !== 0n || line.quantity < 1n || line.quantity > 2n) ||
      lines.reduce((sum, line) => sum + line.quantity, 0n) !== BigInt(value.quantity) ||
      (value.lineItemsEnabled && lines.some((line) => line.quantity !== 1n)) ||
      new Set(markers.map((marker) => String(marker.lineId))).size !== value.markerRows ||
      markers.some(
        (marker) =>
          String(marker.customerId) !== value.customerId ||
          !lines.some((line) => line.id === marker.lineId),
      )
    )
      throw importFinancialError('ORDER_IMPORT_SCREENING_STRUCTURE_CHANGED');
    const projection = {
      lines: lines.map((line) => ({ id: String(line.id), quantity: Number(line.quantity) })),
      markers: markers.map((marker) => ({ id: String(marker.id), lineId: String(marker.lineId) })),
    };
    if (
      value.lines.length &&
      (JSON.stringify(projection.lines) !== JSON.stringify(value.lines) ||
        JSON.stringify(projection.markers) !== JSON.stringify(value.markers))
    )
      throw importFinancialError('ORDER_IMPORT_SCREENING_STRUCTURE_CHANGED');
    return {
      ...projection,
      counted: order.status !== null && order.status !== 0n && order.status !== 17n,
    };
  }
  async function admissionContext(tx: AdministrationTransaction, scope: ImportFinancialScope) {
    await lockFinancialImportScope(tx, scopeValue(scope));
    const bound = await journal.load(tx, scopeValue(scope));
    if (!bound) throw importFinancialError('ORDER_IMPORT_FINANCIAL_SCOPE_INVALID');
    await assertFinancialImportAuthority(tx, scope, bound.state.authority);
    await tx
      .select({ id: MUser.id })
      .from(MUser)
      .where(eq(MUser.id, BigInt(bound.state.authority.customerId)))
      .limit(1)
      .for('update');
    return bound;
  }
  return {
    qualified:
      options.contract === screeningProfileContract &&
      options.schemaContract === screeningSchemaContract &&
      options.writerContract === screeningWriterContract,
    async reserve(
      tx: AdministrationTransaction,
      scope: ImportFinancialScope,
      lineItemsEnabled: boolean,
    ): Promise<ScreeningReservation | null> {
      ready();
      scope = scopeValue(scope);
      z.boolean().parse(lineItemsEnabled);
      const bound = await admissionContext(tx, scope),
        line = bound.plan.lines.find((value) => value.productId === screeningTicketSku);
      if (!line) return null;
      enforceScreeningTicketLimit(0n, line.quantity);
      const authorityHash = screeningProof(options.proofKey, 'authority', bound.state.authority),
        prior = await tx
          .select()
          .from(screeningReservations)
          .where(eq(screeningReservations.operationId, scope.operationId))
          .limit(1)
          .for('update');
      if (prior[0]) {
        const saved = parsed(prior[0]);
        if (
          JSON.stringify(saved.scope) !== JSON.stringify(scopeValue(scope)) ||
          saved.authorityHash !== authorityHash ||
          saved.planHash !== bound.state.planHash ||
          saved.requestHash !== bound.state.requestHash ||
          saved.lineItemsEnabled !== lineItemsEnabled ||
          saved.quantity !== line.quantity ||
          saved.kind !== bound.plan.kind
        )
          throw importFinancialError('ORDER_IMPORT_SCREENING_COMMAND_CHANGED');
        return saved;
      }
      const [catalog] = await tx
        .select({ id: Product.id, parentId: Product.parent_prod_id, type: Product.prod_type })
        .from(Product)
        .where(eq(Product.id, BigInt(screeningTicketSku)))
        .limit(1)
        .for('share');
      const associations = await tx
        .select({
          id: ProductStore.id,
          stock: ProductStore.stock,
          available: ProductStore.is_avail,
          archived: ProductStore.is_del,
        })
        .from(ProductStore)
        .where(
          and(
            eq(ProductStore.product, BigInt(screeningTicketSku)),
            eq(ProductStore.store, BigInt(scope.storeId)),
          ),
        )
        .limit(2)
        .for('update');
      const barcodes = await tx
        .select({ id: ProductBarcode.id, value: ProductBarcode.gtin })
        .from(ProductBarcode)
        .where(eq(ProductBarcode.product, BigInt(screeningTicketSku)))
        .orderBy(asc(ProductBarcode.id))
        .limit(2)
        .for('share');
      const association = associations[0];
      if (
        !catalog ||
        associations.length !== 1 ||
        !association?.available ||
        association.archived ||
        association.stock < line.quantity ||
        barcodes.length !== 1 ||
        !barcodes[0]!.value
      )
        throw importFinancialError('ORDER_IMPORT_SCREENING_CATALOG_REVIEW');
      const all = await tx
        .select()
        .from(screeningReservations)
        .where(
          and(
            eq(screeningReservations.customerId, bound.state.authority.customerId),
            eq(screeningReservations.sku, screeningTicketSku),
          ),
        )
        .orderBy(asc(screeningReservations.operationId))
        .limit(1001)
        .for('update');
      if (all.length > 1000)
        throw importFinancialError('ORDER_IMPORT_SCREENING_RECONCILIATION_REQUIRED');
      let pending = 0;
      for (const existing of all) {
        const value = parsed(existing);
        if (value.phase === 'RESERVED') pending += value.markerRows;
        else if (value.phase === 'BOUND' && !(await structural(tx, value)).counted)
          pending += value.markerRows;
      }
      const bought = await readScreeningTicketCount(tx, bound.state.authority.customerId);
      enforceScreeningTicketLimit(bought, line.quantity, pending);
      const now = clock(),
        value = screeningReservationSchema.parse({
          contract: screeningProfileContract,
          scope,
          source: screeningSource,
          customerId: bound.state.authority.customerId,
          sku: screeningTicketSku,
          kind: bound.plan.kind,
          planHash: bound.state.planHash,
          requestHash: bound.state.requestHash,
          authorityHash,
          catalogHash: screeningProof(options.proofKey, 'catalog', {
            id: String(catalog.id),
            parentId: String(catalog.parentId),
            type: String(catalog.type),
            associationId: String(association.id),
            stock: association.stock,
            barcodeId: String(barcodes[0]!.id),
            barcode: String(barcodes[0]!.value),
          }),
          quantity: line.quantity,
          lineItemsEnabled,
          markerRows: lineItemsEnabled ? line.quantity : 1,
          sourceCountBefore: String(bought),
          pendingBefore: pending,
          phase: 'RESERVED',
          orderId: null,
          lines: [],
          markers: [],
          sourceReceiptHash: null,
          completionHash: null,
          rejectionHash: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      await tx.insert(screeningReservations).values({
        operationId: scope.operationId,
        customerId: value.customerId,
        sku: screeningTicketSku,
        orderId: null,
        data: value,
        proofHash: screeningProof(options.proofKey, 'state', value),
      });
      return value;
    },
    /** Called in the source order's outer transaction, never after its visible commit. */
    async bind(tx: AdministrationTransaction, scope: ImportFinancialScope, orderId: string) {
      ready();
      const bound = await admissionContext(tx, scope),
        value = await row(tx, scope);
      if (
        value.authorityHash !== screeningProof(options.proofKey, 'authority', bound.state.authority)
      )
        throw importFinancialError('ORDER_IMPORT_SCREENING_SCOPE_CHANGED');
      if (value.phase !== 'RESERVED') {
        if (value.orderId !== orderId)
          throw importFinancialError('ORDER_IMPORT_SCREENING_REPLAY_REQUIRED');
        await structural(tx, value);
        return value;
      }
      const provisional = { ...value, orderId: identifier.parse(orderId) },
        projection = await structural(tx, provisional);
      return save(tx, {
        ...provisional,
        phase: 'BOUND',
        lines: projection.lines,
        markers: projection.markers,
        version: value.version + 1,
      });
    },
    async attachSourceReceipt(tx: AdministrationTransaction, scope: ImportFinancialScope) {
      ready();
      const bound = await admissionContext(tx, scope),
        value = await row(tx, scope),
        receipt = await readSourceOrderReceipt(tx, scope.operationId, options.proofKey);
      if (
        (value.phase !== 'BOUND' && value.phase !== 'COUNTED') ||
        !receipt ||
        receipt.orderId !== value.orderId ||
        receipt.customerId !== value.customerId ||
        receipt.storeId !== scope.storeId ||
        receipt.counterId !== scope.counterId ||
        receipt.requestHash !== value.requestHash ||
        value.planHash !== bound.state.planHash
      )
        throw importFinancialError('ORDER_IMPORT_SCREENING_ORDER_UNCONFIRMED');
      await structural(tx, value);
      const signature = financialSourceHash(options.proofKey, 'order', receipt);
      const ticketLines = receipt.lines
        .filter((line) => line.productId === screeningTicketSku)
        .map((line) => ({ id: line.id, quantity: line.quantity }));
      if (
        JSON.stringify(ticketLines) !== JSON.stringify(value.lines) ||
        (value.sourceReceiptHash !== null && value.sourceReceiptHash !== signature)
      )
        throw importFinancialError('ORDER_IMPORT_SCREENING_ORDER_UNCONFIRMED');
      return value.sourceReceiptHash === signature
        ? value
        : save(tx, { ...value, sourceReceiptHash: signature, version: value.version + 1 });
    },
    /** No expiry/unknown response can free quota. Requires retained financial completion. */
    async complete(tx: AdministrationTransaction, scope: ImportFinancialScope) {
      ready();
      const value = await retained(tx, scope),
        proof = await verifiedImportCompletion(tx, scope.operationId, options.financialSecret);
      if (
        (value.phase !== 'BOUND' && value.phase !== 'COUNTED') ||
        !value.sourceReceiptHash ||
        !proof ||
        proof.order.orderId !== value.orderId ||
        proof.requestHash !== value.requestHash ||
        JSON.stringify(proof.scope) !== JSON.stringify(value.scope) ||
        proof.authority.customerId !== value.customerId ||
        !(await structural(tx, value)).counted
      )
        throw importFinancialError('ORDER_IMPORT_SCREENING_COMPLETION_UNCONFIRMED');
      const signature = screeningProof(options.proofKey, 'completion', proof);
      if (value.phase === 'COUNTED') {
        if (value.completionHash !== signature)
          throw importFinancialError('ORDER_IMPORT_SCREENING_PROOF_INVALID');
        return value;
      }
      return save(tx, {
        ...value,
        phase: 'COUNTED',
        completionHash: signature,
        version: value.version + 1,
      });
    },
    async releaseRejected(tx: AdministrationTransaction, scope: ImportFinancialScope) {
      ready();
      const value = await retained(tx, scope);
      if (value.phase === 'REJECTED') return value;
      const [negative] = await tx
        .select()
        .from(financialImportSourceReceipts)
        .where(
          and(
            eq(financialImportSourceReceipts.operationId, scope.operationId),
            eq(financialImportSourceReceipts.kind, 'order'),
            eq(financialImportSourceReceipts.status, 'rejected'),
          ),
        )
        .limit(1)
        .for('share');
      const parsedNegative = sourceRejectionReceiptSchema.safeParse(negative?.proof),
        bindings = await tx
          .select({ id: financialImportOrderBindings.orderId })
          .from(financialImportOrderBindings)
          .where(eq(financialImportOrderBindings.operationId, scope.operationId))
          .limit(1)
          .for('share');
      if (
        value.phase !== 'RESERVED' ||
        value.orderId !== null ||
        bindings.length ||
        !negative ||
        !parsedNegative.success ||
        parsedNegative.data.operationId !== scope.operationId ||
        parsedNegative.data.requestHash !== value.requestHash ||
        negative.requestHash !== value.requestHash ||
        !equalImportHash(
          negative.proofHash,
          financialSourceHash(options.proofKey, 'rejection', parsedNegative.data),
        )
      )
        throw importFinancialError('ORDER_IMPORT_SCREENING_NO_EFFECTS_REQUIRED');
      return save(tx, {
        ...value,
        phase: 'REJECTED',
        rejectionHash: negative.proofHash,
        version: value.version + 1,
      });
    },
    async read(tx: AdministrationTransaction, scope: ImportFinancialScope) {
      ready();
      return retained(tx, scope);
    },
  };
}
