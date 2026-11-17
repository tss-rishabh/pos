import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { asc, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitMigration } from '../../src/db/migrations.js';
import { ProductStore } from '../../src/db/legacy-schema.js';
import { AppError } from '../../src/domain/errors.js';
import type { AdministrationTransaction } from '../../src/modules/administration/checkins.js';
import { importFinancialFixture, financialClock } from '../legacy-import-financial/fixture.js';
import {
  runtimeImportInput,
  runtimeImportSecret,
} from '../legacy-order-imports/runtime-fixture.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { financialAdapterProfiles } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { registerLegacyOrderImports } from '../../src/modules/legacy-order-imports/index.js';
import { readLegacyOrderImportOptions } from '../../src/modules/legacy-order-imports/options.js';
import {
  financialImportOperations,
  financialImportPreparations,
  financialImportProofs,
  financialImportStages,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import type { FinancialOrderPreparationPort } from '../../src/modules/legacy-order-imports/financial-adapter-preparation-contracts.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
type Prepared = Awaited<ReturnType<FinancialOrderPreparationPort['prepare']>>;
function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe.skipIf(!template)('native financial preparation adapter and job resources', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>, clock: number;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    for (const statement of splitMigration(
      readFileSync('src/modules/legacy-order-imports/preparation-migration.sql', 'utf8'),
    ))
      await f.connection.query(statement);
  }, 15000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await f.db.get('writer').delete(financialImportPreparations);
    await f.reset();
    clock = financialClock;
  });
  function create(prepare: FinancialOrderPreparationPort['prepare']) {
    const transport = f.transport(),
      options = { ...f.options, clock: () => clock },
      profiles = financialAdapterProfiles();
    const order = vi.spyOn(transport, 'order'),
      confirmation = vi.spyOn(transport, 'confirm'),
      publication = vi.spyOn(transport, 'publication');
    const adapter = legacyOrderImportFinancialAdapter(
      f.config,
      f.db,
      options,
      transport,
      profiles,
      { prepare },
    );
    return { adapter, transport, options, profiles, order, confirmation, publication };
  }
  const inputCsv = () => {
    const input = runtimeImportInput();
    input.csv = input.csv.replace('25.49', '25.00');
    return input;
  };
  function repository() {
    return legacyOrderImportRepository(f.db, { secret: runtimeImportSecret, now: () => clock });
  }
  function loseCommitAck(when: () => Promise<boolean>) {
    const writer = f.db.get('writer'),
      native = writer.transaction.bind(writer);
    let lost = false;
    const intercept = async <T>(
      work: (tx: AdministrationTransaction) => Promise<T>,
      options?: Parameters<typeof writer.transaction>[1],
    ): Promise<T> => {
      const value = await native(work, options);
      if (!lost && (await when())) {
        lost = true;
        throw new Error('isolated native commit acknowledgment lost');
      }
      return value;
    };
    vi.spyOn(writer, 'transaction').mockImplementation(intercept);
    return {
      db: {
        ...f.db,
        get: (name: Parameters<typeof f.db.get>[0]) =>
          name === 'writer' ? writer : f.db.get(name),
      },
      lost: () => lost,
    };
  }
  async function effects() {
    const [rows] = await f.connection.query(`SELECT
    (SELECT COUNT(*) FROM orders) AS order_count,
    (SELECT COUNT(*) FROM pos_transaction_logs) AS payment_count,
    (SELECT COUNT(*) FROM pos_rewrite_import_financial_stages) AS stages,
    (SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts) AS receipts,
    (SELECT SUM(stock) FROM product_store) AS stock`);
    return rows;
  }
  function api(adapter: ReturnType<typeof create>['adapter'], database = f.db) {
    const app = Fastify({ logger: false });
    app.decorateRequest('principal', null);
    app.decorateRequest('authSessionValid', null);
    app.addHook('preHandler', async (request) => {
      request.principal = {
        id: '1',
        role: 1,
        userType: 1,
        storeIds: [],
        name: 'Fixture',
        email: 'fixture@example.test',
      };
      request.authSessionValid = async () => true;
    });
    app.setErrorHandler((error, _request, reply) =>
      error instanceof AppError
        ? reply.code(error.status).send({ error: { code: error.code } })
        : reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } }),
    );
    const service = registerLegacyOrderImports(app, f.config, database, {
      adapter,
      canStart: true,
      runtime: readLegacyOrderImportOptions({
        LEGACY_ORDER_IMPORT_CONTRACT: 'pos-legacy-order-import-v1',
        LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: runtimeImportSecret,
        LEGACY_ORDER_IMPORT_WORKER_ENABLED: 'true',
        LEGACY_ORDER_IMPORT_WORKER_BATCH_SIZE: '1',
      }),
    });
    return { app, service };
  }
  it('prepares outside every SQL lock, then creates one order checkpoint and settles once', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        await f.connection.beginTransaction();
        try {
          await f.connection.query('SELECT id FROM stores WHERE id=1 FOR UPDATE NOWAIT');
          await f.connection.query('SELECT id FROM users WHERE id=77 FOR UPDATE NOWAIT');
          await f.connection.commit();
        } finally {
          await f.connection.rollback();
        }
        expect(await f.db.get('writer').select().from(financialImportStages)).toEqual([]);
        return {};
      }),
      c = create(prepare),
      input = f.input(),
      result = await c.adapter.start(input);
    expect(result.status).toBe('completed');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(c.order).toHaveBeenCalledTimes(1);
    expect(c.confirmation).toHaveBeenCalledTimes(1);
    expect(c.publication).toHaveBeenCalledTimes(1);
    expect(await c.adapter.read(input)).toEqual(result);
    expect(await c.adapter.start(input)).toEqual(result);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(
      (await f.db.get('writer').select().from(financialImportPreparations))[0]?.data.phase,
    ).toBe('DISPATCHED');
  });
  it('a local preparation failure produces a native no-dispatch closure, not a source uncertainty or fake source receipt', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        throw new Error('private preparation canary');
      }),
      c = create(prepare),
      input = f.input(),
      before = await effects();
    expect(await c.adapter.start(input)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect(await effects()).toEqual(before);
    expect(await c.adapter.read(input)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    await c.adapter.start(input);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(c.order).not.toHaveBeenCalled();
    expect(
      (await f.db.get('writer').select().from(financialImportPreparations))[0]?.data.closure,
    ).toMatchObject({ noFinancialEffects: true, code: 'ORDER_IMPORT_PREPARATION_FAILED' });
  });
  it('fences a late successful callback after GET sealed an expired owner and never resends it', async () => {
    const entered = latch<void>(),
      result = latch<Prepared>(),
      prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        entered.resolve();
        return result.promise;
      }),
      c = create(prepare),
      input = f.input(),
      work = c.adapter.start(input);
    void work.catch(() => undefined);
    await entered.promise;
    clock += 60001;
    expect(await c.adapter.read(input)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    result.resolve({});
    expect(await work).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect(c.order).not.toHaveBeenCalled();
    expect(await f.db.get('writer').select().from(financialImportStages)).toEqual([]);
  });
  it('explicit private resume appends an AUTHORIZED attempt, GET stays idle and the next start uses it once', async () => {
    let unavailable = true;
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        if (unavailable) throw new Error('isolated unavailable');
        return {};
      }),
      c = create(prepare),
      input = f.input();
    await c.adapter.start(input);
    unavailable = false;
    const journal = legacyImportFinancialJournal(f.config, f.db, c.options, c.profiles, true);
    await journal.transaction((tx) => c.adapter.preparation!.resume(tx, input, randomUUID()));
    expect(await c.adapter.read(input)).toMatchObject({ status: 'unknown', stage: 'preparation' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.db
          .get('writer')
          .select()
          .from(financialImportPreparations)
          .orderBy(asc(financialImportPreparations.sequence))
      ).map((row) => row.data.phase),
    ).toEqual(['CLOSED', 'AUTHORIZED']);
    expect((await c.adapter.start(input)).status).toBe('completed');
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(c.order).toHaveBeenCalledTimes(1);
  });
  it('rejects resume after original contact authority changes and still reads the original no-dispatch proof with transport disabled', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        throw new Error('isolated');
      }),
      c = create(prepare),
      input = f.input();
    await c.adapter.start(input);
    await f.connection.query("UPDATE users SET email='changed@example.test' WHERE id=77");
    const journal = legacyImportFinancialJournal(f.config, f.db, c.options, c.profiles, true);
    await expect(
      journal.transaction((tx) => c.adapter.preparation!.resume(tx, input, randomUUID())),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_AUTHORITY_CHANGED' });
    const reader = legacyOrderImportFinancialAdapter(
      f.config,
      f.db,
      { secret: c.options.secret, clock: () => clock },
      c.transport,
    );
    expect(await reader.read(input)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect(c.order).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('actual queue claim reserves operation and native owner atomically; successful ordinary dispatch is not double claimed', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => ({})),
      c = create(prepare),
      repo = repository(),
      csv = inputCsv();
    await repo.stage('1', 'preparation-native-queue', csv);
    expect(await repo.runOne(c.adapter)).toMatchObject({ state: 'IMPORTED' });
    expect(await repo.detail('1', csv.id)).toMatchObject({ state: 'COMPLETED', importedOrders: 1 });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(c.order).toHaveBeenCalledTimes(1);
    expect(
      (await f.db.get('writer').select().from(financialImportOperations))[0]?.state.requestId,
    ).toBe('preparation-native-queue');
  });
  it('process death after atomic queue claim closes the retained RESERVED attempt and pauses PENDING work without dispatch', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => ({})),
      c = create(prepare),
      repo = repository(),
      csv = inputCsv();
    await repo.stage('1', 'preparation-claim-loss', csv);
    await repo.runOne({
      ...c.adapter,
      start: async () => {
        throw new Error('isolated process death before start');
      },
    });
    expect(
      (await f.db.get('writer').select().from(financialImportPreparations))[0]?.data.phase,
    ).toBe('RESERVED');
    expect(prepare).not.toHaveBeenCalled();
    clock += 120001;
    expect(await repo.runOne(c.adapter, 'recovery')).toMatchObject({ state: 'BLOCKED' });
    expect(await repo.detail('1', csv.id)).toMatchObject({
      state: 'BLOCKED',
      errorCode: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
      failedOrders: 0,
    });
    expect((await repo.results('1', csv.id))[0]?.state).toBe('PENDING');
    expect(c.order).not.toHaveBeenCalled();
  });
  it('public job POST resume recovers exact receipts, does not renew on GET/replay and dispatches a new attempt once', async () => {
    let unavailable = true;
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        if (unavailable) throw new Error('isolated');
        return {};
      }),
      c = create(prepare),
      { app, service } = api(c.adapter),
      csv = inputCsv(),
      base = '/api/v1/admin/order-imports';
    try {
      expect((await app.inject({ method: 'POST', url: base, payload: csv })).statusCode).toBe(202);
      expect(await service.runOne()).toMatchObject({ state: 'BLOCKED' });
      const command = { operationId: randomUUID() },
        url = base + '/' + csv.id + '/resumptions';
      expect((await app.inject({ method: 'POST', url, payload: command })).statusCode).toBe(202);
      expect(
        (await app.inject({ method: 'GET', url: url + '/' + command.operationId })).statusCode,
      ).toBe(200);
      expect((await app.inject({ method: 'POST', url, payload: command })).statusCode).toBe(202);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(await f.db.get('writer').select().from(financialImportPreparations)).toHaveLength(2);
      unavailable = false;
      expect(await service.runOne()).toMatchObject({ state: 'IMPORTED' });
      expect(c.order).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('direct start cannot bypass the actual queue claim by omitting or forging a lease', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => ({})),
      c = create(prepare),
      repo = repository(),
      csv = inputCsv();
    await repo.stage('1', 'guarded-queue-fixture', csv);
    const [row] = await repo.results('1', csv.id),
      input = await repo.financialContext('1', csv.id, row!.operationId);
    await expect(c.adapter.start(input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    await expect(
      c.adapter.start(input, {
        kind: 'preparation',
        attemptId: randomUUID(),
        ownerToken: randomUUID(),
        queue: { jobId: csv.id, claimToken: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED' });
    expect(await f.db.get('writer').select().from(financialImportOperations)).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(c.order).not.toHaveBeenCalled();
  });
  it('recovers a committed atomic claim after its ACK is lost without invoking preparation or another financial stage', async () => {
    const c = create(vi.fn(async () => ({}))),
      csv = inputCsv(),
      repo = repository();
    await repo.stage('1', 'native-claim-ack-loss', csv);
    const native = loseCommitAck(
        async () =>
          (await f.db.get('writer').select().from(financialImportPreparations))[0]?.data.phase ===
          'RESERVED',
      ),
      adapter = legacyOrderImportFinancialAdapter(
        f.config,
        native.db,
        c.options,
        c.transport,
        c.profiles,
        { prepare: async () => ({}) },
      ),
      tracked = legacyOrderImportRepository(native.db, {
        secret: runtimeImportSecret,
        now: () => clock,
      });
    await expect(tracked.runOne(adapter)).rejects.toThrow(
      'isolated native commit acknowledgment lost',
    );
    expect(native.lost()).toBe(true);
    expect((await repo.results('1', csv.id))[0]?.state).toBe('STARTING');
    expect(await tracked.runOne(adapter)).toBeNull();
    clock += 120001;
    expect(await tracked.runOne(adapter, 'recovery')).toMatchObject({ state: 'BLOCKED' });
    expect(c.order).not.toHaveBeenCalled();
    expect(await f.db.get('writer').select().from(financialImportStages)).toEqual([]);
  });
  it('reads a committed no-dispatch closure after its ACK is lost without inventing a source rejection', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        throw new Error('isolated local unavailable');
      }),
      c = create(prepare),
      input = f.input(),
      native = loseCommitAck(
        async () =>
          (await f.db.get('writer').select().from(financialImportPreparations))[0]?.data.phase ===
          'CLOSED',
      ),
      adapter = legacyOrderImportFinancialAdapter(
        f.config,
        native.db,
        c.options,
        c.transport,
        c.profiles,
        { prepare },
      );
    await expect(adapter.start(input)).rejects.toThrow(
      'isolated native commit acknowledgment lost',
    );
    expect(native.lost()).toBe(true);
    expect(await adapter.read(input)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect(await adapter.start(input)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(c.order).not.toHaveBeenCalled();
    expect(await f.db.get('writer').select().from(financialImportStages)).toEqual([]);
  });
  it('freezes a committed dispatch checkpoint after its ACK is lost and never resends or closes it as no-effects', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => ({})),
      c = create(prepare),
      input = f.input(),
      native = loseCommitAck(
        async () =>
          (await f.db.get('writer').select().from(financialImportPreparations))[0]?.data.phase ===
          'DISPATCHED',
      ),
      adapter = legacyOrderImportFinancialAdapter(
        f.config,
        native.db,
        c.options,
        c.transport,
        c.profiles,
        { prepare },
      );
    expect(await adapter.start(input)).toMatchObject({ status: 'unknown', stage: 'order' });
    expect(native.lost()).toBe(true);
    clock += 120001;
    expect(await adapter.read(input)).toMatchObject({ status: 'unknown', stage: 'order' });
    expect(await adapter.start(input)).toMatchObject({ status: 'unknown', stage: 'order' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(c.order).not.toHaveBeenCalled();
    expect(await f.db.get('writer').select().from(financialImportStages)).toHaveLength(1);
    expect(
      (await f.db.get('writer').select().from(financialImportPreparations))[0]?.data,
    ).toMatchObject({ phase: 'DISPATCHED', closure: null });
  });
  it('rechecks native actor authority after async preparation and closes only the unstarted attempt', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
        return {};
      }),
      c = create(prepare),
      input = f.input();
    expect(await c.adapter.start(input)).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
    });
    expect(c.order).not.toHaveBeenCalled();
    expect(await f.db.get('writer').select().from(financialImportStages)).toEqual([]);
  });
  it('rolls back queue claim, native operation and profile writes together on a late reservation failure', async () => {
    let deny = true;
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => ({})),
      c = create(prepare),
      repo = repository(),
      csv = inputCsv(),
      profiles = financialAdapterProfiles({
        extensions: [
          {
            async reserved(tx) {
              await tx.update(ProductStore).set({ stock: 99 }).where(eq(ProductStore.id, 1n));
              if (deny) throw new Error('isolated native reservation rollback');
              await tx.update(ProductStore).set({ stock: 100 }).where(eq(ProductStore.id, 1n));
            },
          },
        ],
      }),
      adapter = legacyOrderImportFinancialAdapter(
        f.config,
        f.db,
        c.options,
        c.transport,
        profiles,
        { prepare },
      );
    await repo.stage('1', 'native-reservation-rollback', csv);
    await expect(repo.runOne(adapter)).rejects.toThrow('isolated native reservation rollback');
    expect(await repo.detail('1', csv.id)).toMatchObject({ state: 'QUEUED' });
    expect((await repo.results('1', csv.id))[0]?.state).toBe('PENDING');
    expect(await f.db.get('writer').select().from(financialImportOperations)).toEqual([]);
    expect(await f.db.get('writer').select().from(financialImportPreparations)).toEqual([]);
    expect((await f.db.get('writer').select().from(ProductStore))[0]?.stock).toBe(100);
    expect(prepare).not.toHaveBeenCalled();
    deny = false;
    expect(await repo.runOne(adapter)).toMatchObject({ state: 'IMPORTED' });
    expect(c.order).toHaveBeenCalledTimes(1);
  });
  it('GET recovers a committed resumption after a lost reply and exact POST replay never allocates another attempt', async () => {
    let unavailable = true;
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        if (unavailable) throw new Error('isolated preparation unavailable');
        return {};
      }),
      c = create(prepare),
      repo = repository(),
      csv = inputCsv();
    await repo.stage('1', 'native-resume-ack-loss', csv);
    await repo.runOne(c.adapter);
    const native = loseCommitAck(async () =>
        (await f.db.get('writer').select().from(financialImportPreparations)).some(
          (row) => row.data.phase === 'AUTHORIZED',
        ),
      ),
      adapter = legacyOrderImportFinancialAdapter(
        f.config,
        native.db,
        c.options,
        c.transport,
        c.profiles,
        { prepare },
      ),
      { app, service } = api(adapter, native.db),
      command = { operationId: randomUUID() },
      url = '/api/v1/admin/order-imports/' + csv.id + '/resumptions';
    try {
      expect((await app.inject({ method: 'POST', url, payload: command })).statusCode).toBe(500);
      expect(native.lost()).toBe(true);
      const receipt = await app.inject({ method: 'GET', url: url + '/' + command.operationId });
      expect(receipt.statusCode).toBe(200);
      const retry = await app.inject({ method: 'POST', url, payload: command });
      expect(retry.statusCode).toBe(202);
      expect(retry.json<unknown>()).toEqual(receipt.json<unknown>());
      expect(await f.db.get('writer').select().from(financialImportPreparations)).toHaveLength(2);
      expect(prepare).toHaveBeenCalledTimes(1);
      unavailable = false;
      expect(await service.runOne()).toMatchObject({ state: 'IMPORTED' });
      expect(c.order).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('can explicitly cancel an authorized but unclaimed preparation after its optional producer is disabled', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => {
        throw new Error('isolated');
      }),
      c = create(prepare),
      repo = repository(),
      csv = inputCsv();
    await repo.stage('1', 'native-disabled-cancellation', csv);
    await repo.runOne(c.adapter);
    await repo.resume('1', csv.id, randomUUID(), 'native-authorize-resume', c.adapter);
    const reader = legacyOrderImportFinancialAdapter(
      f.config,
      f.db,
      { secret: c.options.secret, clock: () => clock },
      c.transport,
    );
    expect(reader.preparation).toBeUndefined();
    expect(await repo.cancel('1', csv.id, reader)).toMatchObject({
      state: 'CANCELLED',
      cancelledOrders: 1,
    });
    expect((await repo.results('1', csv.id))[0]?.state).toBe('CANCELLED');
    expect(c.order).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await f.db.get('writer').select().from(financialImportStages)).toEqual([]);
  });
  it('recovers a committed completed seal after a lost ACK and preparation/source disablement without mutable customer or artifact gates', async () => {
    const prepare = vi.fn<FinancialOrderPreparationPort['prepare']>(async () => ({})),
      c = create(prepare),
      input = f.input(),
      native = loseCommitAck(async () => {
        if (!(await f.db.get('writer').select().from(financialImportProofs)).length) return false;
        c.options.sourceProofKey = '';
        c.options.contract = undefined;
        await f.connection.query(
          "UPDATE users SET email='changed@example.test',is_block=1 WHERE id=77",
        );
        return true;
      }),
      adapter = legacyOrderImportFinancialAdapter(
        f.config,
        native.db,
        c.options,
        c.transport,
        c.profiles,
        { prepare },
      );
    const receipt = await adapter.start(input);
    expect(native.lost()).toBe(true);
    expect(receipt.status).toBe('completed');
    // The completed financial seal, not a mutable preparation/control row,
    // retains the original committed money and native identity ownership.
    await f.connection.query(
      "UPDATE pos_rewrite_import_financial_preparations SET artifact='changed' ",
    );
    const reader = legacyOrderImportFinancialAdapter(
      f.config,
      native.db,
      { secret: c.options.secret, clock: () => clock },
      c.transport,
    );
    expect(await reader.read(input)).toEqual(receipt);
    expect(await reader.start(input)).toEqual(receipt);
    expect(c.order).toHaveBeenCalledTimes(1);
    expect(c.confirmation).toHaveBeenCalledTimes(1);
    expect(c.publication).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
