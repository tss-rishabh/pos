import { randomUUID } from 'node:crypto';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  CsvUpload,
  HoldStockStore,
  PosHoldStockLog,
  PosUser,
  Product,
  ProductStore,
  Store,
  UserStore,
} from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import type { JobContext } from '../../src/jobs/contract.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import { recordingJobProducer } from '../../src/jobs/module-runtime.js';
import { ecommerceInventoryJob } from '../../src/modules/administration/ecommerce-sync/index.js';
import {
  importMessages,
  importProgressKey,
  importProgressTtlSeconds,
  initialProgress,
} from '../../src/modules/administration/import-domain.js';
import { generatedId } from '../../src/db/generated-id.js';
import { inventoryImportJobs } from '../../src/modules/administration/import-job.js';
import { memoryCsvUploadStorage } from '../../src/modules/administration/import-storage.js';
import { inventoryImportService } from '../../src/modules/administration/imports.js';
import type { StockProcedureInput } from '../../src/modules/administration/stock-procedure.js';
import { legacyFixtureRecord } from '../../tools/administration/mysql-fixture.js';
import { createProductionTables } from '../helpers/production-schema.js';

const template =
  process.env.INVENTORY_JOBS_MYSQL_TEST_URL ?? process.env.ADMINISTRATION_MYSQL_TEST_URL;
const tables: MySqlTable[] = [
  CsvUpload,
  HoldStockStore,
  PosHoldStockLog,
  PosUser,
  Product,
  ProductStore,
  Store,
  UserStore,
];
const stockHeader = 'SkuId,StoreId,IsHold,Hold/UnholdQty,IsAvailable,IsDelete\n';

