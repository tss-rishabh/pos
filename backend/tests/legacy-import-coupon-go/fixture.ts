import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { splitMigration } from '../../src/db/migrations.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  importFinancialFixture,
  financialClock,
  sourceKey,
} from '../legacy-import-financial/fixture.js';
import { benefitFixture } from '../legacy-import-benefits/fixture.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import {
  expectedFinancialPlanHash,
  financialSourceHash,
} from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import {
  automaticCouponReceiptSchema,
  posComplementaryReceiptSchema,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import {
  sourceOrderReceiptSchema,
  type ImportFinancialState,
} from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  financialImportOperations,
  financialImportStages,
  financialImportOrderBindings,
  financialImportSourceReceipts,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';

export const authKey = 'isolated-go-coupon-private-auth-'.repeat(3),
  guardKey = 'isolated-go-coupon-birthday-guard-'.repeat(3);
export { sourceKey, financialClock };
export async function couponFixture(template: string) {
  const f = await importFinancialFixture(template);
  const native = verifiedMysqlFixture(f.connection, [
    'evidence/mysql-import-benefit-profile-schema.json',
    'evidence/mysql-customer-contact-schema.json',
    'evidence/mysql-import-coupon-country-schema.json',
    'evidence/mysql-global-benefits-schema.json',
    'evidence/mysql-pending-cancellation-benefits-schema.json',
    'evidence/mysql-import-referral-schema.json',
  ]);
  const added = [
    'coupons',
    'coupon_countries',
    'coupons_users',
    'order_coupon_log',
    'order_freebies',
    'order_freebie_triggers',
    'order_tss_money',
    'order_tss_point',
    'tss_money_history',
    'tss_point_history',
    'reward_point_history',
    'gift_voucher_history',
    'order_cancel_message_mapping',
    'referral_log',
  ];
  await native.create(added);
  await f.connection.query(
    'ALTER TABLE referral_log ADD UNIQUE KEY unique_refer_pair(referred_to,referred_by)',
  );
  for (const path of [
    'src/modules/checkout/cancellations/benefit-migration.sql',
    'src/modules/checkout/cancellations/membership-producer-migration.sql',
    'compatibility/upstream/legacy-order-imports/benefit-profile/migration.sql',
  ])
    for (const statement of splitMigration(readFileSync(path, 'utf8')))
      await f.connection.query(statement);
  const journal = legacyImportFinancialJournal(f.config, f.db, f.options);
  async function reset() {
    for (const name of [
      ...added,
      'pos_rewrite_import_birthday_claims',
      'pos_rewrite_import_birthday_guards',
      'pos_rewrite_cancellation_membership_provenance',
      'pos_rewrite_membership_versions',
    ])
      await f.connection.query('DELETE FROM `' + name + '`');
    await f.reset();
    await f.connection.query(
      "ALTER TABLE has_products MODIFY COLUMN type ENUM('REGULAR','JIT','PRE_ORDER','MTO','FREEBIE') NULL DEFAULT NULL",
    );
    await f.connection.query('ALTER TABLE has_products AUTO_INCREMENT=9007199254741001');
    await f.connection.query(
      "UPDATE users SET email='fixture@example.test',birthdate='1990-06-10',tss_money=0,tss_points=0,cashback=0 WHERE id=77",
    );
    await f.connection.query(
      'UPDATE products SET price=25.49,spl_price=0,prod_type=1 WHERE id=9007199254740993',
    );
    await f.fixture.insert('products', {
      id: '9007199254740994',
      price: 17.83,
      spl_price: 0,
      prod_type: 4,
      parent_prod_id: 0,
    });
    await f.fixture.insert('product_store', {
      id: 2,
      store_id: 1,
      product_id: '9007199254740994',
      stock: 100,
      is_avail: 1,
      is_del: 0,
    });
    await f.fixture.insert('product_stocks', {
      prod_id: '9007199254740994',
      parent_prod_id: 0,
      stock: 100,
      stocked: 0,
    });
    await native.insert('coupons', {
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
      is_employee_coupon: 0,
    });
    await native.insert('coupons_users', {
      id: '9007199254741500',
      user_id: 77,
      c_id: 222,
      coupon_allowed_count: 5,
      coupon_used_count: 0,
      coupon_month_allowed_count: 5,
    });
  }
  async function stage(
    options: {
      unitMode?: boolean;
      duplicates?: boolean;
      empty?: boolean;
      kind?: 'offline' | 'shopify';
      used?: string;
    } = {},
  ) {
    const { plan } = benefitFixture(options.kind);
    plan.lines[0]!.unitPrice = '25.49';
    plan.createdAt = '2026-06-15 12:00:00';
    plan.originalTenderAmount = '104.47';
    const scope = { actorId: '1', operationId: randomUUID(), storeId: '1', counterId: '2' };
    plan.storeId = scope.storeId;
    const planHash = expectedFinancialPlanHash(f.options.secret, scope, plan);
    const reserved = await journal.reserve({ ...scope, plan, planHash });
    const state: ImportFinancialState = { ...reserved.state, orderId: '5001', stage: 'order' };
    if (options.duplicates)
      await native.insert('coupons_users', {
        id: '9007199254741501',
        user_id: 77,
        c_id: 222,
        coupon_allowed_count: 10,
        coupon_used_count: 3,
        coupon_month_allowed_count: 4,
      });
    if (options.empty) await f.connection.query('DELETE FROM coupons_users');
    if (options.used)
      await f.connection.execute('UPDATE coupons_users SET coupon_used_count=?', [options.used]);
    await f.fixture.insert('orders', {
      id: 5001,
      user_id: 77,
      created_at: plan.createdAt,
      updated_at: plan.createdAt,
      payment_method: plan.kind === 'offline' ? 14 : 15,
      payment_status: plan.kind === 'offline' ? 0 : 1,
      order_status: plan.kind === 'offline' ? 0 : 1,
      pay_amt: 45,
      order_amt: 50.98,
      coupon_used: plan.kind === 'offline' ? 222 : 0,
      coupon_amt_used: plan.kind === 'offline' ? 5.1 : 0,
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
    await f.fixture.insert('order_stores', { id: 1, order_id: 5001, store_id: 1, counter_id: 2 });
    const output: unknown = JSON.parse(
      execFileSync(
        'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
        ['-B', 'tests/legacy-import-coupon-go/native_driver.py'],
        {
          input: JSON.stringify({
            url: f.config.MYSQL_WRITER_URL,
            state,
            plan,
            key: sourceKey,
            guardKey,
            now: financialClock,
            lineItems: options.unitMode ?? false,
          }),
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 1000000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        },
      ),
    );
    const parsed = z
      .object({
        ok: z.literal(true),
        result: z.object({
          order: sourceOrderReceiptSchema,
          coupon: z.object({ value: automaticCouponReceiptSchema, seal: z.string() }),
          complementary: z.object({ value: posComplementaryReceiptSchema, seal: z.string() }),
        }),
      })
      .safeParse(output);
    if (!parsed.success) throw new Error('Source coupon fixture failed: ' + JSON.stringify(output));
    const result = parsed.data.result;
    if (result.order.counterId !== scope.counterId)
      throw new Error('Fixture source scope mismatch');
    await f.db
      .get('writer')
      .update(financialImportOperations)
      .set({ state })
      .where(eq(financialImportOperations.id, scope.operationId));
    await f.db
      .get('writer')
      .insert(financialImportOrderBindings)
      .values({
        orderId: '5001',
        operationId: scope.operationId,
        requestHash: state.requestHash,
        proofHash: financialSourceHash(sourceKey, 'order', result.order),
        status: 'held',
      });
    await f.db
      .get('writer')
      .insert(financialImportSourceReceipts)
      .values({
        id: scope.operationId + ':order',
        operationId: scope.operationId,
        kind: 'order',
        requestHash: state.requestHash,
        status: 'completed',
        proof: result.order,
        proofHash: financialSourceHash(sourceKey, 'order', result.order),
        createdAt: financialClock,
      });
    const nonce = randomUUID();
    await f.db
      .get('writer')
      .insert(financialImportStages)
      .values({
        id: scope.operationId + ':confirmation',
        operationId: scope.operationId,
        kind: 'confirmation',
        nonce,
        status: 'dispatched',
        requestHash: state.requestHash,
        createdAt: financialClock,
        updatedAt: financialClock,
      });
    return { ...result, state, plan, nonce };
  }
  function goInput(staged: Awaited<ReturnType<typeof stage>>, extra: Record<string, unknown> = {}) {
    const issuedAt = Date.now(),
      cap = {
        contract: 'pos-legacy-order-import-source-v1',
        phase: 'confirmation',
        operationId: staged.state.scope.operationId,
        requestHash: staged.state.requestHash,
        planHash: staged.state.planHash,
        namespace: staged.state.namespace,
        planDigest: financialSourceHash(authKey, 'plan', staged.plan),
        orderId: '5001',
        nonce: staged.nonce,
        scope: staged.state.scope,
        authority: staged.state.authority,
        issuedAt,
        expiresAt: issuedAt + 60000,
      };
    return JSON.stringify({
      url: f.config.MYSQL_WRITER_URL,
      authKey,
      proofKey: sourceKey,
      orderId: 5001,
      capability: { ...cap, signature: financialSourceHash(authKey, 'capability', cap) },
      selected: true,
      contenders: 1,
      mutation: '',
      reject: false,
      replay: false,
      ...extra,
    });
  }
  function go(staged: Awaited<ReturnType<typeof stage>>, extra: Record<string, unknown> = {}) {
    const binary = process.env.POS_IMPORT_COUPON_GO_BINARY;
    if (!binary) throw new Error('Compile the isolated Go fixture first.');
    try {
      const output = execFileSync(
        binary,
        ['-test.run', '^TestImportCouponExistingSource$', '-test.v'],
        {
          input: goInput(staged, extra),
          encoding: 'utf8',
          timeout: 25000,
          maxBuffer: 12000,
          env: { ...process.env, POS_IMPORT_COUPON_GO_FIXTURE: '1' },
        },
      );
      return z
        .object({ sourceCalls: z.number(), created: z.number(), refused: z.number() })
        .parse(JSON.parse(output.match(/COUPON_BRIDGE (\{[^\n]+\})/)?.[1] ?? 'null'));
    } catch (error: unknown) {
      const output =
        typeof error === 'object' && error !== null && 'stdout' in error
          ? String(error.stdout)
          : '';
      throw new Error(
        output.match(/local coupon [^\n]*/)?.[0] ?? 'Isolated Go coupon bridge failed.',
      );
    }
  }
  function goAsync(staged: Awaited<ReturnType<typeof stage>>, extra: Record<string, unknown> = {}) {
    const binary = process.env.POS_IMPORT_COUPON_GO_BINARY;
    if (!binary) throw new Error('Missing isolated Go fixture');
    const child = spawn(binary, ['-test.run', '^TestImportCouponExistingSource$', '-test.v'], {
      env: { ...process.env, POS_IMPORT_COUPON_GO_FIXTURE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.resume();
    child.stdin.end(goInput(staged, extra));
    return new Promise<string>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve(output)
          : reject(new Error('Isolated concurrent coupon bridge failed')),
      );
    });
  }
  return { ...f, native, reset, stage, go, goAsync };
}
