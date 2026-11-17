import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDatabases } from '../../src/db/pools.js';
import { readConfig } from '../../src/config.js';
import { splitMigration } from '../../src/db/migrations.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { assertNativeCsvBenefits } from '../../src/modules/legacy-order-imports/benefit-profile/native.js';
import {
  csvBenefitProfileHooks,
  validateCsvBenefitCompletion,
} from '../../src/modules/legacy-order-imports/benefit-profile/adapter.js';
import { sourceOrderReceiptSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  automaticCouponReceiptSchema,
  benefitReceiptHash,
  couponActivationSchema,
  posComplementaryReceiptSchema,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import { benefitFixture, now, sourceKey } from './fixture.js';

const template = process.env.IMPORT_BENEFITS_MYSQL_TEST_URL;
const guardKey = 'isolated-source-birthday-cache-key-'.repeat(3);
describe.skipIf(!template)(
  'source coupon/complementary candidates on isolated physical MySQL',
  () => {
    let admin: mysql.Connection,
      connection: mysql.Connection,
      db: ReturnType<typeof createDatabases>,
      fixture: ReturnType<typeof verifiedMysqlFixture>,
      schema: string,
      nativeUrl: string;
    let input: ReturnType<typeof benefitFixture>;
    const tables = [
      'orders',
      'order_stores',
      'has_products',
      'products',
      'users',
      'coupons',
      'coupon_countries',
      'coupons_users',
      'order_coupon_log',
      'order_freebies',
      'order_freebie_triggers',
      'amount_to_be_refunded_log',
      'order_cancel_message_mapping',
    ];
    beforeAll(async () => {
      const url = new URL(template!);
      if (
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_integration'
      )
        throw new Error('Local integration template required.');
      schema = 'pos_import_benefit_' + randomUUID().replaceAll('-', '').slice(0, 12);
      admin = await mysql.createConnection({
        uri: url.href,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      await admin.query('CREATE DATABASE `' + schema + '`');
      url.pathname = '/' + schema;
      nativeUrl = url.href;
      connection = await mysql.createConnection({
        uri: nativeUrl,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      fixture = verifiedMysqlFixture(connection, [
        'evidence/mysql-import-benefit-profile-schema.json',
        'evidence/mysql-customer-contact-schema.json',
        'evidence/mysql-global-benefits-schema.json',
        'evidence/mysql-import-coupon-country-schema.json',
      ]);
      await fixture.create(tables);
      const sourceReceiptDdl = splitMigration(
        readFileSync('src/modules/legacy-order-imports/financial-proof-migration.sql', 'utf8'),
      ).filter((statement) =>
        /CREATE TABLE (?:IF NOT EXISTS )?`?pos_rewrite_import_financial_source_receipts`?\s*\(/i.test(
          statement,
        ),
      );
      expect(sourceReceiptDdl.length).toBe(1);
      await connection.query(sourceReceiptDdl[0]!);
      for (const statement of splitMigration(
        readFileSync(
          'compatibility/upstream/legacy-order-imports/benefit-profile/migration.sql',
          'utf8',
        ),
      ))
        await connection.query(statement);
      db = createDatabases(
        readConfig({
          NODE_ENV: 'test',
          SESSION_SECRET: 'isolated-benefit-native-session-secret',
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
          MYSQL_WRITER_URL: nativeUrl,
          MYSQL_PRIMARY_READER_URL: nativeUrl,
        }),
      );
    }, 10000);
    afterAll(async () => {
      await db?.close();
      await connection?.end();
      if (admin) {
        await admin.query('DROP DATABASE `' + schema + '`');
        await admin.end();
      }
    });
    beforeEach(async () => {
      for (const table of [
        ...tables,
        'pos_rewrite_import_birthday_guards',
        'pos_rewrite_import_birthday_claims',
        'pos_rewrite_import_financial_source_receipts',
      ])
        await connection.query('DELETE FROM `' + table + '`');
      await connection.query(
        "ALTER TABLE has_products MODIFY COLUMN type ENUM('REGULAR','JIT','PRE_ORDER','MTO') NULL DEFAULT NULL",
      );
      await connection.query('ALTER TABLE has_products AUTO_INCREMENT=9007199254741001');
      await connection.query('ALTER TABLE order_freebies AUTO_INCREMENT=9007199254741300');
      input = benefitFixture();
      input.plan.lines[0]!.unitPrice = '25.49';
      input.plan.originalTenderAmount = '104.47';
      await fixture.insert('users', {
        id: '77',
        email: 'fixture@example.test',
        birthdate: '1990-06-10',
        status: 1,
      });
      for (const [index, line] of input.plan.lines.entries())
        await fixture.insert('products', {
          id: line.productId,
          prod_type: index === 0 ? 1 : 4,
          price: index === 0 ? 25.49 : 17.83,
          spl_price: 0,
        });
      await fixture.insert('coupons', {
        id: 222,
        voucher_code: 'SYNTHETIC_BIRTHDAY',
        voucher_type: '1',
        voucher_val: 10,
        voucher_valid_for: 1,
        disc_apply_items: 0,
        min_order_amt: 0,
        platform: 'offline',
        user_type: 2,
        default_country_id: 99,
        start_date: '2020-01-01 00:00:00',
        end_date: '2035-01-01 00:00:00',
        no_times_allowed: 1000,
        is_deleted: 0,
        for_new_user: 0,
        user_specific: 0,
        coupon_lot_no: '',
        message: 'birthday',
        is_applicable_on_discounted_products: 1,
      });
      await fixture.insert('coupons_users', {
        id: '9007199254741500',
        user_id: '77',
        c_id: '222',
        coupon_allowed_count: 5,
        coupon_used_count: 0,
        coupon_month_allowed_count: 5,
      });
      await fixture.insert('orders', {
        id: '5001',
        user_id: '77',
        created_at: input.plan.createdAt,
        updated_at: input.plan.createdAt,
        payment_method: 14,
        payment_status: 0,
        order_status: 0,
        pay_amt: 45,
        order_amt: 50.98,
        coupon_used: 222,
        coupon_amt_used: 5.1,
        cashback_used: 0,
        tss_money_used: 0,
        tss_points_used: 0,
        voucher_used: 0,
        voucher_amt_used: 0,
        parent_order_id: 0,
        original_order_id: 0,
        hl_parent_order_id: 0,
        flag_id: 18,
        shipping_amt: 0,
        cod_charges: 0,
        gifting_charges: 0,
        hl_charges: 0,
      });
      await fixture.insert('order_stores', { id: 1, order_id: 5001, store_id: 1, counter_id: 3 });
    });
    async function acceptSchema() {
      // This review-only legacy ALTER is deliberately refused by the production
      // rewrite migration runner. Execute its exact one statement ONLY here.
      const statement = readFileSync(
        'compatibility/upstream/legacy-order-imports/benefit-profile/complementary-schema.review.sql',
        'utf8',
      )
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .trim();
      expect(statement).toBe(
        "ALTER TABLE has_products MODIFY COLUMN type\n  ENUM('REGULAR','JIT','PRE_ORDER','MTO','FREEBIE') NULL DEFAULT NULL;",
      );
      await connection.query(statement);
    }
    function driver(extra: Record<string, unknown> = {}) {
      const value: unknown = JSON.parse(
        execFileSync(
          'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
          ['-B', 'tools/legacy-import-benefits/native_driver.py'],
          {
            input: JSON.stringify({
              url: nativeUrl,
              state: input.state,
              plan: input.plan,
              key: sourceKey,
              guardKey,
              now,
              ...extra,
            }),
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 1000000,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
          },
        ),
      );
      return z
        .object({
          ok: z.boolean(),
          result: z.unknown().optional(),
          code: z.union([z.string(), z.null()]).optional(),
          nativeCode: z.number().nullable().optional(),
          class: z.string().optional(),
          frames: z.array(z.string()).optional(),
        })
        .parse(value);
    }
    function staged(result: ReturnType<typeof driver>) {
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(
        result,
        'Original source component must succeed in its isolated fixture.',
      ).toMatchObject({ ok: true });
      const shape = z
        .object({
          order: sourceOrderReceiptSchema,
          coupon: z.object({ value: automaticCouponReceiptSchema, seal: z.string() }),
          complementary: z.object({ value: posComplementaryReceiptSchema, seal: z.string() }),
          activation: z
            .object({
              value: couponActivationSchema,
              seal: z.string(),
              confirmationHash: z.string(),
            })
            .optional(),
        })
        .parse(result.result);
      return {
        ...input,
        ...shape,
        phase: shape.activation ? ('settled' as const) : ('staged' as const),
      };
    }
    it('proves original FREEBIE enum failure and atomically rolls back HP, claim and grant', async () => {
      expect(driver({ unqualifiedSchema: true })).toMatchObject({ ok: false, nativeCode: 1265 });
      for (const table of [
        'has_products',
        'order_freebies',
        'pos_rewrite_import_birthday_claims',
      ]) {
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT COUNT(*) AS n FROM `' + table + '`',
        );
        expect(String(rows[0]!.n)).toBe('0');
      }
    });
    for (const lineItems of [false, true])
      it(`roundtrips actual >2^53 HP/grant IDs and original price branch (split=${lineItems})`, async () => {
        await acceptSchema();
        const value = staged(driver({ lineItems }));
        const result = await db
          .get('writer')
          .transaction((tx) => assertNativeCsvBenefits(tx, value));
        expect(result.ownership.at(-1)!.owner).toBe('pos-complementary');
        expect(result.complementary!.selections[0]!.line.price).toBe(lineItems ? '0.00' : '17.83');
        expect(result.complementary!.selections[0]!.line.refundable).toBe(
          lineItems ? '0.00' : '11.66',
        );
        expect(BigInt(value.order.lines[0]!.id)).toBeGreaterThan(9007199254740991n);
        expect(BigInt(result.complementary!.selections[0]!.grant.id)).toBeGreaterThan(
          9007199254740991n,
        );
      });
    it('requires all coupon counter/log effects and captures exact source consumption once', async () => {
      await acceptSchema();
      const value = staged(driver({ consume: true }));
      expect(
        await db.get('writer').transaction((tx) => assertNativeCsvBenefits(tx, value)),
      ).toBeTruthy();
      expect(value.activation!.value.changes[0]).toMatchObject({ before: '0', after: '1' });
      await connection.query('UPDATE coupons_users SET coupon_used_count=2');
      await expect(
        db.get('writer').transaction((tx) => assertNativeCsvBenefits(tx, value)),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID' });
    });
    it('retains Shopify NULL-to-default0 header, no coupon ledger and original CSV stock quantities', async () => {
      await acceptSchema();
      input = benefitFixture('shopify');
      input.plan.lines[0]!.unitPrice = '25.49';
      input.plan.originalTenderAmount = '104.47';
      await connection.query(
        'UPDATE orders SET payment_method=15,payment_status=1,order_status=1,coupon_used=0,coupon_amt_used=0',
      );
      const value = staged(driver()),
        result = await db.get('writer').transaction((tx) => assertNativeCsvBenefits(tx, value));
      expect(result.coupon).toMatchObject({
        headerCouponId: null,
        headerCouponAmount: '0.00',
        consumption: 'shopify-none',
      });
      expect(result.coupon!.allocations.every((row) => row.discount === '0.00')).toBe(true);
      expect(result.stock.kind).toBe('original-plan');
      expect(result.stock.lines.at(-1)!.quantity).toBe(3);
    });
    it('never infers Go consumption from a paid status or signed staged receipt', async () => {
      await acceptSchema();
      const value = staged(driver());
      await connection.query('UPDATE orders SET payment_status=4,order_status=3');
      await expect(
        db
          .get('writer')
          .transaction((tx) => assertNativeCsvBenefits(tx, { ...value, phase: 'settled' })),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID' });
    });
    it('accepts source zero payable without creating a cash declaration', async () => {
      await acceptSchema();
      await connection.query('UPDATE coupons SET voucher_val=100');
      await connection.query('UPDATE orders SET pay_amt=0,coupon_amt_used=50.98');
      const value = staged(driver({ percent: 100 }));
      const result = await db.get('writer').transaction((tx) => assertNativeCsvBenefits(tx, value));
      expect(value.order.payable).toBe('0.00');
      expect(result.coupon!.allocations.every((row) => row.refundable === '0.00')).toBe(true);
      expect(value.plan.originalTenderAmount).toBe('104.47');
    });
    it('refuses changed coupon controls between prefetch and source execution without native effects', async () => {
      await acceptSchema();
      expect(driver({ changeCouponAfterPrefetch: true })).toMatchObject({
        ok: false,
        code: 'ORDER_IMPORT_COUPON_CONFIGURATION_CHANGED',
      });
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT (SELECT COUNT(*) FROM has_products) AS hp,(SELECT COUNT(*) FROM pos_rewrite_import_birthday_claims) AS claims',
      );
      expect(rows.map((row) => [String(row.hp), String(row.claims)])).toEqual([['0', '0']]);
    });
    for (const sql of [
      'UPDATE order_freebies SET has_product_id=999',
      'DELETE FROM order_freebies',
      "UPDATE has_products SET disc=0 WHERE type='REGULAR'",
      "UPDATE has_products SET amount_to_be_refunded=1 WHERE type='FREEBIE'",
      'UPDATE coupons_users SET coupon_used_count=1',
    ])
      it(`detects changed native evidence: ${sql.split(' ')[1]}`, async () => {
        await acceptSchema();
        const value = staged(driver());
        await connection.query(sql);
        await expect(
          db.get('writer').transaction((tx) => assertNativeCsvBenefits(tx, value)),
        ).rejects.toMatchObject({ code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID' });
      });
    it('refuses missing grant audit and late failure with complete transaction rollback', async () => {
      await acceptSchema();
      expect(driver({ failGrant: true })).toMatchObject({
        ok: false,
        code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID',
      });
      expect(driver({ lateFailure: true })).toMatchObject({
        ok: false,
        code: 'ORDER_IMPORT_FIXTURE_LATE_FAILURE',
      });
      for (const table of [
        'has_products',
        'order_freebies',
        'pos_rewrite_import_birthday_claims',
      ]) {
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT COUNT(*) AS n FROM `' + table + '`',
        );
        expect(String(rows[0]!.n)).toBe('0');
      }
    });
    it('serializes 20 exact-UUID claim replays without a second claim or expiry extension', async () => {
      expect(driver({ mode: 'race' })).toMatchObject({
        ok: true,
        result: { claims: 20, unique: 1 },
      });
      const [claims] = await connection.query<RowDataPacket[]>(
        'SELECT receipt FROM pos_rewrite_import_birthday_claims',
      );
      const first = JSON.stringify(claims);
      expect(driver({ mode: 'claim', now: now + 1000 })).toMatchObject({ ok: true });
      const [again] = await connection.query<RowDataPacket[]>(
        'SELECT receipt FROM pos_rewrite_import_birthday_claims',
      );
      expect(JSON.stringify(again)).toBe(first);
      input.state.scope.operationId = randomUUID();
      expect(driver({ mode: 'claim' })).toMatchObject({ ok: true, result: null });
    });
    it('honors retained legacy guard and rejects a newly signed wrong scope natively', async () => {
      expect(driver({ mode: 'claim', legacyPresent: true })).toMatchObject({
        ok: true,
        result: null,
      });
      await acceptSchema();
      const value = staged(driver());
      value.coupon.value.birthdayClaim.id = randomUUID();
      value.coupon.seal = benefitReceiptHash('coupon', value.coupon.value, sourceKey);
      await expect(
        db.get('writer').transaction((tx) => assertNativeCsvBenefits(tx, value)),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID' });
    });
    it('persists immutable side receipts and composes real adapter/completed snapshot without new effects', async () => {
      await acceptSchema();
      const value = staged(driver());
      const hooks = csvBenefitProfileHooks({
        automaticCoupon: 'pos-csv-automatic-coupon-v1',
        complementary: 'pos-csv-pos-complementary-v1',
        sourceProofKey: sourceKey,
      });
      const result = await db
        .get('writer')
        .transaction((tx) =>
          hooks.assertStaged(tx, { state: value.state, plan: value.plan, order: value.order }),
        );
      expect(
        validateCsvBenefitCompletion(result.snapshot, { ...value.state, order: value.order }),
      ).toEqual(result.snapshot);
      expect(
        driver({
          mode: 'receipt-replay',
          kind: 'pos-complement',
          receipt: value.complementary.value,
        }),
      ).toMatchObject({ ok: true, result: value.complementary.seal });
      const changed = structuredClone(value.complementary.value);
      changed.selections[0]!.declaredQuantity = 1;
      expect(
        driver({ mode: 'receipt-replay', kind: 'pos-complement', receipt: changed }),
      ).toMatchObject({ ok: false, code: 'ORDER_IMPORT_BENEFIT_RECEIPT_CONFLICT' });
      const [counts] = await connection.query<RowDataPacket[]>(
        'SELECT (SELECT COUNT(*) FROM has_products) AS hp,(SELECT COUNT(*) FROM order_freebies) AS grants,(SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts) AS receipts',
      );
      expect(
        counts.map((row) => [String(row.hp), String(row.grants), String(row.receipts)]),
      ).toEqual([['2', '1', '2']]);
    });
    it('refuses an oversized selected receipt without silently treating it as absent', async () => {
      await acceptSchema();
      const value = staged(driver());
      await connection.query(
        "UPDATE pos_rewrite_import_financial_source_receipts SET proof=JSON_OBJECT('padding',REPEAT('x',500001)) WHERE kind='pos-complement'",
      );
      const hooks = csvBenefitProfileHooks({
        automaticCoupon: 'pos-csv-automatic-coupon-v1',
        complementary: 'pos-csv-pos-complementary-v1',
        sourceProofKey: sourceKey,
      });
      await expect(
        db
          .get('writer')
          .transaction((tx) =>
            hooks.assertStaged(tx, { state: value.state, plan: value.plan, order: value.order }),
          ),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID' });
    });
    it('allows only one of 20 distinct commands through the shared customer birthday guard', () => {
      expect(driver({ mode: 'race-different' })).toMatchObject({
        ok: true,
        result: { claims: 1, unique: 1 },
      });
    });
    it('rejects tampered legacy cache observation before creating a claim', async () => {
      expect(driver({ mode: 'claim', tamperObservation: true })).toMatchObject({
        ok: false,
        code: 'ORDER_IMPORT_BIRTHDAY_GUARD_UNQUALIFIED',
      });
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM pos_rewrite_import_birthday_claims',
      );
      expect(String(rows[0]!.n)).toBe('0');
    });
    for (const lot of [false, true])
      it(`matches literal source history joins/status sets instead of normalizing them (lot=${lot})`, async () => {
        await connection.query(
          'UPDATE coupons SET user_specific=1,coupon_lot_no=?,unique_no_times_allowed=1',
          [lot ? 'fixture' : ''],
        );
        await connection.query('UPDATE coupons_users SET coupon_month_allowed_count=?', [
          lot ? 0 : 5,
        ]);
        for (const [id, status, created] of [
          [5002, 3, '2026-06-15 11:00:00'],
          [5003, 3, '2026-05-15 11:00:00'],
          [5004, 4, '2026-06-14 11:00:00'],
        ] as const)
          await fixture.insert('orders', {
            id,
            user_id: 77,
            coupon_used: 222,
            order_status: status,
            created_at: created,
          });
        for (const [id, orderId] of [
          [6001, 5002],
          [6002, 5003],
          [6003, 9999],
        ] as const)
          await fixture.insert('order_coupon_log', {
            id,
            order_id: orderId,
            user_id: 77,
            coupon_id: 222,
            status: 1,
            created_at: '2026-06-01 00:00:00',
          });
        const result = driver({ mode: 'history-compare', lot });
        expect(result).toMatchObject({
          ok: true,
          result: {
            today: 1,
            allowed: true,
            originalError: lot
              ? 'Coupon is only valid for 1 times'
              : 'Coupon can only be used 5 times per month',
            replayError: lot
              ? 'Coupon is only valid for 1 times'
              : 'Coupon can only be used 5 times per month',
          },
        });
      });
  },
);
