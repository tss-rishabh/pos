import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { splitMigration } from '../../src/db/migrations.js';
import {
  couponHistoryWriterDefinitions,
  couponHistoryWritersReviewManifest,
  couponHistoryWritersReviewSql,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-writers.js';
import { couponControlHeadHash } from '../../src/modules/legacy-order-imports/benefit-profile/history-publication.js';
import { couponHistoryWitnessSchema } from '../../src/modules/legacy-order-imports/benefit-profile/bridge.js';
import type { CouponHistoryScope } from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import { importFinancialFixture } from '../legacy-import-financial/fixture.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  folder = 'compatibility/upstream/legacy-order-imports/benefit-profile',
  key = 'isolated-head-fence-proof-key-'.repeat(3);
describe.skipIf(!template)('late source coupon history head fence on owned native MySQL', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>,
    native: ReturnType<typeof verifiedMysqlFixture>;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    native = verifiedMysqlFixture(f.connection, [
      'evidence/mysql-import-benefit-profile-schema.json',
    ]);
    await native.create(['coupons', 'order_coupon_log']);
    for (const statement of splitMigration(
      couponHistoryWritersReviewSql().split('DELIMITER $$')[0]!,
    ))
      await f.connection.query(statement);
    for (const row of couponHistoryWriterDefinitions)
      await f.connection.query(
        `CREATE TRIGGER ${row.name} AFTER ${row.event} ON ${row.table} FOR EACH ROW ${row.statement}`,
      );
    expect(
      JSON.parse(readFileSync(folder + '/coupon-history-writers.review.json', 'utf8')) as unknown,
    ).toEqual(couponHistoryWritersReviewManifest());
    expect(readFileSync(folder + '/coupon-history-writers.review.sql', 'utf8')).toBe(
      couponHistoryWritersReviewSql(),
    );
  }, 30000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
    await f.connection.query('DELETE FROM order_coupon_log');
    await f.connection.query('DELETE FROM coupons');
    await f.connection.query('DELETE FROM pos_rewrite_coupon_history_heads');
    await native.insert('coupons', {
      id: '222',
      voucher_code: 'SYNTHETIC_HEAD_FENCE',
      voucher_type: '1',
      voucher_valid_for: 1,
      platform: 'offline',
      no_times_allowed: 1000,
    });
    for (const id of ['5000', '5001'])
      await f.fixture.insert('orders', {
        id,
        user_id: '77',
        coupon_used: '222',
        order_status: 1,
        created_at: '2026-06-15 12:00:00',
        updated_at: '2026-06-15 12:00:00',
        payment_method: 14,
      });
    await native.insert('order_coupon_log', {
      id: '4000',
      user_id: '77',
      order_id: '5000',
      coupon_id: '222',
      status: 1,
      created_at: '2026-06-15 12:00:00',
      updated_at: '2026-06-15 12:00:00',
    });
    await f.connection.query(`INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision)
      VALUES('controls','0',10000000000000000001),('coupon','222',10000000000000000002),('customer','77',10000000000000000003)
      ON DUPLICATE KEY UPDATE revision=VALUES(revision),last_owner_nonce=NULL,owner_start_revision=NULL`);
  });
  it.each([
    'own-multiple',
    'foreign-order',
    'foreign-coupon',
    'foreign-log',
    'rollback',
    'stale-owner',
    'no-validation',
    'after-validation',
    'later-writer-waits',
    'bad-witness',
    'bad-owner',
  ])(
    '%s retains original eligibility or rolls back completely',
    (testCase) => {
      const scope: CouponHistoryScope = {
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
      const result = spawnSync(
        resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
        ['-B', resolve(folder + '/history_heads_driver.py')],
        {
          input: JSON.stringify({ url: f.config.MYSQL_WRITER_URL, key, scope, case: testCase }),
          encoding: 'utf8',
          timeout: 25000,
          maxBuffer: 100000,
        },
      );
      // Fixture stderr remains private: SQLAlchemy errors may contain native data.
      expect(result.status, `Head fence fixture ${testCase} failed`).toBe(0);
      const output = z
        .object({
          passed: z.string(),
          witness: couponHistoryWitnessSchema,
          headHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(JSON.parse(result.stdout) as unknown);
      expect(output.passed).toBe(testCase);
      expect(output.headHash).toBe(couponControlHeadHash({ scope, ...output.witness }, key));
    },
    30000,
  );
});