describe.skipIf(!template)('inventory CSV and ecommerce jobs on isolated MySQL', () => {
  let connection: Connection, db: Databases, schema: string;
  let ephemeral: ReturnType<typeof memoryEphemeralStore>,
    storage: ReturnType<typeof memoryCsvUploadStorage>,
    jobs: ReturnType<typeof recordingJobProducer>;
  const procedureCalls: StockProcedureInput[] = [],
    syncs: { productIds: string[]; operatorId: string }[] = [],
    logs: { level: string; eventId: unknown }[] = [];
  let procedureFailure = false;
  const config = () =>
    readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'inventory-jobs-fixture-secret-'.repeat(2),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_PRIMARY_READER_URL: url(),
      MYSQL_WRITER_URL: url(),
      MYSQL_DATA_READER_URL: url(),
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
  const url = () => {
    const value = new URL(template!);
    value.pathname = '/' + schema;
    return value.href;
  };
  const context = (): JobContext => ({
    jobId: randomUUID(),
    name: 'core.tasks.parse_csv_product_stock',
    requestId: 'request-1',
    userId: '2',
    signal: new AbortController().signal,
  });
  async function seed(table: MySqlTable, values: Record<string, string | number | boolean | null>) {
    const record = Object.entries(legacyFixtureRecord(table, values));
    await connection.execute(
      `INSERT INTO ${mysql.escapeId(getTableConfig(table).name)} (${record.map(([name]) => mysql.escapeId(name)).join(',')}) VALUES (${record.map(() => '?').join(',')})`,
      record.map(([, value]) => value),
    );
  }
  async function rows(query: string, values: unknown[] = []) {
    const [result] = await connection.query<RowDataPacket[]>(query, values);
    return result.map((row) => ({ ...row }));
  }
  function handlers() {
    return inventoryImportJobs({
      config: { BUSINESS_TIMEZONE: 'Asia/Kolkata' },
      db,
      ephemeral,
      storage,
      stockProcedure: async (_tx, input) => {
        procedureCalls.push(input);
        if (procedureFailure) throw new Error('procedure failed');
      },
      productSync: async (productIds, scope) => {
        syncs.push({ productIds: [...productIds], operatorId: scope.operatorId });
        return true;
      },
      log: (level, event) => logs.push({ level, eventId: event.eventId }),
    });
  }
  /** Upload through the real route service, as `ProductsStockBulkUploadView.post`. */
  async function upload(
    type: 'PRODUCT_STOCK_CSV' | 'PRODUCT_STORE_CSV',
    csv: string,
    user: Principal = admin,
  ) {
    if (type === 'PRODUCT_STORE_CSV') {
      // The product-store upload route is deleted (legacy `core/urls.py:11`); job C1 still
      // processes an upload row that already exists, as the kept legacy Celery task does.
      const filename = await storage.save(
        `uploads/csv/Csv-${randomUUID()}.csv`,
        Buffer.from(csv, 'utf8'),
      );
      const id = String(
        generatedId(
          await db
            .get('writer')
            .insert(CsvUpload)
            .values({
              upload_type: 'PRODUCT_STORE_CSV',
              uploaded_by: BigInt(user.id),
              filename,
              is_imported: false,
              created_at: '2026-06-15 12:00:00',
              updated_at: '2026-06-15 12:00:00',
            }),
        ),
      );
      await ephemeral.set(importProgressKey(id), JSON.stringify(initialProgress()), {
        EX: importProgressTtlSeconds,
      });
      return {
        id,
        message: importMessages.uploaded,
        args: { upload_id: id, user_id: user.id, role_id: user.role },
      };
    }
    const service = inventoryImportService(config(), db, {
      csvStorage: storage,
      moduleRuntime: { jobs, ephemeral },
    });
    const result = await service.upload(user, { type, name: 'upload.csv', csv });
    const job = jobs.enqueued.at(-1)!;
    return { ...result, args: job.args };
  }
  async function uploadRow(id: string) {
    const [row] = await rows(
      'SELECT upload_type,uploaded_by,message,failed_data,is_imported,filename FROM pos_csv_upload WHERE id=?',
      [id],
    );
    return row!;
  }
  const admin: Principal = {
    id: '1',
    name: 'Admin',
    email: 'admin@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  };
  const manager: Principal = { ...admin, id: '2', role: 3, storeIds: ['1'] };

  beforeAll(async () => {
    const base = new URL(template!);
    if (!['localhost', '127.0.0.1'].includes(base.hostname))
      throw new Error('Inventory job tests require a loopback MySQL.');
    schema = `pos_rewrite_inventory_jobs_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    connection = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    // Production snapshot DDL (`tests/golden/schema/production-schema.json`), including
    // `product_store.uq_product_store`.
    await createProductionTables(connection, tables);
    db = createDatabases(config());
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
      await connection.end();
    }
  });
  beforeEach(async () => {
    for (const table of tables)
      await connection.query('DELETE FROM ' + mysql.escapeId(getTableConfig(table).name));
    ephemeral = memoryEphemeralStore();
    storage = memoryCsvUploadStorage();
    jobs = recordingJobProducer();
    procedureCalls.length = 0;
    syncs.length = 0;
    logs.length = 0;
    procedureFailure = false;
    for (const [id, active, type] of [
      [1, 1, 'STORE'],
      [2, 1, 'STORE'],
      [3, 0, 'STORE'],
    ] as const)
      await seed(Store, {
        id,
        store_name: `Store ${id}`,
        is_active: active,
        type,
        ecom_threshold: 5,
      });
    for (const [id, role] of [
      [1, 1],
      [2, 3],
    ] as const)
      await seed(PosUser, { id, username: `user${id}`, role, user_type: 1, is_active: true });
    await seed(UserStore, { django_user_id: 2, store_id: 1 });
    // 11 simple; 20 configurable parent with live variants 21, 22 (archived, no stock) and 23
    // (archived, stocked elsewhere).
    for (const [id, parent, type, deleted] of [
      [11, 0, 1, 0],
      [20, 0, 3, 0],
      [21, 20, 4, 0],
      [22, 20, 4, 1],
      [23, 20, 4, 1],
    ] as const)
      await seed(Product, {
        id,
        product: `Product ${id}`,
        parent_prod_id: parent,
        prod_type: type,
        is_del: deleted,
      });
  });

  it('uploads like the source view: stored file, pos_csv_upload row, cursor and core job', async () => {
    const result = await upload('PRODUCT_STOCK_CSV', stockHeader);
    expect(result.message).toBe('Csv Uploaded successfully. Data may take some time to reflect.');
    const row = await uploadRow(result.id);
    expect(row).toMatchObject({
      upload_type: 'PRODUCT_STOCK_CSV',
      uploaded_by: '1',
      message: null,
      failed_data: null,
      is_imported: 0,
    });
    expect(String(row.filename)).toMatch(/^uploads\/csv\/Csv-\d{4}_\d\d_\d\d-\d\d-\d\d-\d\d\.csv$/);
    expect(storage.files.get(String(row.filename))?.toString()).toBe(stockHeader);
    expect(jobs.enqueued.map(({ name, args, options }) => ({ name, args, options }))).toEqual([
      {
        name: 'core.tasks.parse_csv_product_stock',
        args: { upload_id: result.id, user_id: '1', role_id: 1 },
        options: { queue: 'core' },
      },
    ]);
    expect(JSON.parse((await ephemeral.get(importProgressKey(result.id)))!)).toMatchObject({
      record: 0,
    });
    await expect(
      upload('PRODUCT_STOCK_CSV', stockHeader, { ...admin, id: '5', userType: 2 }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('holds with IsHold=1 and unholds with IsHold=0 (approved divergence), with source logs, procedure calls and product sync', async () => {
    await seed(ProductStore, { product_id: 11, store_id: 1, stock: 10, is_avail: 1, is_del: 0 });
    const { id, args } = await upload(
      'PRODUCT_STOCK_CSV',
      stockHeader + '11,1,1,3,,1\n11,1,0,2,0,\n11,1,0,5,,\n',
      manager,
    );
    await handlers().productStock(args, context());
    // Hold 3 (10 -> 7), then unhold 2 back into store stock (7 -> 9) through the legacy
    // `inward_product_to_store` path; the flags use the association read before the record.
    expect(await rows('SELECT stock,is_avail,is_del FROM product_store')).toEqual([
      { stock: 9, is_avail: 0, is_del: 1 },
    ]);
    expect(await rows('SELECT product_id,store_id,stock FROM hold_stock_store')).toEqual([
      { product_id: '11', store_id: '1', stock: 1 },
    ]);
    expect(
      await rows(
        'SELECT stock_before,stock_after,pos_user_id,comment FROM pos_hold_stock_logs ORDER BY id',
      ),
    ).toEqual([
      {
        stock_before: '0',
        stock_after: '3',
        pos_user_id: '2',
        comment: 'Hold Stock inventory added into Hold Stock from admin panel .',
      },
      {
        stock_before: '3',
        stock_after: '1',
        pos_user_id: '2',
        comment: 'Hold Stock inventory reduced to add into Product inventory.',
      },
    ]);
    expect(procedureCalls).toEqual([
      {
        storeId: '1',
        productId: '11',
        stock: 7,
        operatorId: '2',
        comment: 'Product inventory added into hold stock.',
      },
      {
        storeId: '1',
        productId: '11',
        stock: 9,
        operatorId: '2',
        comment: 'Product inventory added from admin panel from Hold Stock',
      },
    ]);
    const upload_ = await uploadRow(id);
    expect(upload_).toMatchObject({
      is_imported: 1,
      message: 'Product Stock Data Updated Successfully.',
    });
    // Unholding more than is held fails the record with the legacy message (`task_helpers.py:278`).
    expect(JSON.parse(String(upload_.failed_data))).toEqual([
      {
        data: {
          SkuId: '11',
          StoreId: '1',
          IsHold: '0',
          'Hold/UnholdQty': '5',
          IsAvailable: '',
          IsDelete: '',
        },
        message: 'Stock not available to unhold.',
      },
    ]);
    expect(syncs).toEqual([
      { productIds: ['11'], operatorId: '2' },
      { productIds: ['11', '11'], operatorId: '2' },
    ]);
    expect(await ephemeral.get(importProgressKey(id))).toBeNull();
  });
  it('records source failure messages and keeps the partial writes the source commits', async () => {
    await seed(ProductStore, { product_id: 11, store_id: 1, stock: 1, is_avail: 1, is_del: 0 });
    await seed(ProductStore, { product_id: 99, store_id: 1, stock: 0, is_avail: 1, is_del: 0 });
    await seed(ProductStore, { product_id: 21, store_id: 1, stock: 0, is_avail: 1, is_del: 0 });
    await seed(ProductStore, { product_id: 20, store_id: 1, stock: 0, is_avail: 1, is_del: 0 });
    const { id, args } = await upload(
      'PRODUCT_STOCK_CSV',
      stockHeader +
        [
          '11,3,,,,', // inactive store
          '11,2,,,,', // not assigned to the role-3 uploader
          '0,1,,,,', // missing parameters
          'abc,1,,,,', // int() failure
          '11,1,1,5,0,', // too little stock: flags still change
          '11,1,1,5,x,', // too little stock, then int() failure: same dict twice
          '99,1,,,1,1', // association without a product: flags change, then AttributeError
          '21,1,,,0,1', // variant: parent follows
          '12,1,,,,', // no association: no change, still synced
        ].join('\n') +
        '\n',
      manager,
    );
    await handlers().productStock(args, context());
    const row = await uploadRow(id);
    const data = (values: string[]) =>
      Object.fromEntries(
        ['SkuId', 'StoreId', 'IsHold', 'Hold/UnholdQty', 'IsAvailable', 'IsDelete'].map(
          (key, i) => [key, values[i]],
        ),
      );
    const traversal = (values: string[], other: string) => ({
      data: data(values),
      message: importMessages.traversal,
      other_error: other,
    });
    expect(JSON.parse(String(row.failed_data))).toEqual([
      { data: data(['11', '3', '', '', '', '']), message: 'Not a valid store.' },
      { data: data(['11', '2', '', '', '', '']), message: 'Not a valid store for requested user.' },
      { data: data(['0', '1', '', '', '', '']), message: 'Required parameters are missing.' },
      traversal(['abc', '1', '', '', '', ''], "invalid literal for int() with base 10: 'abc'"),
      { data: data(['11', '1', '1', '5', '0', '']), message: 'Stock is not available to hold.' },
      traversal(['11', '1', '1', '5', 'x', ''], "invalid literal for int() with base 10: 'x'"),
      traversal(['11', '1', '1', '5', 'x', ''], "invalid literal for int() with base 10: 'x'"),
      traversal(
        ['99', '1', '', '', '1', '1'],
        "'NoneType' object has no attribute 'parent_prod_id'",
      ),
    ]);
    expect(String(row.failed_data)).toContain('{"data": {"SkuId": "11", "StoreId": "3"');
    expect(
      await rows('SELECT product_id,stock,is_avail,is_del FROM product_store ORDER BY product_id'),
    ).toEqual([
      { product_id: '11', stock: 1, is_avail: 0, is_del: 0 },
      { product_id: '20', stock: 0, is_avail: 0, is_del: 1 },
      { product_id: '21', stock: 0, is_avail: 0, is_del: 1 },
      { product_id: '99', stock: 0, is_avail: 1, is_del: 1 },
    ]);
    expect(procedureCalls).toEqual([]);
    expect(syncs).toEqual([{ productIds: ['21', '12'], operatorId: '2' }]);
  });

  it('resumes after the last committed record and closes an upload whose cursor is lost', async () => {
    await seed(ProductStore, { product_id: 11, store_id: 1, stock: 10, is_avail: 1, is_del: 0 });
    const first = await upload('PRODUCT_STOCK_CSV', stockHeader + '11,1,1,3,,\n11,1,1,4,,\n');
    await ephemeral.set(
      importProgressKey(first.id),
      JSON.stringify({ record: 1, failed: [], productIds: ['11'], inserts: [] }),
    );
    await handlers().productStock(first.args, context());
    expect(await rows('SELECT stock FROM product_store')).toEqual([{ stock: 6 }]);
    expect(syncs).toEqual([{ productIds: ['11', '11'], operatorId: '1' }]);
    // A finished upload is never re-applied.
    await handlers().productStock(first.args, context());
    expect(await rows('SELECT stock FROM product_store')).toEqual([{ stock: 6 }]);

    const second = await upload('PRODUCT_STOCK_CSV', stockHeader + '11,1,1,3,,\n');
    await ephemeral.del(importProgressKey(second.id));
    await handlers().productStock(second.args, context());
    expect(await uploadRow(second.id)).toMatchObject({
      is_imported: 1,
      message: importMessages.interrupted,
      failed_data: null,
    });
    expect(await rows('SELECT stock FROM product_store')).toEqual([{ stock: 6 }]);
    expect(logs.map((row) => row.eventId)).toContain('administration.inventory-import.interrupted');
  });

  it('ends the task unimported on a missing header, as the source row_dict KeyError', async () => {
    const { id, args } = await upload('PRODUCT_STOCK_CSV', '﻿' + stockHeader + '11,1,,,1,0\n');
    await expect(handlers().productStock(args, context())).rejects.toThrow();
    expect(await uploadRow(id)).toMatchObject({ is_imported: 0, message: null });
  });

  it('reassigns parent products and live variants to stores with source removal logs', async () => {
    for (const product of [20, 21, 23])
      await seed(ProductStore, {
        product_id: product,
        store_id: 2,
        stock: 4,
        is_avail: 1,
        is_del: 0,
      });
    await seed(ProductStore, { product_id: 11, store_id: 1, stock: 2, is_avail: 1, is_del: 0 });
    const { id, args } = await upload(
      'PRODUCT_STORE_CSV',
      'SkuId,StoreId,IsActive\n20,1,1\n11,1,0\n21,1,1\n20,3,1\n11,1,2\n',
    );
    await handlers().productStore(args, context());
    expect(
      await rows(
        'SELECT product_id,store_id,stock,is_avail,is_del FROM product_store ORDER BY store_id,product_id',
      ),
    ).toEqual([
      { product_id: '20', store_id: '1', stock: 0, is_avail: 1, is_del: 0 },
      { product_id: '21', store_id: '1', stock: 0, is_avail: 1, is_del: 0 },
      { product_id: '23', store_id: '1', stock: 0, is_avail: 1, is_del: 0 },
      { product_id: '20', store_id: '2', stock: 4, is_avail: 1, is_del: 0 },
      { product_id: '21', store_id: '2', stock: 4, is_avail: 1, is_del: 0 },
      { product_id: '23', store_id: '2', stock: 4, is_avail: 1, is_del: 0 },
    ]);
    // Only the existing association of simple product 11 was logged to zero before deletion.
    expect(procedureCalls).toEqual([
      {
        storeId: '1',
        productId: '11',
        stock: 0,
        operatorId: '1',
        comment: 'Product removed from store using bulk CSV upload.',
      },
    ]);
    const row = await uploadRow(id);
    expect(row.message).toBe('Product Store Data Updated Successfully.');
    expect(JSON.parse(String(row.failed_data))).toEqual([
      { data: { SkuId: '21', StoreId: '1', IsActive: '1' }, message: 'Not a parent product.' },
      { data: { SkuId: '20', StoreId: '3', IsActive: '1' }, message: 'Not a valid store.' },
      {
        data: { SkuId: '11', StoreId: '1', IsActive: '2' },
        message: 'Required parameters are missing.',
      },
    ]);
    expect(syncs).toEqual([{ productIds: ['20', '11'], operatorId: '1' }]);
  });

  it('stops procedure calls at the first failure and still applies the store change', async () => {
    procedureFailure = true;
    await seed(ProductStore, { product_id: 11, store_id: 1, stock: 2, is_avail: 1, is_del: 0 });
    const { id, args } = await upload('PRODUCT_STORE_CSV', 'SkuId,StoreId,IsActive\n11,1,0\n');
    await handlers().productStore(args, context());
    expect(await rows('SELECT * FROM product_store')).toEqual([]);
    expect(await uploadRow(id)).toMatchObject({ is_imported: 1, failed_data: '[]' });
    expect(logs.map((row) => row.eventId)).toContain(
      'administration.inventory-import.stock-procedure-failed',
    );
  });

  it('fails the bulk insert on a repeated active record like the source unique key', async () => {
    const { id, args } = await upload(
      'PRODUCT_STORE_CSV',
      'SkuId,StoreId,IsActive\n11,1,1\n11,1,1\n',
    );
    await expect(handlers().productStore(args, context())).rejects.toThrow();
    expect(await uploadRow(id)).toMatchObject({ is_imported: 0 });
    expect(await rows('SELECT * FROM product_store')).toEqual([]);
  });

  it('lists only readable inventory uploads and parses failed_data', async () => {
    const own = await upload('PRODUCT_STOCK_CSV', stockHeader + '0,1,,,,\n', manager);
    await handlers().productStock(own.args, context());
    await upload('PRODUCT_STORE_CSV', 'SkuId,StoreId,IsActive\n');
    const service = inventoryImportService(config(), db, {});
    expect((await service.list(admin, { limit: 30 })).data).toHaveLength(2);
    const mine = await service.list(manager, { limit: 30 });
    expect(mine.data.map((row) => row.id)).toEqual([own.id]);
    expect((await service.detail(manager, own.id)).failedData).toEqual([
      {
        data: {
          SkuId: '0',
          StoreId: '1',
          IsHold: '',
          'Hold/UnholdQty': '',
          IsAvailable: '',
          IsDelete: '',
        },
        message: 'Required parameters are missing.',
      },
    ]);
    const other = (await service.list(admin, { limit: 30, type: 'PRODUCT_STORE_CSV' })).data[0]!;
    await expect(service.detail(manager, other.id)).rejects.toMatchObject({ status: 404 });
  });

  it('syncs ecommerce stock above the store threshold, then requests the full sync (C10)', async () => {
    for (const [product, stock] of [
      [11, 3],
      [20, 5],
      [21, 6],
      [23, 10],
    ] as const)
      await seed(ProductStore, { product_id: product, store_id: 1, stock, is_avail: 1, is_del: 1 });
    const calls: string[] = [];
    let failing = false;
    const job = ecommerceInventoryJob({
      db,
      syncerBk: async (store, product, stock) => {
        calls.push(`${store}:${product}:${stock}`);
        if (failing) throw new Error('procedure missing');
      },
      fullSync: async () => {
        calls.push('syncproduct');
      },
      log: (level, event) => logs.push({ level, eventId: event.eventId }),
    });
    await job({ store_id: '1' }, context());
    expect(calls).toEqual(['1:21:6', '1:23:10', 'syncproduct']);
    calls.length = 0;
    await job({ store_id: '3' }, context());
    expect(calls).toEqual([]);
    failing = true;
    await job({ store_id: '1' }, context());
    expect(calls).toEqual(['1:21:6']);
    expect(
      logs.filter((row) => row.eventId === 'administration.ecommerce-inventory-sync.failed'),
    ).toHaveLength(2);
  });
});
