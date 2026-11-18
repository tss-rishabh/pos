import type BetterSqlite from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import type { WindowState, OfflineLimits } from '../../src/offline/billing/limits';
import type {
  CatalogProduct,
  ConflictCode,
  OfflineSale,
  SaleStatus,
  Tender,
} from '../../src/offline/billing/contracts';

/** The native constructor is injected: packaged builds load it from
 * resources/offline-sqlite (outside the ASAR), development from node_modules. */
export type SqliteConstructor = typeof BetterSqlite;
export type SqliteDatabase = InstanceType<SqliteConstructor>;

export class OfflineDatabaseLockedError extends Error {
  constructor() {
    super('The offline billing database could not be opened with this device key.');
  }
}

/** Open (or create) the SQLCipher-compatible (AES-256, SQLCipher v4 format)
 * database. The key is the raw per-device 256-bit secret; it never leaves the
 * main process. A wrong key, or a file that is not this database, fails. */
export function openEncryptedDatabase(
  Database: SqliteConstructor,
  filename: string,
  key: Buffer,
): SqliteDatabase {
  if (key.length !== 32) throw new RangeError('The offline database key must be 256 bits.');
  const db = new Database(filename, { timeout: 5000 });
  try {
    db.pragma(`cipher='sqlcipher'`);
    db.pragma('legacy=4');
    db.key(key);
    // Reading the schema forces page-1 decryption; a wrong key throws here.
    db.prepare('SELECT count(*) AS count FROM sqlite_master').get();
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('secure_delete = ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    if (error instanceof Error && /not a database|file is encrypted/i.test(error.message))
      throw new OfflineDatabaseLockedError();
    throw error;
  }
}

const migrations: readonly string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
   CREATE TABLE operators (
     operator_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     role INTEGER NOT NULL,
     user_type INTEGER NOT NULL,
     store_ids TEXT NOT NULL,
     checked_in_store_id TEXT,
     checked_in_counter_id TEXT,
     check_in_expires_at INTEGER,
     session_expires_at INTEGER NOT NULL,
     verified_at INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE stores (store_id TEXT PRIMARY KEY, name TEXT NOT NULL, refreshed_at INTEGER NOT NULL) STRICT;
   CREATE TABLE counters (
     counter_id TEXT PRIMARY KEY,
     store_id TEXT NOT NULL,
     name TEXT NOT NULL,
     refreshed_at INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE products (
     store_id TEXT NOT NULL,
     product_id TEXT NOT NULL,
     name TEXT NOT NULL,
     barcode TEXT,
     unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
     stock INTEGER NOT NULL,
     cached_at INTEGER NOT NULL,
     PRIMARY KEY (store_id, product_id)
   ) STRICT;
   CREATE TABLE barcodes (
     store_id TEXT NOT NULL,
     barcode TEXT NOT NULL,
     product_id TEXT NOT NULL,
     PRIMARY KEY (store_id, barcode, product_id)
   ) STRICT;
   CREATE TABLE sales (
     sale_id TEXT PRIMARY KEY,
     sequence INTEGER NOT NULL UNIQUE,
     provisional_ref TEXT NOT NULL UNIQUE,
     store_id TEXT NOT NULL,
     counter_id TEXT NOT NULL,
     operator_id TEXT NOT NULL,
     operator_name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     gross_paise INTEGER NOT NULL,
     rounding_paise INTEGER NOT NULL,
     payable_paise INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('queued','syncing','synced','needs_manager','voided')),
     order_id TEXT,
     invoice_number TEXT,
     synced_at INTEGER,
     resolution TEXT
   ) STRICT;
   CREATE TABLE sale_lines (
     sale_id TEXT NOT NULL REFERENCES sales(sale_id),
     line_no INTEGER NOT NULL,
     product_id TEXT NOT NULL,
     name TEXT NOT NULL,
     unit_price_paise INTEGER NOT NULL,
     quantity INTEGER NOT NULL CHECK (quantity > 0),
     PRIMARY KEY (sale_id, line_no)
   ) STRICT;
   CREATE TABLE payments (
     sale_id TEXT PRIMARY KEY REFERENCES sales(sale_id),
     mode TEXT NOT NULL CHECK (mode IN ('cash','card','upi')),
     amount_paise INTEGER NOT NULL,
     cash_received_paise INTEGER,
     reference TEXT,
     updated_at INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE sync_queue (
     sale_id TEXT PRIMARY KEY REFERENCES sales(sale_id),
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL DEFAULT 0,
     last_error_code TEXT,
     updated_at INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE conflicts (
     conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
     sale_id TEXT NOT NULL REFERENCES sales(sale_id),
     code TEXT NOT NULL,
     message TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     resolved_at INTEGER,
     resolved_by TEXT,
     resolution TEXT
   ) STRICT;
   CREATE INDEX sales_status ON sales(status, sequence);
   CREATE INDEX products_name ON products(store_id, name);
   CREATE INDEX conflicts_open ON conflicts(sale_id, resolved_at);`,
];

function migrate(db: SqliteDatabase) {
  const version = z.number().int().min(0).parse(db.pragma('user_version', { simple: true }));
  if (version > migrations.length)
    throw new Error('The offline billing database was created by a newer application version.');
  for (let index = version; index < migrations.length; index++)
    db.transaction(() => {
      db.exec(migrations[index]!);
      db.pragma(`user_version = ${index + 1}`);
    }).immediate();
}

const metaRow = z.object({ value: z.string() });
const countRow = z.object({ count: z.number().int() });
const operatorRow = z.object({
  operator_id: z.string(),
  name: z.string(),
  role: z.number().int(),
  user_type: z.number().int(),
  store_ids: z.string(),
  checked_in_store_id: z.string().nullable(),
  checked_in_counter_id: z.string().nullable(),
  check_in_expires_at: z.number().int().nullable(),
  session_expires_at: z.number().int(),
  verified_at: z.number().int(),
});
const productRow = z.object({
  product_id: z.string(),
  name: z.string(),
  barcode: z.string().nullable(),
  unit_price_paise: z.number().int(),
  stock: z.number().int(),
});
const saleRow = z.object({
  sale_id: z.string(),
  sequence: z.number().int(),
  provisional_ref: z.string(),
  store_id: z.string(),
  counter_id: z.string(),
  operator_id: z.string(),
  operator_name: z.string(),
  created_at: z.number().int(),
  gross_paise: z.number().int(),
  rounding_paise: z.number().int(),
  payable_paise: z.number().int(),
  status: z.enum(['queued', 'syncing', 'synced', 'needs_manager', 'voided']),
  order_id: z.string().nullable(),
  invoice_number: z.string().nullable(),
  synced_at: z.number().int().nullable(),
  resolution: z.string().nullable(),
  mode: z.enum(['cash', 'card', 'upi']),
  cash_received_paise: z.number().int().nullable(),
  reference: z.string().nullable(),
  attempts: z.number().int().nullable(),
  next_attempt_at: z.number().int().nullable(),
});
const lineRow = z.object({
  product_id: z.string(),
  name: z.string(),
  unit_price_paise: z.number().int(),
  quantity: z.number().int(),
});
const conflictRow = z.object({
  code: z.string(),
  message: z.string(),
  created_at: z.number().int(),
});
const resolutionJson = z.object({
  action: z.enum(['accept', 'correct-tender', 'void']),
  managerId: z.string(),
  reason: z.string(),
  resolvedAt: z.number().int(),
});

export interface CachedOperator {
  id: string;
  name: string;
  role: number;
  userType: number;
  storeIds: string[];
  checkIn: { storeId: string; counterId: string | null; expiresAt: number } | null;
  sessionExpiresAt: number;
  verifiedAt: number;
}
export interface NewSale {
  saleId: string;
  provisionalRef: string;
  sequence: number;
  storeId: string;
  counterId: string;
  operatorId: string;
  operatorName: string;
  createdAt: number;
  grossPaise: number;
  roundingPaise: number;
  payablePaise: number;
  lines: { productId: string; name: string; unitPricePaise: number; quantity: number }[];
  tender: Tender;
}
export type QueueEntry = OfflineSale & { nextAttemptAt: number };

/** All SQL for the device database. Every statement binds its values. */
export function offlineStore(db: SqliteDatabase) {
  const getMeta = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row === undefined ? null : metaRow.parse(row).value;
  };
  const setMeta = (key: string, value: string) => {
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  };
  function linesFor(saleId: string) {
    return db
      .prepare(
        'SELECT product_id, name, unit_price_paise, quantity FROM sale_lines WHERE sale_id = ? ORDER BY line_no',
      )
      .all(saleId)
      .map((row) => {
        const line = lineRow.parse(row);
        return {
          productId: line.product_id,
          name: line.name,
          unitPricePaise: line.unit_price_paise,
          quantity: line.quantity,
        };
      });
  }
  function openConflict(saleId: string) {
    const row = db
      .prepare(
        'SELECT code, message, created_at FROM conflicts WHERE sale_id = ? AND resolved_at IS NULL ORDER BY conflict_id DESC LIMIT 1',
      )
      .get(saleId);
    if (row === undefined) return null;
    const parsed = conflictRow.parse(row);
    const code = z
      .enum(['STOCK_SHORTFALL', 'PRICE_CHANGED', 'TENDER_REFERENCE_NOT_FOUND', 'OPERATOR_REVOKED', 'REJECTED'])
      .catch('REJECTED')
      .parse(parsed.code);
    return { code, message: parsed.message, createdAt: parsed.created_at };
  }
  const saleSelect = `SELECT s.*, p.mode, p.cash_received_paise, p.reference, q.attempts, q.next_attempt_at
    FROM sales s JOIN payments p ON p.sale_id = s.sale_id LEFT JOIN sync_queue q ON q.sale_id = s.sale_id`;
  function toSale(row: unknown): QueueEntry {
    const sale = saleRow.parse(row);
    const tender: OfflineSale['tender'] =
      sale.mode === 'cash'
        ? {
            mode: 'cash',
            receivedPaise: sale.cash_received_paise ?? sale.payable_paise,
            changePaise: Math.max(0, (sale.cash_received_paise ?? sale.payable_paise) - sale.payable_paise),
          }
        : { mode: sale.mode, reference: sale.reference ?? '' };
    const resolution = sale.resolution ? resolutionJson.parse(JSON.parse(sale.resolution)) : null;
    return {
      saleId: sale.sale_id,
      provisionalRef: sale.provisional_ref,
      storeId: sale.store_id,
      counterId: sale.counter_id,
      operatorId: sale.operator_id,
      operatorName: sale.operator_name,
      createdAt: sale.created_at,
      status: sale.status,
      lines: linesFor(sale.sale_id),
      grossPaise: sale.gross_paise,
      roundingPaise: sale.rounding_paise,
      payablePaise: sale.payable_paise,
      tender,
      orderId: sale.order_id,
      invoiceNumber: sale.invoice_number,
      syncedAt: sale.synced_at,
      attempts: sale.attempts ?? 0,
      conflict: sale.status === 'needs_manager' ? openConflict(sale.sale_id) : null,
      resolution,
      nextAttemptAt: sale.next_attempt_at ?? 0,
    };
  }
  return {
    db,
    transaction<T>(work: () => T): T {
      return db.transaction(work).immediate();
    },
    getMeta,
    setMeta,
    getJson<T>(key: string, schema: z.ZodType<T>): T | null {
      const value = getMeta(key);
      if (value === null) return null;
      const parsed = schema.safeParse(JSON.parse(value));
      return parsed.success ? parsed.data : null;
    },
    setJson(key: string, value: unknown) {
      setMeta(key, JSON.stringify(value));
    },
    nextSequence(): number {
      const current = Number(getMeta('sequence') ?? '0');
      const next = (Number.isSafeInteger(current) ? current : 0) + 1;
      setMeta('sequence', String(next));
      return next;
    },
    limits(): OfflineLimits | null {
      const value = getMeta('limits');
      if (value === null) return null;
      return z
        .object({ maxMinutes: z.number().int().min(1), maxOrders: z.number().int().min(1) })
        .parse(JSON.parse(value));
    },
    setLimits(limits: OfflineLimits) {
      setMeta('limits', JSON.stringify(limits));
    },
    window(): WindowState | null {
      const value = getMeta('window');
      if (value === null) return null;
      return z
        .object({
          startedAtWallMs: z.number(),
          elapsedMs: z.number().min(0),
          lastWallMs: z.number(),
          tampered: z.boolean(),
        })
        .parse(JSON.parse(value));
    },
    setWindow(state: WindowState) {
      setMeta('window', JSON.stringify(state));
    },
    saveOperator(operator: CachedOperator) {
      db.prepare(
        `INSERT INTO operators (operator_id, name, role, user_type, store_ids, checked_in_store_id,
           checked_in_counter_id, check_in_expires_at, session_expires_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(operator_id) DO UPDATE SET name = excluded.name, role = excluded.role,
           user_type = excluded.user_type, store_ids = excluded.store_ids,
           checked_in_store_id = excluded.checked_in_store_id,
           checked_in_counter_id = excluded.checked_in_counter_id,
           check_in_expires_at = excluded.check_in_expires_at,
           session_expires_at = excluded.session_expires_at, verified_at = excluded.verified_at`,
      ).run(
        operator.id,
        operator.name,
        operator.role,
        operator.userType,
        JSON.stringify(operator.storeIds),
        operator.checkIn?.storeId ?? null,
        operator.checkIn?.counterId ?? null,
        operator.checkIn?.expiresAt ?? null,
        operator.sessionExpiresAt,
        operator.verifiedAt,
      );
      setMeta('device_operator', operator.id);
    },
    forgetDeviceOperator() {
      db.prepare("DELETE FROM meta WHERE key = 'device_operator'").run();
    },
    deviceOperator(): CachedOperator | null {
      const id = getMeta('device_operator');
      if (id === null) return null;
      const row = db.prepare('SELECT * FROM operators WHERE operator_id = ?').get(id);
      if (row === undefined) return null;
      const op = operatorRow.parse(row);
      return {
        id: op.operator_id,
        name: op.name,
        role: op.role,
        userType: op.user_type,
        storeIds: z.array(z.string()).parse(JSON.parse(op.store_ids)),
        checkIn:
          op.checked_in_store_id && op.check_in_expires_at !== null
            ? {
                storeId: op.checked_in_store_id,
                counterId: op.checked_in_counter_id,
                expiresAt: op.check_in_expires_at,
              }
            : null,
        sessionExpiresAt: op.session_expires_at,
        verifiedAt: op.verified_at,
      };
    },
    replaceCatalog(storeId: string, products: CatalogProduct[], now: number) {
      db.prepare('DELETE FROM products WHERE store_id = ?').run(storeId);
      db.prepare('DELETE FROM barcodes WHERE store_id = ?').run(storeId);
      const product = db.prepare(
        `INSERT INTO products (store_id, product_id, name, barcode, unit_price_paise, stock, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const barcode = db.prepare(
        'INSERT OR IGNORE INTO barcodes (store_id, barcode, product_id) VALUES (?, ?, ?)',
      );
      for (const item of products) {
        product.run(storeId, item.productId, item.name, item.barcode, item.unitPricePaise, item.stock, now);
        if (item.barcode) barcode.run(storeId, item.barcode, item.productId);
      }
      // Re-apply local decrements for sales the server has not yet received.
      const pending = db
        .prepare(
          `SELECT l.product_id, SUM(l.quantity) AS quantity FROM sale_lines l JOIN sales s ON s.sale_id = l.sale_id
           WHERE s.store_id = ? AND s.status IN ('queued','syncing','needs_manager') GROUP BY l.product_id`,
        )
        .all(storeId);
      const decrement = db.prepare(
        'UPDATE products SET stock = stock - ? WHERE store_id = ? AND product_id = ?',
      );
      for (const row of pending) {
        const line = z.object({ product_id: z.string(), quantity: z.number().int() }).parse(row);
        decrement.run(line.quantity, storeId, line.product_id);
      }
      setMeta('catalog', JSON.stringify({ storeId, refreshedAt: now, products: products.length }));
    },
    catalogInfo() {
      const value = getMeta('catalog');
      if (value === null) return null;
      return z
        .object({ storeId: z.string(), refreshedAt: z.number().int(), products: z.number().int() })
        .parse(JSON.parse(value));
    },
    product(storeId: string, productId: string): CatalogProduct | null {
      const row = db
        .prepare(
          'SELECT product_id, name, barcode, unit_price_paise, stock FROM products WHERE store_id = ? AND product_id = ?',
        )
        .get(storeId, productId);
      return row === undefined ? null : toProduct(row);
    },
    search(storeId: string, query: string, limit: number): CatalogProduct[] {
      const escaped = query.replace(/[\\%_]/g, (match) => '\\' + match);
      return db
        .prepare(
          `SELECT product_id, name, barcode, unit_price_paise, stock FROM products
           WHERE store_id = ? AND (name LIKE ? ESCAPE '\\' OR product_id = ? OR barcode = ?)
           ORDER BY name LIMIT ?`,
        )
        .all(storeId, `%${escaped}%`, query, query, limit)
        .map(toProduct);
    },
    byBarcode(storeId: string, code: string): CatalogProduct | null {
      const row = db
        .prepare(
          `SELECT p.product_id, p.name, p.barcode, p.unit_price_paise, p.stock FROM barcodes b
           JOIN products p ON p.store_id = b.store_id AND p.product_id = b.product_id
           WHERE b.store_id = ? AND b.barcode = ? ORDER BY p.product_id LIMIT 1`,
        )
        .get(storeId, code);
      return row === undefined ? null : toProduct(row);
    },
    decrementStock(storeId: string, productId: string, quantity: number) {
      db.prepare('UPDATE products SET stock = stock - ? WHERE store_id = ? AND product_id = ?').run(
        quantity,
        storeId,
        productId,
      );
    },
    insertSale(sale: NewSale) {
      db.prepare(
        `INSERT INTO sales (sale_id, sequence, provisional_ref, store_id, counter_id, operator_id, operator_name,
           created_at, gross_paise, rounding_paise, payable_paise, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      ).run(
        sale.saleId,
        sale.sequence,
        sale.provisionalRef,
        sale.storeId,
        sale.counterId,
        sale.operatorId,
        sale.operatorName,
        sale.createdAt,
        sale.grossPaise,
        sale.roundingPaise,
        sale.payablePaise,
      );
      const line = db.prepare(
        'INSERT INTO sale_lines (sale_id, line_no, product_id, name, unit_price_paise, quantity) VALUES (?, ?, ?, ?, ?, ?)',
      );
      sale.lines.forEach((item, index) =>
        line.run(sale.saleId, index + 1, item.productId, item.name, item.unitPricePaise, item.quantity),
      );
      writeTender(sale.saleId, sale.tender, sale.payablePaise, sale.createdAt);
      db.prepare(
        'INSERT INTO sync_queue (sale_id, attempts, next_attempt_at, updated_at) VALUES (?, 0, 0, ?)',
      ).run(sale.saleId, sale.createdAt);
    },
    writeTender,
    sale(saleId: string): QueueEntry | null {
      const row = db.prepare(`${saleSelect} WHERE s.sale_id = ?`).get(saleId);
      return row === undefined ? null : toSale(row);
    },
    list(status: SaleStatus | undefined, limit: number): QueueEntry[] {
      return (
        status
          ? db.prepare(`${saleSelect} WHERE s.status = ? ORDER BY s.sequence DESC LIMIT ?`).all(status, limit)
          : db.prepare(`${saleSelect} ORDER BY s.sequence DESC LIMIT ?`).all(limit)
      ).map(toSale);
    },
    /** Queued sales due for upload, oldest first. */
    due(now: number): QueueEntry[] {
      return db
        .prepare(
          `${saleSelect} WHERE s.status = 'queued' AND COALESCE(q.next_attempt_at, 0) <= ? ORDER BY s.sequence ASC`,
        )
        .all(now)
        .map(toSale);
    },
    counts() {
      const rows = db.prepare('SELECT status, count(*) AS count FROM sales GROUP BY status').all();
      const result = { queued: 0, syncing: 0, needsManager: 0, synced: 0, voided: 0 };
      for (const row of rows) {
        const parsed = z
          .object({ status: z.enum(['queued', 'syncing', 'synced', 'needs_manager', 'voided']), count: z.number().int() })
          .parse(row);
        if (parsed.status === 'needs_manager') result.needsManager = parsed.count;
        else result[parsed.status] = parsed.count;
      }
      return result;
    },
    /** Order count for the limit: every sale not yet accepted by the server. */
    unsyncedCount(): number {
      return countRow.parse(
        db.prepare("SELECT count(*) AS count FROM sales WHERE status IN ('queued','syncing','needs_manager')").get(),
      ).count;
    },
    markSyncing(saleId: string, now: number) {
      db.prepare("UPDATE sales SET status = 'syncing' WHERE sale_id = ? AND status = 'queued'").run(saleId);
      db.prepare('UPDATE sync_queue SET attempts = attempts + 1, updated_at = ? WHERE sale_id = ?').run(now, saleId);
    },
    markSynced(saleId: string, orderId: string, invoice: string | null, now: number) {
      db.prepare(
        "UPDATE sales SET status = 'synced', order_id = ?, invoice_number = ?, synced_at = ? WHERE sale_id = ?",
      ).run(orderId, invoice, now, saleId);
      db.prepare('DELETE FROM sync_queue WHERE sale_id = ?').run(saleId);
    },
    markRetry(saleId: string, code: string, nextAttemptAt: number, now: number) {
      db.prepare("UPDATE sales SET status = 'queued' WHERE sale_id = ? AND status = 'syncing'").run(saleId);
      db.prepare(
        'UPDATE sync_queue SET next_attempt_at = ?, last_error_code = ?, updated_at = ? WHERE sale_id = ?',
      ).run(nextAttemptAt, code, now, saleId);
    },
    markConflict(saleId: string, code: ConflictCode, message: string, now: number) {
      db.prepare("UPDATE sales SET status = 'needs_manager' WHERE sale_id = ?").run(saleId);
      db.prepare(
        'UPDATE sync_queue SET last_error_code = ?, next_attempt_at = 0, updated_at = ? WHERE sale_id = ?',
      ).run(code, now, saleId);
      db.prepare(
        'INSERT INTO conflicts (sale_id, code, message, created_at) VALUES (?, ?, ?, ?)',
      ).run(saleId, code, message, now);
    },
    resolve(
      saleId: string,
      resolution: { action: 'accept' | 'correct-tender' | 'void'; managerId: string; reason: string; resolvedAt: number },
    ) {
      db.prepare(
        'UPDATE conflicts SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE sale_id = ? AND resolved_at IS NULL',
      ).run(resolution.resolvedAt, resolution.managerId, resolution.action, saleId);
      db.prepare('UPDATE sales SET status = ?, resolution = ? WHERE sale_id = ?').run(
        resolution.action === 'void' ? 'voided' : 'queued',
        JSON.stringify(resolution),
        saleId,
      );
      if (resolution.action === 'void') db.prepare('DELETE FROM sync_queue WHERE sale_id = ?').run(saleId);
      else
        db.prepare(
          'UPDATE sync_queue SET next_attempt_at = 0, updated_at = ? WHERE sale_id = ?',
        ).run(resolution.resolvedAt, saleId);
    },
    /** A crash mid-upload leaves 'syncing'; the server lookup makes a re-upload safe. */
    recoverInterrupted() {
      db.prepare("UPDATE sales SET status = 'queued' WHERE status = 'syncing'").run();
    },
  };
  function writeTender(saleId: string, tender: Tender, payablePaise: number, now: number) {
    db.prepare(
      `INSERT INTO payments (sale_id, mode, amount_paise, cash_received_paise, reference, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(sale_id) DO UPDATE SET mode = excluded.mode, amount_paise = excluded.amount_paise,
         cash_received_paise = excluded.cash_received_paise, reference = excluded.reference,
         updated_at = excluded.updated_at`,
    ).run(
      saleId,
      tender.mode,
      payablePaise,
      tender.mode === 'cash' ? tender.receivedPaise : null,
      tender.mode === 'cash' ? null : tender.reference,
      now,
    );
  }
  function toProduct(row: unknown): CatalogProduct {
    const product = productRow.parse(row);
    return {
      productId: product.product_id,
      name: product.name,
      barcode: product.barcode,
      unitPricePaise: product.unit_price_paise,
      stock: product.stock,
    };
  }
}
export type OfflineStore = ReturnType<typeof offlineStore>;
