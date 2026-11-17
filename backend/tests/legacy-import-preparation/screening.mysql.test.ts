import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductBarcode } from '../../src/db/legacy-schema.js';
import { splitMigration } from '../../src/db/migrations.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { financialAdapterProfiles } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import {
  financialImportPreparations,
  financialImportStages,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import type { FinancialOrderPreparationPort } from '../../src/modules/legacy-order-imports/financial-adapter-preparation-contracts.js';
import {
  screeningImportProfile,
  screeningProfileContract,
  screeningSchemaContract,
  screeningWriterContract,
  screeningReservationDdl,
  screeningReservations,
} from '../../src/modules/legacy-order-imports/screening-profile.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  financialClock,
  financialPlan,
  importFinancialFixture,
  sourceKey,
} from '../legacy-import-financial/fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
type Prepared = Awaited<ReturnType<FinancialOrderPreparationPort['prepare']>>;
describe.skipIf(!template)('screening quota across native no-dispatch preparation', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>, clock: number;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    await verifiedMysqlFixture(f.connection, ['evidence/mysql-screening-schema.json']).create([
      'spiderman_screening_orders',
    ]);
    await f.fixture.create([getTableName(ProductBarcode)]);
    await f.connection.query('CREATE INDEX idx_user_id ON spiderman_screening_orders(user_id)');
    await f.connection.query(screeningReservationDdl);
    for (const statement of splitMigration(
      readFileSync('src/modules/legacy-order-imports/preparation-migration.sql', 'utf8'),
    ))
      await f.connection.query(statement);
  }, 15000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.connection.query('DELETE FROM pos_rewrite_import_financial_preparations');
    await f.connection.query('DELETE FROM pos_rewrite_import_screening_reservations');
    await f.connection.query('DELETE FROM spiderman_screening_orders');
    await f.connection.query('DELETE FROM products_gs1');
    await f.reset();
    clock = financialClock;
    await f.fixture.insert('products', {
      id: '390238',
      price: 25,
      spl_price: 0,
      cog: 0,
      parent_prod_id: 0,
      prod_type: 1,
    });
    await f.fixture.insert('product_store', {
      id: '2',
      product_id: '390238',
      store_id: '1',
      stock: 100,
      is_avail: 1,
      is_del: 0,
    });
    await f.fixture.insert('products_gs1', {
      id: '1',
      product_id: '390238',
      gtin: '8900000000001',
    });
  });
  function setup(
    prepare: FinancialOrderPreparationPort['prepare'],
    qualified = true,
    key = sourceKey,
  ) {
    const options = { ...f.options, clock: () => clock },
      profile = screeningImportProfile(f.config, f.db, {
        financialSecret: options.secret,
        proofKey: key,
        clock: () => clock,
        ...(qualified
          ? {
              contract: screeningProfileContract,
              schemaContract: screeningSchemaContract,
              writerContract: screeningWriterContract,
            }
          : {}),
      }),
      profiles = financialAdapterProfiles({ screening: { profile, lineItemsEnabled: false } }),
      transport = f.transport(),
      order = vi
        .spyOn(transport, 'order')
        .mockRejectedValue(new Error('isolated source unavailable')),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, options, transport, profiles, {
        prepare,
      }),
      journal = legacyImportFinancialJournal(f.config, f.db, options, profiles, true);
    return { adapter, profile, profiles, transport, order, journal, options };
  }
  function input() {
    const plan = financialPlan();
    plan.lines = [{ productId: '390238', quantity: 2, unitPrice: '25.00', sourceRows: [2] }];
    return f.input(plan);
  }
  async function reservation() {
    return (await f.db.get('writer').select().from(screeningReservations))[0]!.data;
  }
  it('releases only proved never-dispatched quota; explicit authorization re-reserves only on the next actual claim', async () => {
    let fail = true;
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        expect((await reservation()).phase).toBe('RESERVED');
        if (fail) throw new Error('isolated local read failure');
        return {};
      }),
      c = setup(prepare),
      request = input();
    expect(await c.adapter.start(request)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect(await reservation()).toMatchObject({ phase: 'REJECTED', version: 2, orderId: null });
    expect(await f.db.get('writer').select().from(financialImportStages)).toEqual([]);
    await c.journal.transaction((tx) => c.adapter.preparation!.resume(tx, request, randomUUID()));
    expect((await reservation()).phase).toBe('REJECTED');
    expect(await c.adapter.read(request)).toMatchObject({
      status: 'unknown',
      stage: 'preparation',
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    fail = false;
    expect(await c.adapter.start(request)).toMatchObject({ status: 'unknown' });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(c.order).toHaveBeenCalledTimes(1);
    expect(await reservation()).toMatchObject({ phase: 'RESERVED', version: 3 });
    expect(
      (await f.db.get('writer').select().from(financialImportPreparations))
        .map((row) => row.data.phase)
        .sort(),
    ).toEqual(['CLOSED', 'DISPATCHED']);
    clock += 120001;
    await c.adapter.read(request);
    expect((await reservation()).phase).toBe('RESERVED');
    expect(c.order).toHaveBeenCalledTimes(1);
  });
  it('retains quota on missing retained key, then permits proof-only cleanup without source flags or a fresh preparation', async () => {
    let enter!: () => void, finish!: (value: Prepared) => void;
    const entered = new Promise<void>((yes) => {
        enter = yes;
      }),
      waiting = new Promise<Prepared>((yes) => {
        finish = yes;
      }),
      prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        enter();
        return waiting;
      }),
      c = setup(prepare),
      request = input(),
      running = c.adapter.start(request);
    void running.catch(() => undefined);
    await entered;
    clock += 60001;
    const blocked = setup(prepare, false, '');
    expect(await blocked.adapter.read(request)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RELEASE_REQUIRED',
    });
    expect((await reservation()).phase).toBe('RESERVED');
    const cleanup = setup(prepare, false),
      retained = legacyOrderImportFinancialAdapter(
        f.config,
        f.db,
        { secret: cleanup.options.secret, clock: () => clock },
        cleanup.transport,
        cleanup.profiles,
      );
    expect(retained.preparation).toBeUndefined();
    expect(await retained.read(request)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect((await reservation()).phase).toBe('REJECTED');
    finish({});
    expect(await running).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect(c.order).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('never frees or rearms quota around an order checkpoint, even after a lost response and disabled flags', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => ({})),
      c = setup(prepare),
      request = input();
    expect(await c.adapter.start(request)).toMatchObject({ status: 'unknown', stage: 'order' });
    expect((await reservation()).phase).toBe('RESERVED');
    clock += 120001;
    const reader = setup(prepare, false);
    await expect(reader.adapter.read(request)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_SCREENING_UNQUALIFIED',
    });
    await expect(
      c.journal.transaction((tx) => c.adapter.preparation!.resume(tx, request, randomUUID())),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED' });
    expect((await reservation()).phase).toBe('RESERVED');
    expect(c.order).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('retains and advances a no-quota denial proof when catalog re-admission fails, then permits an explicitly repaired resume', async () => {
    let fail = true;
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        if (fail) throw new Error('isolated local preparation unavailable');
        return {};
      }),
      c = setup(prepare),
      request = input();
    await c.adapter.start(request);
    const first = (await reservation()).rejectionHash;
    await c.journal.transaction((tx) => c.adapter.preparation!.resume(tx, request, randomUUID()));
    await f.connection.query('UPDATE product_store SET is_del=1 WHERE product_id=390238');
    expect(await c.adapter.start(request)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await reservation()).rejectionHash).not.toBe(first);
    expect((await reservation()).phase).toBe('REJECTED');
    await f.connection.query('UPDATE product_store SET is_del=0 WHERE product_id=390238');
    await c.journal.transaction((tx) => c.adapter.preparation!.resume(tx, request, randomUUID()));
    fail = false;
    expect(await c.adapter.start(request)).toMatchObject({ status: 'unknown', stage: 'order' });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(c.order).toHaveBeenCalledTimes(1);
    expect((await reservation()).phase).toBe('RESERVED');
  });
});
