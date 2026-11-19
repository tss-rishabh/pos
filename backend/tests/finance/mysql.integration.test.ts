import mysql from 'mysql2/promise';
import { and, eq, sql } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  StoreDayClose,
  StoreDayBanking,
  StoreCashOpeningBalance,
} from '../../src/db/legacy-schema.js';
import { collectionSnapshot, financeService } from '../../src/modules/finance/service.js';
import { closeEntriesSchema, money } from '../../src/modules/finance/domain.js';
import type { Principal } from '../../src/domain/access.js';
import {
  cashLedgerService,
  ledgerOptions,
  cashLedgerCorrectionBaselineHash,
} from '../../src/modules/finance/ledger.js';
import {
  sealPaymentCorrectionPartition,
  paymentCorrectionPublicationContract,
} from '../../src/modules/finance/payment-correction-publication.js';
import { financePendingAlerts } from '../../src/modules/finance/alerts.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import { closeHistoryService, dayCloseCsv } from '../../src/modules/finance/history.js';
import { createProductionTables } from '../helpers/production-schema.js';

const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('finance transactions on isolated local MySQL', () => {
  const schema = `pos_rewrite_finance_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let database: Databases | undefined,
    admin: mysql.Connection | undefined,
    created = false;
  const user: Principal = {
    id: '900001',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1'],
  };
  const clock = () => Temporal.Instant.from('2026-11-16T17:30:00Z');
  function resources() {
    if (!database) throw new Error('Fixture not initialized');
    return database;
  }
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Finance integration fixtures require a local MySQL host.');
    admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await admin.changeUser({ database: schema });
    await createProductionTables(admin, [
      'stores',
      'pos_user',
      'orders',
      'order_stores',
      'amount_to_be_refunded_log',
      'return_orders',
      StoreDayClose,
      StoreDayBanking,
      StoreCashOpeningBalance,
    ]);
    await admin.query(
      "INSERT INTO stores(id,store_name,is_active,type,category,phone) VALUES(1,'Fixture store',1,'STORE','IN_HOUSE','9000000001')",
    );
    await admin.query(
      "INSERT INTO pos_user(id,username,role,is_active,user_type) VALUES(900001,'fixture-operator',4,1,1)",
    );
    await admin.query(
      "INSERT INTO orders(id,created_at) VALUES(1,'2026-11-16 10:00:00'),(2,'2026-11-16 11:00:00'),(3,'2026-11-16 12:00:00'),(4,'2026-11-15 23:59:59')",
    );
    await admin.query(
      "INSERT INTO order_stores(id,order_id,store_id,counter_id,offline_payment,online_payment,online_other_payment,district_transaction_id) VALUES(1,1,1,7,100,20,30,'DISTRICT'),(2,2,1,7,0,5,10,''),(3,3,1,7,0,0,0,''),(4,4,1,7,999,999,999,'')",
    );
    // Production refunded_amt is FLOAT; 5.004 rounds to 5.00 there (5.005 would round up).
    await admin.query(
      "INSERT INTO amount_to_be_refunded_log(id,order_id,has_product_id,refund_mode,is_refunded,refunded_amt) VALUES(1,1,501,'cash',1,5.004),(2,1,502,'card',1,10),(3,1,503,'cash',0,20)",
    );
    await admin.query(
      "INSERT INTO return_orders(id,order_id,has_product_id,store_id,created_at) VALUES(1,1,501,1,'2026-11-16 10:05:00'),(2,1,501,1,'2026-11-16 10:06:00')",
    );
    await admin.query(
      "INSERT INTO store_cash_opening_balance(store_id,balance_date,amount,created_at,updated_at) VALUES(1,'2026-11-16',50,'2026-11-16 10:00:00','2026-11-16 10:00:00')",
    );
    url.pathname = '/' + schema;
    database = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'finance-mysql-fixture-secret-'.repeat(2),
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_WRITER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  });
  afterAll(async () => {
    await database?.close();
    if (admin && created) {
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await admin?.end();
  });
  it('matches the original collection and cash-refund SQL, including duplicate-return EXISTS semantics', async () => {
    const snapshot = await collectionSnapshot(resources().get('writer'), '1', '2026-11-16');
    expect(snapshot).toEqual({
      order_count: 2,
      cash: '100.00',
      cash_refund: '5.00',
      card_upi: '25.00',
      district: '30.00',
      online_other: '10.00',
      total_online: '35.00',
    });
  });
  it('deduplicates concurrent submissions and persists close/banking in one transaction', async () => {
    const service = financeService(
      readConfig({
        NODE_ENV: 'test',
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'finance-fixture-'.repeat(3),
      }),
      resources(),
      clock,
      { assertCheckIn: async () => {} },
    );
    const entries = closeEntriesSchema.parse({
        cash_actual: '95.00',
        cash_manual_punched: '0',
        cash_manual_created: '0',
        card_actual: '35.00',
        card_manual_punched: '0',
        card_manual_created: '0',
        banking_amount: '40.00',
      }),
      commandId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.close(user, '1', '2026-11-16', commandId, 0, entries),
      ),
    );
    expect(results.every((row) => row?.version === 1)).toBe(true);
    expect(await resources().get('writer').select().from(StoreDayClose)).toHaveLength(1);
    const [banking] = await resources().get('writer').select().from(StoreDayBanking);
    expect(banking?.amount).toBe('40.00');
    await expect(
      service.close(user, '1', '2026-11-16', crypto.randomUUID(), 0, entries),
    ).rejects.toMatchObject({ code: 'DAY_CLOSE_VERSION_CONFLICT' });
    expect(await resources().get('writer').select().from(StoreDayClose)).toHaveLength(1);
  });
  it('requires a complete warehouse ledger for current returns and preserves original banking/refund totals', async () => {
    const cfg = readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      SESSION_SECRET: 'cash-ledger-fixture-'.repeat(3),
    });
    await expect(
      cashLedgerService(cfg, resources(), ledgerOptions({}), undefined, clock).read(
        user,
        ['1'],
        '2026-11-16',
        '2026-11-16',
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    // Independently capture the original native facts in this disposable fixture.
    // No report-service helper computes the warehouse payload or its amounts.
    const [nativeClose] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT * FROM store_day_close WHERE store_id=1 AND close_date=?',
      ['2026-11-16'],
    );
    const [nativeCash] = await admin!.query<mysql.RowDataPacket[]>(
      "SELECT SUM(os.offline_payment) AS cash FROM order_stores os JOIN orders o ON o.id=os.order_id WHERE os.store_id=1 AND o.created_at>='2026-11-16 00:00:00' AND o.created_at<'2026-11-17 00:00:00' AND (os.offline_payment+os.online_payment+os.online_other_payment)>0",
    );
    const [nativeRefund] = await admin!.query<mysql.RowDataPacket[]>(
      "SELECT SUM(a.refunded_amt) AS cashRefund FROM amount_to_be_refunded_log a WHERE a.refund_mode='cash' AND a.is_refunded=1 AND EXISTS(SELECT 1 FROM return_orders r WHERE r.store_id=1 AND r.order_id=a.order_id AND r.has_product_id=a.has_product_id AND r.created_at>='2026-11-16 00:00:00' AND r.created_at<'2026-11-17 00:00:00')",
    );
    const anchors = [{ storeId: '1', date: '2026-11-16', amount: '50.00' }],
      closes = nativeClose.map((row) => ({
        storeId: '1',
        date: '2026-11-16',
        version: Number(row.version),
        status: String(row.status),
        cashSystem: money(String(row.cash_system)),
        cashRefund: money(String(row.cash_refund_system)),
        cashPunched: money(String(row.cash_manual_punched)),
        cashCreated: money(String(row.cash_manual_created)),
        cashActual: money(String(row.cash_actual)),
        cashDifference: money(String(row.cash_difference)),
        banking: money(String(row.banking_amount)),
      })),
      banks = [{ storeId: '1', date: '2026-11-16', amount: '40.00' }],
      sales = [
        {
          storeId: '1',
          date: '2026-11-16',
          cash: money(String(nativeCash[0]!.cash)),
          cashRefund: money(String(nativeRefund[0]!.cashRefund)),
        },
      ],
      proofKey = 'fixture-current-ledger-publication-'.repeat(2),
      partition = sealPaymentCorrectionPartition(
        {
          contract: paymentCorrectionPublicationContract,
          kind: 'cash-ledger',
          generationId: 'current_ledger_fixture',
          sourcePosition: 'mysql-bin.fixture:42',
          cdcWatermark: '2026-11-16T17:29:30Z',
          publishedAt: '2026-11-16T17:29:50Z',
          businessTimezone: 'Asia/Kolkata',
          storeId: '1',
          businessDate: '2026-11-16',
          payload: {
            baselineHash: cashLedgerCorrectionBaselineHash(
              '1',
              '2026-11-16',
              anchors,
              closes,
              banks,
              sales,
            ),
            cashAdjustment: '0.00',
            cashOut: '0.00',
          },
        },
        proofKey,
      ),
      service = cashLedgerService(
        cfg,
        resources(),
        ledgerOptions({
          BQ_FINANCE_OPENING_BALANCES: 'fixture-project.finance.anchors',
          BQ_FINANCE_DAY_CLOSES: 'fixture-project.finance.closes',
          BQ_FINANCE_DAY_BANKING: 'fixture-project.finance.banking',
          BQ_FINANCE_CASH_COLLECTIONS: 'fixture-project.finance.collections',
          BQ_FINANCE_CASH_COLLECTIONS_OFFLINE_CONTRACT: 'pos-cash-collections-v2',
        }),
        {
          async queryReport(statement) {
            if (statement.includes('finance.payment_publications'))
              return statement.includes('GROUP BY generation_id')
                ? [{ generationId: 'current_ledger_fixture' }]
                : [partition];
            if (statement.includes('finance.anchors')) return anchors;
            if (statement.includes('finance.closes')) return closes;
            if (statement.includes('finance.banking')) return banks;
            return sales.map((row) => ({
              ...row,
              cashProjectionContract: 'pos-cash-collections-v2',
            }));
          },
        },
        clock,
        { proofKey, publicationTable: 'fixture-project.finance.payment_publications' },
      );
    const result = await service.read(user, ['1'], '2026-11-16', '2026-11-16');
    expect(result.reader).toBe('bigquery');
    expect(result.data).toEqual([
      {
        store_id: '1',
        store_name: 'Fixture store',
        date: '2026-11-16',
        opening_cash: '50.00',
        sales_cash: '95.00',
        running_total: '145.00',
        actual_cash: '95.00',
        difference: '0.00',
        banking_amount: '40.00',
        closing_balance: '105.00',
        status: 'CLOSED',
        note: '',
      },
    ]);
  });
  it('refuses a return arriving after DATA routing before any historical refund fact is read', async () => {
    const [originalReturns] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT * FROM return_orders',
    );
    await admin!.query('DELETE FROM return_orders');
    let entered = false;
    const data = resources().get('data'),
      routed: Databases = {
        get(role) {
          if (role !== 'data') return resources().get(role);
          return new Proxy(data, {
            get(target, property, receiver) {
              if (property === 'transaction')
                return async (
                  work: Parameters<typeof data.transaction>[0],
                  options: Parameters<typeof data.transaction>[1],
                ) => {
                  entered = true;
                  await admin!.query(
                    "INSERT INTO return_orders(id,order_id,has_product_id,store_id,created_at) VALUES(9900,1,501,1,'2026-11-16 14:00:00')",
                  );
                  return target.transaction(async (tx) => {
                    const [rows] = await tx.execute(
                      sql`SELECT @@transaction_isolation AS isolation_level`,
                    );
                    expect(
                      z.array(z.object({ isolation_level: z.string() })).parse(rows)[0]!
                        .isolation_level,
                    ).toBe('REPEATABLE-READ');
                    return work(tx);
                  }, options);
                };
              return Reflect.get(target, property, receiver);
            },
          });
        },
        close: async () => {},
      };
    try {
      await expect(
        cashLedgerService(
          readConfig({
            NODE_ENV: 'test',
            MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
            SESSION_SECRET: 'current-return-race-fixture-'.repeat(3),
          }),
          routed,
          ledgerOptions({}),
          undefined,
          clock,
        ).read(user, ['1'], '2026-11-16', '2026-11-16'),
      ).rejects.toMatchObject({ code: 'LEDGER_HISTORY_REQUIRED' });
      expect(entered).toBe(true);
    } finally {
      await admin!.query('DELETE FROM return_orders');
      for (const row of originalReturns)
        await admin!.query(
          'INSERT INTO return_orders(id,order_id,has_product_id,store_id,created_at) VALUES(?,?,?,?,?)',
          [row.id, row.order_id, row.has_product_id, row.store_id, row.created_at],
        );
    }
  });
  it('rejects a forged difference and marks a closed snapshot stale after real collection drift', async () => {
    const service = financeService(
      readConfig({
        NODE_ENV: 'test',
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'finance-fixture-'.repeat(3),
      }),
      resources(),
      clock,
      { assertCheckIn: async () => {} },
    );
    await admin!.query('UPDATE order_stores SET offline_payment=101 WHERE id=1');
    const state = await service.state(user, '1', '2026-11-16');
    expect(state.close?.status).toBe('STALE');
    expect(state.system.cash).toBe('101.00');
    const [close] = await resources()
      .get('writer')
      .select()
      .from(StoreDayClose)
      .where(and(eq(StoreDayClose.store_id, 1), eq(StoreDayClose.version, 1)));
    expect(close?.stale_reason).toBe('DRIFT');
    expect(closeEntriesSchema.safeParse({ cash_actual: '96', cash_difference: '0' }).success).toBe(
      false,
    );
  });
  it('the actual historical ledger conserves three-date funding/outflow/re-payment and rejects a missing zero/source partition', async () => {
    const dates = ['2026-11-13', '2026-11-14', '2026-11-15'],
      proofKey = 'fixture-corrected-history-financial-key-'.repeat(2),
      anchors = [{ storeId: '1', date: dates[0]!, amount: '50.00' }],
      closes = dates.slice(0, 2).map((date, index) => ({
        storeId: '1',
        date,
        version: 1,
        status: 'CLOSED',
        cashSystem: index === 0 ? '100.00' : '0.00',
        cashRefund: index === 0 ? '0.00' : '100.00',
        cashPunched: '0.00',
        cashCreated: '0.00',
        cashActual: index === 0 ? '100.00' : '0.00',
        cashDifference: '0.00',
        banking: '0.00',
      })),
      sales = [
        {
          storeId: '1',
          date: dates[0]!,
          cash: '100.00',
          cashRefund: '0.00',
        },
      ],
      partitions = dates.map((date, index) =>
        sealPaymentCorrectionPartition(
          {
            contract: paymentCorrectionPublicationContract,
            kind: 'cash-ledger',
            generationId: 'fixture_cash_conservation',
            sourcePosition: 'mysql-bin.42:123',
            cdcWatermark: '2026-11-16T17:29:30Z',
            publishedAt: '2026-11-16T17:29:50Z',
            businessTimezone: 'Asia/Kolkata',
            storeId: '1',
            businessDate: date,
            payload: {
              baselineHash: cashLedgerCorrectionBaselineHash('1', date, anchors, closes, [], sales),
              cashAdjustment: index === 2 ? '100.00' : '0.00',
              cashOut: index === 1 ? '100.00' : '0.00',
            },
          },
          proofKey,
        ),
      ),
      options = ledgerOptions({
        BQ_FINANCE_OPENING_BALANCES: 'fixture-project.finance.anchors',
        BQ_FINANCE_DAY_CLOSES: 'fixture-project.finance.closes',
        BQ_FINANCE_DAY_BANKING: 'fixture-project.finance.banking',
        BQ_FINANCE_CASH_COLLECTIONS: 'fixture-project.finance.collections',
        BQ_FINANCE_CASH_COLLECTIONS_OFFLINE_CONTRACT: 'pos-cash-collections-v2',
      });
    let missing = false;
    const warehouse = {
        async queryReport(statement: string): Promise<Record<string, unknown>[]> {
          if (statement.includes('finance.payment_publications'))
            return statement.includes('GROUP BY generation_id')
              ? [{ generationId: 'fixture_cash_conservation' }]
              : missing
                ? partitions.slice(0, 2)
                : partitions;
          expect(statement).toContain('generation_id=@generation');
          if (statement.includes('finance.anchors')) return anchors;
          if (statement.includes('finance.closes')) return closes;
          if (statement.includes('finance.collections'))
            return sales.map((row) => ({
              ...row,
              cashProjectionContract: 'pos-cash-collections-v2',
            }));
          return [];
        },
      },
      service = cashLedgerService(
        readConfig({
          NODE_ENV: 'test',
          MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
          SESSION_SECRET: 'fixture-history-conservation-session-'.repeat(2),
        }),
        resources(),
        options,
        warehouse,
        clock,
        { proofKey, publicationTable: 'fixture-project.finance.payment_publications' },
      );
    const result = await service.read(user, ['1'], dates[0], dates[2]);
    expect(
      result.data.map((row) => [row.date, row.sales_cash, row.opening_cash, row.running_total]),
    ).toEqual([
      [dates[0], '100.00', '50.00', '150.00'],
      [dates[1], '-100.00', '150.00', '50.00'],
      [dates[2], '100.00', '50.00', '150.00'],
    ]);
    missing = true;
    await expect(service.read(user, ['1'], dates[0], dates[2])).rejects.toMatchObject({
      code: 'PAYMENT_CORRECTION_PUBLICATION_INVALID',
    });
  });
  it('routes historical chains only to explicit warehouse tables and never falls back to older MySQL rows', async () => {
    const readers: string[] = [],
      queries: string[] = [],
      database: Databases = {
        get: (reader) => {
          readers.push(reader);
          return resources().get(reader);
        },
        close: async () => {},
      };
    const options = ledgerOptions({
      BQ_FINANCE_OPENING_BALANCES: 'fixture-project.finance.anchors',
      BQ_FINANCE_DAY_CLOSES: 'fixture-project.finance.closes',
      BQ_FINANCE_DAY_BANKING: 'fixture-project.finance.banking',
      BQ_FINANCE_CASH_COLLECTIONS: 'fixture-project.finance.collections',
      BQ_FINANCE_CASH_COLLECTIONS_OFFLINE_CONTRACT: 'pos-cash-collections-v2',
    });
    const proofKey = 'fixture-history-financial-proof-key-'.repeat(2),
      anchor = { storeId: '1', date: '2026-11-15', amount: '100.00' },
      cash = {
        storeId: '1',
        date: '2026-11-15',
        cash: '20.00',
        cashRefund: '2.00',
      },
      publication = sealPaymentCorrectionPartition(
        {
          contract: paymentCorrectionPublicationContract,
          kind: 'cash-ledger',
          generationId: 'fixture_generation',
          sourcePosition: 'mysql-bin.42:123',
          cdcWatermark: '2026-11-16T17:29:30Z',
          publishedAt: '2026-11-16T17:29:50Z',
          businessTimezone: 'Asia/Kolkata',
          storeId: '1',
          businessDate: '2026-11-15',
          payload: {
            baselineHash: cashLedgerCorrectionBaselineHash(
              '1',
              '2026-11-15',
              [anchor],
              [],
              [],
              [cash],
            ),
            cashAdjustment: '0.00',
            cashOut: '0.00',
          },
        },
        proofKey,
      ),
      corrections = { proofKey, publicationTable: 'fixture-project.finance.payment_publications' };
    const warehouse = {
      queryReport: async (statement: string): Promise<Record<string, unknown>[]> => {
        queries.push(statement);
        if (statement.includes('finance.payment_publications'))
          return statement.includes('GROUP BY generation_id')
            ? [{ generationId: 'fixture_generation' }]
            : [publication];
        if (statement.includes('finance.anchors')) return [anchor];
        if (statement.includes('finance.collections'))
          return [
            {
              storeId: '1',
              date: '2026-11-15',
              cash: '20.00',
              cashRefund: '2.00',
              cashProjectionContract: 'pos-cash-collections-v2',
            },
          ];
        return [];
      },
    };
    const cfg = readConfig({
        NODE_ENV: 'test',
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'cash-ledger-history-fixture-'.repeat(3),
      }),
      service = cashLedgerService(cfg, database, options, warehouse, clock, corrections);
    const historical = await service.read(user, ['1'], '2026-11-15', '2026-11-15');
    expect(historical.reader).toBe('bigquery');
    expect(historical.data[0]?.running_total).toBe('118.00');
    expect(readers).toEqual(['primary']);
    expect(queries).toHaveLength(6);
    for (const query of queries.filter((value) => !value.includes('GROUP BY generation_id')))
      expect(query).toContain('generation_id=@generation');
    queries.length = 0;
    await expect(
      cashLedgerService(
        cfg,
        database,
        { ...options, BQ_FINANCE_CASH_COLLECTIONS_OFFLINE_CONTRACT: undefined },
        warehouse,
        clock,
      ).read(user, ['1'], '2026-11-15', '2026-11-15'),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(queries).toEqual([]);
    readers.length = 0;
    await expect(
      cashLedgerService(cfg, database, ledgerOptions({}), warehouse, clock).read(
        user,
        ['1'],
        '2026-11-15',
        '2026-11-15',
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(readers).toEqual(['primary']);
    await admin!.query('DELETE FROM store_cash_opening_balance');
    readers.length = 0;
    await expect(
      cashLedgerService(cfg, database, ledgerOptions({}), warehouse, clock).read(
        user,
        ['1'],
        '2026-11-16',
        '2026-11-16',
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(readers).toEqual(['primary', 'data']);
  });
  it('keeps day-close latest-attempt filtering ahead of search and exports safe complete financial rows', async () => {
    const [first] = await resources().get('writer').select().from(StoreDayClose);
    if (!first) throw new Error('Fixture close missing');
    const { id, ...fields } = first;
    expect(id).toBeGreaterThan(0n);
    await resources()
      .get('writer')
      .insert(StoreDayClose)
      .values({
        ...fields,
        version: 2,
        status: 'CLOSED',
        cash_reason: 'JUMBLING',
        cash_comment: '=HYPERLINK("https://fixture.example")',
        card_comment: 'REVISION-FIXTURE',
        cash_difference: '1.00',
        closed_at: '2026-11-17 21:00:01',
      });
    const cfg = readConfig({
        NODE_ENV: 'test',
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'close-history-fixture-'.repeat(3),
      }),
      history = closeHistoryService(cfg, resources(), ledgerOptions({}), undefined, clock),
      input = {
        storeIds: ['1'],
        from: '2026-11-16',
        to: '2026-11-16',
        attempts: 'all' as const,
        page: 1,
        pageSize: 25,
      };
    const all = await history.read(user, input);
    expect(all.total).toBe(2);
    expect(all.data.map((row) => row.version)).toEqual([2, 1]);
    expect(all.data[0]).toMatchObject({
      closed_by: 'fixture-operator',
      closed_late: 'Yes',
      cash_result: 'SHORT',
    });
    const latest = await history.read(user, { ...input, attempts: 'latest' });
    expect(latest.total).toBe(1);
    expect(latest.data[0]?.version).toBe(2);
    expect(
      (await history.read(user, { ...input, attempts: 'latest', search: 'STALE' })).total,
    ).toBe(0);
    expect((await history.read(user, { ...input, search: 'STALE' })).total).toBe(1);
    const csv = dayCloseCsv((await history.read(user, input, true)).data);
    expect(csv).toContain('"\'=HYPERLINK');
    expect(csv).toContain('"Cash (system)"');
    expect(csv).toContain('"fixture-operator"');
    expect((await history.read(user, { ...input, search: '%' })).total).toBe(0);
    const readers: string[] = [],
      statements: { sql: string; resource?: string }[] = [],
      proxy: Databases = {
        get: (reader) => {
          readers.push(reader);
          return resources().get(reader);
        },
        close: async () => {},
      },
      fixture = (await resources().get('writer').select().from(StoreDayClose)).map((row) => ({
        ...row,
        close_date: '2026-11-15',
      }));
    const warehouse = {
      queryReport: async (
        statement: string,
        _params: Record<string, unknown>,
        _types: Record<string, string | string[]>,
        resource?: string,
      ): Promise<Record<string, unknown>[]> => {
        statements.push({ sql: statement, resource });
        return statement.includes('COUNT(*) AS count') ? [{ count: 2 }] : fixture;
      },
    };
    const historical = await closeHistoryService(
      cfg,
      proxy,
      ledgerOptions({ BQ_FINANCE_DAY_CLOSES: 'fixture-project.finance.closes' }),
      warehouse,
      clock,
    ).read(user, { ...input, from: '2026-11-15', to: '2026-11-15' });
    expect(historical.reader).toBe('bigquery');
    expect(historical.total).toBe(2);
    expect(readers).toEqual(['primary']);
    expect(statements.every((statement) => statement.resource === 'day-close-history')).toBe(true);
    await expect(history.read(user, { ...input, storeIds: ['2'] })).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
  });
  it('posts pending-close alerts synchronously per store, derives the last expired day and replays a command from Redis', async () => {
    const cfg = readConfig({
        NODE_ENV: 'test',
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'pending-alerts-fixture-'.repeat(3),
      }),
      posts: { url: string | undefined; text: string }[] = [],
      ephemeral = memoryEphemeralStore(),
      alerts = financePendingAlerts(
        cfg,
        resources(),
        ephemeral,
        {
          SLACK_URL: 'https://hooks.slack.com/services/FIXTURE/COMMON/SECRET',
          COMMON_GROUP_ALERT_ON: true,
        },
        async (url, text) => {
          posts.push({ url, text });
          return true;
        },
        clock,
      ),
      commandId = crypto.randomUUID();
    // Production stores.slack_group_url (text, nullable) holds the store webhook.
    try {
      await admin!.query(
        "UPDATE stores SET slack_group_url='https://hooks.slack.com/services/FIXTURE/STORE/SECRET' WHERE id=1",
      );
      const result = await alerts.send(commandId);
      expect(result).toEqual({ commandId, closeDate: '2026-11-15', pending: 1 });
      // report/views.py:2570-2577 + helpers.py:1102-1131: store channel, then the common copy.
      expect(posts).toEqual([
        {
          url: 'https://hooks.slack.com/services/FIXTURE/STORE/SECRET',
          text: expect.stringMatching(/^Day Close pending — .+ — 15-11-2026 was never closed\./),
        },
        {
          url: 'https://hooks.slack.com/services/FIXTURE/COMMON/SECRET',
          text: posts[0]!.text,
        },
      ]);
      expect(await ephemeral.get(`pos:finance_day_close_alert_cmd:${commandId}`)).not.toBeNull();
      expect(await ephemeral.ttl(`pos:finance_day_close_alert_cmd:${commandId}`)).toBeGreaterThan(
        86000,
      );
      expect(await alerts.send(commandId)).toEqual(result);
      expect(posts).toHaveLength(2);
      await expect(alerts.send(commandId, '2026-11-14')).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      // No window check, as legacy: a still-open day is alerted when requested explicitly.
      expect(await alerts.send(crypto.randomUUID(), '2026-11-16')).toMatchObject({
        closeDate: '2026-11-16',
      });
      posts.length = 0;
      await resources()
        .get('writer')
        .update(StoreDayClose)
        .set({ close_date: '2026-11-15', status: 'CLOSED' });
      expect(await alerts.send(crypto.randomUUID())).toMatchObject({ pending: 0 });
      expect(posts).toHaveLength(0);
    } finally {
      await admin!.query('UPDATE stores SET slack_group_url=NULL');
    }
  });
  it('denies elevated revision permission from a stale principal when the writer role is lower', async () => {
    const cfg = readConfig({
        NODE_ENV: 'test',
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'authoritative-close-role-'.repeat(3),
      }),
      service = financeService(cfg, resources(), clock, { assertCheckIn: async () => {} }),
      entries = closeEntriesSchema.parse({
        cash_actual: '0',
        cash_manual_punched: '0',
        cash_manual_created: '0',
        card_actual: '0',
        card_manual_punched: '0',
        card_manual_created: '0',
        banking_amount: '0',
      });
    await expect(
      service.close({ ...user, role: 1 }, '1', '2026-11-15', crypto.randomUUID(), 2, entries),
    ).rejects.toMatchObject({ code: 'DAY_CLOSE_NOT_ALLOWED' });
    await admin!.query(
      "INSERT INTO stores(id,store_name,is_active,type,category,phone) VALUES(2,'Fixture franchise',1,'STORE','FRANCHISE','9000000002')",
    );
    const franchiseUser = { ...user, storeIds: ['2'] };
    const mixed = financeService(
        { ...cfg, DAY_CLOSE_ENABLED_STORE_IDS: 'ALL,COCO' },
        resources(),
        clock,
        { assertCheckIn: async () => {} },
      ),
      all = financeService({ ...cfg, DAY_CLOSE_ENABLED_STORE_IDS: ' all ' }, resources(), clock, {
        assertCheckIn: async () => {},
      });
    expect((await mixed.state(franchiseUser, '2', '2026-11-16')).window.allowed).toBe(false);
    expect((await all.state(franchiseUser, '2', '2026-11-16')).window.allowed).toBe(true);
  });
});
