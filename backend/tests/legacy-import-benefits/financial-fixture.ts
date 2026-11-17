import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { splitMigration } from '../../src/db/migrations.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  importFinancialFixture,
  financialClock,
  financialPlan,
  sourceKey,
} from '../legacy-import-financial/fixture.js';
import type {
  FinancialSourceCommand,
  LegacyImportFinancialTransport,
} from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';
import { sourceOrderReceiptSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import {
  financialImportOrderBindings,
  financialImportSourceReceipts,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import {
  automaticCouponContract,
  complementaryContract,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import type { CsvBenefitProfileOptions } from '../../src/modules/legacy-order-imports/benefit-profile/adapter.js';

export async function benefitFinancialFixture(template: string) {
  const f = await importFinancialFixture(template),
    verified = verifiedMysqlFixture(f.connection, [
      'evidence/mysql-import-benefit-profile-schema.json',
      'evidence/mysql-customer-contact-schema.json',
      'evidence/mysql-global-benefits-schema.json',
      'evidence/mysql-import-coupon-country-schema.json',
    ]),
    tables = [
      'coupons',
      'coupon_countries',
      'coupons_users',
      'order_coupon_log',
      'order_freebies',
      'order_freebie_triggers',
      'order_cancel_message_mapping',
    ];
  try {
    await verified.create(tables);
    for (const path of [
      'migrations/0002_auth_sessions.sql',
      'src/modules/administration/migration.sql',
      'src/modules/legacy-order-imports/correction-migration.sql',
      'src/modules/legacy-order-imports/correction-command-migration.sql',
      'compatibility/upstream/legacy-order-imports/benefit-profile/migration.sql',
    ])
      for (const statement of splitMigration(readFileSync(path, 'utf8')))
        await f.connection.query(statement);
    await f.connection.query(
      readFileSync(
        'compatibility/upstream/legacy-order-imports/benefit-profile/complementary-schema.review.sql',
        'utf8',
      )
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n'),
    );
  } catch (error: unknown) {
    await f.close();
    throw error;
  }
  async function reset() {
    for (const table of [
      ...tables,
      'pos_rewrite_import_birthday_guards',
      'pos_rewrite_import_birthday_claims',
      'pos_rewrite_import_corrections',
      'pos_rewrite_import_correction_commands',
      'pos_rewrite_sessions',
      'pos_rewrite_operator_checkins',
    ])
      await f.connection.query('DELETE FROM `' + table + '`');
    await f.reset();
    await f.connection.query(
      "UPDATE users SET email='fixture@example.test',birthdate='1990-06-10' WHERE id=77",
    );
    await f.connection.query(
      'UPDATE products SET price=25.49,spl_price=0 WHERE id=9007199254740993',
    );
    await f.fixture.insert('products', {
      id: '9007199254740994',
      price: 17.83,
      spl_price: 0,
      prod_type: 4,
      parent_prod_id: 0,
    });
    await f.fixture.insert('product_stocks', {
      prod_id: '9007199254740994',
      parent_prod_id: 0,
      stock: 100,
      stocked: 0,
    });
    await f.fixture.insert('product_store', {
      id: '2',
      product_id: '9007199254740994',
      store_id: '1',
      stock: 100,
      is_avail: 1,
      is_del: 0,
    });
    await verified.insert('coupons', {
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
    await verified.insert('coupons_users', {
      id: '9007199254741500',
      user_id: 77,
      c_id: 222,
      coupon_allowed_count: 5,
      coupon_used_count: 0,
      coupon_month_allowed_count: 5,
    });
    await f.connection.query('ALTER TABLE has_products AUTO_INCREMENT=9007199254741001');
    await f.connection.query('ALTER TABLE order_freebies AUTO_INCREMENT=9007199254741300');
    await f.connection.query(
      "INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,expires_at,checked_in_at) VALUES('1',1,2,'2099-01-01 00:00:00','2026-06-15 12:00:00')",
    );
  }
  function plan(kind: 'offline' | 'shopify' = 'shopify') {
    const value = financialPlan(kind);
    value.email = 'fixture@example.test';
    value.lines = [
      { productId: '9007199254740993', quantity: 2, unitPrice: '25.49', sourceRows: [2] },
      { productId: '9007199254740994', quantity: 3, unitPrice: '17.83', sourceRows: [3] },
    ];
    value.originalTenderAmount = '104.47';
    if (value.kind === 'shopify') {
      value.declaredSubtotal = '50.98';
      value.declaredTotal = '50.00';
    }
    return value;
  }
  function driver(command: FinancialSourceCommand, mode?: 'consume' | 'preview', hash?: string) {
    const raw: unknown = JSON.parse(
      execFileSync(
        'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
        ['-B', 'tools/legacy-import-benefits/financial_driver.py'],
        {
          input: JSON.stringify({
            url: f.config.MYSQL_WRITER_URL,
            state: command.state,
            plan: command.plan,
            key: sourceKey,
            guardKey: 'isolated-financial-benefit-guard-'.repeat(3),
            now: financialClock,
            mode,
            confirmationHash: hash,
          }),
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 1000000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        },
      ),
    );
    const result = z
      .object({
        ok: z.boolean(),
        result: z.unknown().optional(),
        code: z.string().optional(),
        nativeCode: z.number().nullable().optional(),
        frames: z.array(z.string().regex(/^[A-Za-z0-9_.<>-]+:\d+$/)).optional(),
      })
      .parse(raw);
    if (!result.ok)
      throw new Error(
        'Pinned financial benefit fixture refused: ' +
          JSON.stringify({
            code: result.code,
            nativeCode: result.nativeCode,
            frames: result.frames,
          }),
      );
    return result.result;
  }
  function calculation(command: FinancialSourceCommand) {
    return z
      .object({
        payable: z.string().regex(/^\d+\.\d{2}$/),
        couponAmount: z.string().regex(/^\d+\.\d{2}$/),
      })
      .parse(driver(command, 'preview'));
  }
  function transport() {
    const ordinary = f.transport(),
      calls = { order: 0, confirmation: 0, publication: 0 },
      failures: string[] = [];
    const result: LegacyImportFinancialTransport = {
      assertReady() {},
      async order(command) {
        calls.order++;
        const computed = calculation(command);
        await f.fixture.insert('orders', {
          id: 5001,
          user_id: 77,
          created_at: command.plan.createdAt,
          updated_at: command.plan.createdAt,
          payment_method: command.plan.kind === 'offline' ? 14 : 15,
          payment_status: command.plan.kind === 'offline' ? 0 : 1,
          order_status: command.plan.kind === 'offline' ? 0 : 1,
          pay_amt: command.plan.kind === 'offline' ? computed.payable : command.plan.declaredTotal,
          order_amt: 50.98,
          coupon_used: command.plan.kind === 'offline' ? 222 : 0,
          coupon_amt_used: command.plan.kind === 'offline' ? computed.couponAmount : 0,
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
          location_id: 0,
          order_ref_no: 'FIXTURE-REF',
        });
        await f.fixture.insert('order_stores', {
          id: 1,
          order_id: 5001,
          store_id: 1,
          counter_id: 2,
          offline_payment: 0,
          offline_payment_recieved: 0,
          online_payment: 0,
          online_other_payment: 0,
          is_manually_paid: 0,
        });
        let value: z.infer<typeof sourceOrderReceiptSchema>;
        try {
          value = z.object({ order: sourceOrderReceiptSchema }).parse(driver(command)).order;
        } catch (error: unknown) {
          failures.push(
            error instanceof Error &&
              error.message.startsWith('Pinned financial benefit fixture refused: ')
              ? error.message
              : error instanceof z.ZodError
                ? 'FIXTURE_SCHEMA:' + error.issues.map((issue) => issue.code).join(',')
                : 'NATIVE_FIXTURE_INVALID',
          );
          throw error;
        }
        await f.db.get('writer').transaction(async (tx) => {
          await tx.insert(financialImportSourceReceipts).values({
            id: command.state.scope.operationId + ':order',
            operationId: command.state.scope.operationId,
            kind: 'order',
            status: 'completed',
            requestHash: command.state.requestHash,
            proof: value,
            proofHash: financialSourceHash(sourceKey, 'order', value),
            createdAt: financialClock,
          });
          await tx.insert(financialImportOrderBindings).values({
            orderId: value.orderId,
            operationId: command.state.scope.operationId,
            requestHash: command.state.requestHash,
            proofHash: financialSourceHash(sourceKey, 'order', value),
            status: 'held',
          });
        });
      },
      async confirm(command, order, customer) {
        calls.confirmation++;
        await ordinary.confirm(command, order, customer);
        await f.connection.query(
          'UPDATE product_store SET stock=99 WHERE product_id=9007199254740994',
        );
        const [confirmation] = await f.db
          .get('writer')
          .select()
          .from(financialImportSourceReceipts)
          .where(
            and(
              eq(financialImportSourceReceipts.operationId, command.state.scope.operationId),
              eq(financialImportSourceReceipts.kind, 'confirmation'),
            ),
          );
        if (!confirmation) throw new Error('Native confirmation fixture missing.');
        driver(command, 'consume', confirmation.proofHash);
      },
      async publication(command, order) {
        calls.publication++;
        await ordinary.publication(command, order);
      },
    };
    return { transport: result, calls, failures };
  }
  return {
    ...f,
    reset,
    plan,
    transport,
    calculation,
    benefits: {
      automaticCoupon: automaticCouponContract,
      complementary: complementaryContract,
      sourceProofKey: sourceKey,
    } satisfies CsvBenefitProfileOptions,
  };
}
