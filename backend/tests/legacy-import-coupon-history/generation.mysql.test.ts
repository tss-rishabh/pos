import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { benefitDigest } from '../../src/modules/legacy-order-imports/benefit-profile/crypto.js';
import { couponControlHashSql } from '../../src/modules/legacy-order-imports/benefit-profile/native.js';
import { generationControlDataSchema } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-control.js';
import { couponHistoryWritersDefinitionHash } from '../../src/modules/legacy-order-imports/benefit-profile/history-writers.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installNativeHeadFixture } from '../native-head-metadata/fixture.js';
import {
  generationSourceOrigin,
  type GenerationSourceOrigin,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-origin.js';
import { couponGenerationSource } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-source.js';
import {
  generationScopeFor,
  bindGenerationHistory,
  verifyGenerationCapture,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-contracts.js';
import { generationAccumulator } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-projections.js';
import {
  couponComparisonSchema,
  couponComparisonFingerprint,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-contracts.js';
import type { CouponHistoryScope } from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import { importFinancialFixture } from '../legacy-import-financial/fixture.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

import { couponHistoryWitnessSchema } from '../../src/modules/legacy-order-imports/benefit-profile/bridge.js';
import { membershipHistoryWriters } from '../../src/modules/checkout/screening-writer/membership-history-writers.js';
import { qualifyGenerationPublication } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-candidate.js';
import { literalCouponFacts } from './warehouse-fixtures.js';
const clock = Date.parse('2026-06-15T06:30:00.500Z');
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  key = 'native-generic-generation-key-'.repeat(3);
describe.skipIf(!template)(
  'generic publisher native snapshot, never a runtime historical reader',
  () => {
    let origin: GenerationSourceOrigin;
    let comparison: ReturnType<typeof couponComparisonSchema.parse>;
    let heads: Awaited<ReturnType<typeof installNativeHeadFixture>>;
    let f: Awaited<ReturnType<typeof importFinancialFixture>>,
      native: ReturnType<typeof verifiedMysqlFixture>,
      scope: CouponHistoryScope;
    async function descriptor() {
      const [rows] = await f.db
          .get('writer')
          .execute(
            sql`SELECT ${sql.raw(couponControlHashSql)} AS inputHash FROM coupons WHERE id=222`,
          ),
        [heads] = await f.connection.query(
          "SELECT kind,scope_id AS scopeId,CAST(revision AS CHAR) AS revision FROM pos_rewrite_coupon_history_heads WHERE (kind='controls' AND scope_id='0') OR (kind='coupon' AND scope_id='222') ORDER BY kind,scope_id",
        );
      const hash = z
        .array(z.object({ inputHash: z.string() }))
        .length(1)
        .parse(rows)[0]!.inputHash;
      const data = generationControlDataSchema.parse({
        contract: 'pos-csv-coupon-generation-controls-v1',
        couponId: scope.couponId,
        configurationHash: scope.configurationHash,
        couponInputHash: hash,
        sourceTimeZone: scope.sourceTimeZone,
        sourceDay: scope.asOf.slice(0, 10),
        sourceAsOf: scope.asOf,
        ...origin.expected,
        writersContract: 'pos-csv-coupon-history-all-writers-v1',
        writersDefinitionHash: couponHistoryWritersDefinitionHash,
        heads,
        observedAt: clock,
        expiresAt: clock + 60000,
      });
      return { data, proofHash: benefitDigest('coupon-generation-config', data, key) };
    }
    const producer = (options: Parameters<typeof couponGenerationSource>[2] = {}) => {
      const p = couponGenerationSource(
        origin,
        {
          sourceKey: key,
          comparisonFingerprint: couponComparisonFingerprint(comparison),
          sourceTimeZone: 'Asia/Kolkata',
        },
        { clock: () => clock, headMetadata: heads.headMetadata, ...options },
      );
      return {
        capture: async (input: Parameters<typeof p.capture>[0]) =>
          p.capture(input, await descriptor()),
      };
    };
    beforeAll(async () => {
      f = await importFinancialFixture(template!);
      const [identity] = await f.connection.query(
        'SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema',
      );
      heads = await installNativeHeadFixture(f.connection, template!, {
        families: ['membership', 'coupon'],
      });
      const [columns] = await f.connection.query(
        "SELECT c.COLUMN_NAME AS `column`,c.DATA_TYPE AS dataType,c.CHARACTER_SET_NAME AS characterSet,c.COLLATION_NAME AS collation,k.PAD_ATTRIBUTE AS padAttribute FROM information_schema.COLUMNS c JOIN information_schema.COLLATIONS k ON k.COLLATION_NAME=c.COLLATION_NAME WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME='coupons' AND c.COLUMN_NAME IN('coupon_lot_no','voucher_code')",
      );
      const columnRows = z.array(z.record(z.string(), z.unknown())).parse(columns);
      comparison = couponComparisonSchema.parse({
        contract: 'pos-native-coupon-comparisons-v1',
        lot: columnRows.find((v) => v.column === 'coupon_lot_no'),
        code: columnRows.find((v) => v.column === 'voucher_code'),
        lotComparison: 'native-column-equality-and-nonempty',
        codeComparison: 'python-decoded-exact-utf8',
      });
      origin = generationSourceOrigin(
        () => heads.sourceDb.get('writer'),
        (identity as { serverUuid: string; sourceSchema: string }[])[0]!,
      );
      native = verifiedMysqlFixture(f.connection, [
        'evidence/mysql-import-benefit-profile-schema.json',
        'evidence/mysql-customer-contact-schema.json',
        'evidence/mysql-global-benefits-schema.json',
      ]);
    }, 30000);
    afterAll(async () => {
      await heads?.close();
      await f?.close();
    });
    beforeEach(async () => {
      await f.reset();
      await f.connection.query('DELETE FROM order_coupon_log');
      await f.connection.query('DELETE FROM coupons');
      await f.connection.query('DELETE FROM pos_rewrite_coupon_history_heads');
      for (const [id, code, lot] of [
        [222, 'SYNTHETIC_BIRTHDAY', 'FixtureLot'],
        [223, 'synthetic_birthday', 'fixturelot '],
        [224, 'SYNTHETIC_BIRTHDAY ', 'FixtureLot'],
      ] as const)
        await native.insert('coupons', {
          id,
          voucher_code: code,
          voucher_type: '1',
          voucher_val: 10,
          voucher_valid_for: 1,
          platform: 'offline',
          no_times_allowed: 1000,
          unique_no_times_allowed: 10,
          coupon_lot_no: lot,
          start_date: '2020-01-01 00:00:00',
          end_date: '2035-01-01 00:00:00',
          is_deleted: 0,
          for_new_user: 0,
          user_specific: 0,
        });
      await f.connection.query(
        "INSERT IGNORE INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision) VALUES('controls','0',1),('coupon','222',0),('customer','77',0)",
      );
      scope = {
        contract: 'pos-csv-coupon-history-v1',
        operationId: randomUUID(),
        requestHash: 'a'.repeat(64),
        planHash: 'b'.repeat(64),
        customerId: '77',
        couponId: '222',
        configurationHash: 'c'.repeat(64),
        asOf: '2026-06-15 12:00:00',
        sourceTimeZone: 'Asia/Kolkata',
      };
    });
    async function order(
      id: string,
      couponId: string,
      date = scope.asOf,
      status = 1,
      userId = '77',
    ) {
      await f.fixture.insert('orders', {
        id,
        user_id: userId,
        coupon_used: couponId,
        order_status: status,
        created_at: date,
        updated_at: date,
        payment_method: 14,
      });
    }
    async function log(id: string, couponId: string, date = scope.asOf) {
      await native.insert('order_coupon_log', {
        id,
        user_id: '77',
        order_id: '999999',
        coupon_id: couponId,
        status: 1,
        created_at: date,
        updated_at: date,
      });
    }
    it('captures all five literal facts, exact controls and ordered native projection hashes in one source snapshot', async () => {
      await order('5001', '222');
      await order('5002', '222', scope.asOf, 4);
      await order('5003', '222', '2010-01-01 00:00:00', 6);
      await order('5004', '223', '2035-01-01 00:00:00');
      await order('5005', '222', '2035-01-01 00:00:00', 1, '88');
      await log('101', '222');
      await log('102', '222');
      await log('103', '222');
      await log('104', '223', '2035-01-01 00:00:00');
      await log('105', '999');
      const value = await producer().capture(generationScopeFor(scope));
      expect(value.capture.facts).toMatchObject({
        globalUsage: '3',
        birthdayTodayUsage: '2',
        customerOrderCount: '4',
        monthlyJoinedUsage: '9',
      });
      expect(value.logs.map((v) => v.id)).toEqual(['101', '102', '103', '104', '105']);
      expect(value.controls.find((v) => v.couponId === '999')).toMatchObject({
        present: false,
        lotMatches: false,
      });
      const orders = generationAccumulator('order');
      for (const [id, couponId, createdAt, status, userId] of [
        ['5001', '222', scope.asOf, 1, '77'],
        ['5002', '222', scope.asOf, 4, '77'],
        ['5003', '222', '2010-01-01 00:00:00', 6, '77'],
        ['5004', '223', '2035-01-01 00:00:00', 1, '77'],
        ['5005', '222', '2035-01-01 00:00:00', 1, '88'],
      ] as const)
        orders.add({ id, userId, couponId, status, createdAt });
      expect(value.capture.projections.orders).toEqual(orders.finish());
      expect(verifyGenerationCapture(value.capture, key, clock)).toEqual(value.capture);
      expect(JSON.stringify(value.capture)).not.toMatch(
        /operationId|requestHash|planHash|SYNTHETIC_BIRTHDAY|FixtureLot/,
      );
    });
    it('proves a genuine empty snapshot instead of guessing empty history', async () => {
      const value = await producer().capture(generationScopeFor(scope));
      expect(value.capture.facts).toEqual({
        globalUsage: '0',
        birthdayTodayUsage: '0',
        customerOrderCount: '0',
        monthlyJoinedUsage: '0',
        lotCounts: [],
      });
      expect(value.capture.projections.orders).toEqual(generationAccumulator('order').finish());
      expect(value.logs).toEqual([]);
    });
    it('publishes independent literal warehouse facts from a genuine source snapshot and rejects mismatched or stale evidence', async () => {
      await order('5011', '222');
      await log('111', '222');
      const snapshot = await producer().capture(generationScopeFor(scope));
      const capture = snapshot.capture;
      const facts = literalCouponFacts(
        scope,
        [{ orderId: '5011', userId: '77', couponId: '222', status: 1, createdAt: scope.asOf }],
        [{ logId: '111', userId: '77', couponId: '222', status: 1, createdAt: scope.asOf }],
        snapshot.controls,
      );
      const orders = generationAccumulator('order'),
        logs = generationAccumulator('log');
      orders.add({ id: '5011', userId: '77', couponId: '222', status: 1, createdAt: scope.asOf });
      logs.add({ id: '111', userId: '77', couponId: '222', status: 1, createdAt: scope.asOf });
      const candidate = {
        capture,
        controls: snapshot.controls,
        facts,
        projections: { orders: orders.finish(), logs: logs.finish() },
        materializedAt: clock,
        publication: null,
      };
      const authority = {
        sourceKey: key,
        publicationKey: 'native-coupon-pub-key-'.repeat(3),
        historyKey: 'native-coupon-history-key-'.repeat(3),
      };
      const publication = await qualifyGenerationPublication(
        capture,
        { read: async () => candidate },
        authority,
        couponComparisonFingerprint(comparison),
        { signal: new AbortController().signal, clock: () => clock },
      );
      const witness = {
        writersContract: capture.writersContract,
        writersDefinitionHash: capture.writersDefinitionHash,
        serverUuid: capture.serverUuid,
        sourceSchema: capture.sourceSchema,
        heads: capture.heads,
      };
      const qualified = bindGenerationHistory(
        { ...candidate, publication },
        scope,
        witness,
        authority,
        couponComparisonFingerprint(comparison),
        clock,
      );
      expect(qualified.generationId).toBe(capture.generationId);
      expect(qualified.globalUsage).toBe('1');
      await expect(
        qualifyGenerationPublication(
          capture,
          { read: async () => ({ ...candidate, facts: { ...facts, globalUsage: '0' } }) },
          authority,
          couponComparisonFingerprint(comparison),
          { signal: new AbortController().signal, clock: () => clock },
        ),
      ).rejects.toThrow();
      await order('5012', '222');
      const [heads] = await f.connection.query(
        "SELECT kind,scope_id AS scopeId,CAST(revision AS CHAR) AS revision FROM pos_rewrite_coupon_history_heads WHERE (kind='controls' AND scope_id='0') OR (kind='coupon' AND scope_id='222') OR (kind='customer' AND scope_id='77') ORDER BY kind,scope_id",
      );
      expect(() =>
        bindGenerationHistory(
          { ...candidate, publication },
          scope,
          couponHistoryWitnessSchema.parse({ ...witness, heads }),
          authority,
          couponComparisonFingerprint(comparison),
          clock,
        ),
      ).toThrow();
    });
    it('refuses coupon history when an installed membership writer is removed', async () => {
      const trigger = membershipHistoryWriters.definitions[0]!.name;
      const [rows] = await f.connection.query<import('mysql2/promise').RowDataPacket[]>(
        'SHOW CREATE TRIGGER ' + trigger,
      );
      const original = String(rows[0]!['SQL Original Statement']);
      await f.connection.query('DROP TRIGGER ' + trigger);
      try {
        await expect(producer().capture(generationScopeFor(scope))).rejects.toThrow();
      } finally {
        await f.connection.query(original);
      }
      await expect(producer().capture(generationScopeFor(scope))).resolves.toHaveProperty(
        'capture',
      );
    });
    it('bounds native rows/log export and constructs without I/O', async () => {
      const get = vi.spyOn(f.db, 'get');
      producer();
      expect(get).not.toHaveBeenCalled();
      get.mockRestore();
      await order('5001', '222');
      await order('5002', '222');
      await expect(
        producer({ maxRows: 1 }).capture(generationScopeFor(scope)),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_SOURCE_ROWS' });
      await log('101', '222');
      await log('102', '222');
      await expect(
        producer({ maxLogs: 1 }).capture(generationScopeFor(scope)),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_SOURCE_ROWS' });
      await expect(
        producer({ maxBytes: 1 }).capture(generationScopeFor(scope)),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_SOURCE_BYTES' });
    });
    it('refuses a physical replica/different origin before scanning source history', async () => {
      const mismatched = generationSourceOrigin(() => heads.sourceDb.get('writer'), {
        ...origin.expected,
        serverUuid: randomUUID(),
      });
      await expect(
        couponGenerationSource(
          mismatched,
          {
            sourceKey: key,
            comparisonFingerprint: couponComparisonFingerprint(comparison),
            sourceTimeZone: 'Asia/Kolkata',
          },
          { clock: () => clock, headMetadata: heads.headMetadata },
        ).capture(generationScopeFor(scope), await descriptor()),
      ).rejects.toMatchObject({
        code: 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_ORIGIN_CHANGED',
      });
    });
  },
);
