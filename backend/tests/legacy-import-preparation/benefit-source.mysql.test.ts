import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { splitMigration } from '../../src/db/migrations.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { publicScreeningFixture } from '../public-screening-writer/native-fixture.js';
import { sourceKey } from '../legacy-import-financial/fixture.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { financialAdapterProfiles } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { readSourceOrderReceipt } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import { sourceOrderPreparation } from '../../src/modules/legacy-order-imports/source-order-preparation.js';
import { readSourceOrderPreparationOptions } from '../../src/modules/legacy-order-imports/source-order-preparation-options.js';
import {
  couponHistoryWriterDefinitions,
  couponHistoryWritersReviewSql,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-writers.js';
import { couponHistoryControlHeadHash } from '../../src/modules/legacy-order-imports/benefit-profile/bridge.js';
import {
  couponHistoryHash,
  type QualifiedCouponHistory,
  type CsvCouponHistoryPort,
} from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import {
  automaticCouponReceiptSchema,
  posComplementaryReceiptSchema,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { legacyOrderImportService } from '../../src/modules/legacy-order-imports/service.js';
import { legacyOrderImportCorrections } from '../../src/modules/legacy-order-imports/correction-repository.js';
import { financialImportCorrectionBoundary } from '../../src/modules/legacy-order-imports/financial-adapter-correction-boundary.js';
import { legacyOrderImportFinancialApprovals } from '../../src/modules/legacy-order-imports/financial-adapter-approval.js';
import {
  legacyOrderImportRows,
  legacyOrderImports,
} from '../../src/modules/legacy-order-imports/schema.js';
import { readLegacyOrderImportOptions } from '../../src/modules/legacy-order-imports/options.js';
import { correctionActor, correctionCommand } from '../import-corrections/fixture.js';
import { runtimeImportInput } from '../legacy-order-imports/runtime-fixture.js';
import type {
  ImportFinancialStart,
  ImportFinancialResult,
} from '../../src/modules/legacy-order-imports/financial-contracts.js';

const template = process.env.SOURCE_BENEFITS_MYSQL_TEST_URL,
  authKey = 'fixture-source-selected-benefit-auth-'.repeat(2),
  historyKey = 'fixture-source-selected-benefit-history-'.repeat(2),
  guardKey = 'fixture-source-selected-benefit-guard-'.repeat(2),
  folder = 'compatibility/upstream/legacy-order-imports/benefit-profile';
describe.skipIf(!template)(
  'selected benefits in actual private source preparation/final order',
  () => {
    let f: Awaited<ReturnType<typeof publicScreeningFixture>>,
      extra: ReturnType<typeof verifiedMysqlFixture>;
    const tables = [
      'coupons',
      'coupons_users',
      'coupon_countries',
      'order_coupon_log',
      'order_freebies',
      'order_freebie_triggers',
    ];
    beforeAll(async () => {
      f = await publicScreeningFixture(template!);
      extra = verifiedMysqlFixture(f.connection, [
        'evidence/mysql-import-benefit-profile-schema.json',
        'evidence/mysql-global-benefits-schema.json',
        'evidence/mysql-customer-contact-schema.json',
        'evidence/mysql-import-coupon-country-schema.json',
      ]);
      await extra.create(tables);
      for (const file of [
        'src/modules/legacy-order-imports/preparation-migration.sql',
        folder + '/migration.sql',
        'migrations/0002_auth_sessions.sql',
        'src/modules/legacy-order-imports/correction-migration.sql',
        'src/modules/legacy-order-imports/correction-command-migration.sql',
      ])
        for (const statement of splitMigration(readFileSync(file, 'utf8')))
          await f.connection.query(statement);
      for (const statement of splitMigration(
        couponHistoryWritersReviewSql().split('DELIMITER $$')[0]!,
      ))
        await f.connection.query(statement);
      for (const row of couponHistoryWriterDefinitions)
        await f.connection.query(
          `CREATE TRIGGER ${row.name} AFTER ${row.event} ON ${row.table} FOR EACH ROW ${row.statement}`,
        );
      await f.connection.query(
        "ALTER TABLE has_products MODIFY type ENUM('REGULAR','JIT','PRE_ORDER','MTO','FREEBIE') NULL DEFAULT NULL",
      );
    }, 30000);
    afterAll(async () => {
      await f?.close();
    });
    beforeEach(async () => {
      for (const table of [
        ...tables,
        'pos_rewrite_import_birthday_claims',
        'pos_rewrite_import_birthday_guards',
        'pos_rewrite_import_financial_preparations',
        'pos_rewrite_import_corrections',
        'pos_rewrite_import_correction_commands',
        'pos_rewrite_sessions',
      ])
        await f.connection.query('DELETE FROM `' + table + '`');
      await f.reset();
      await f.connection.query('ALTER TABLE has_products AUTO_INCREMENT=9007199254741001');
      await f.connection.query('ALTER TABLE order_freebies AUTO_INCREMENT=9007199254741300');
      await f.fixture.insert('products_gs1', {
        id: 1,
        product_id: '9007199254740993',
        gtin: '9007199254740993',
      });
      await f.fixture.insert('user_eav', {
        entity: 'private-import@example.test',
        attribute: 'EXCLUSIVE_MEMBER',
        value: '1',
        is_active: 1,
      });
      await f.connection.query("UPDATE users SET birthdate='1990-06-10' WHERE id=77");
      await f.connection.query(
        'UPDATE products SET price=25,spl_price=0,cog=0 WHERE id=9007199254740993',
      );
      await extra.insert('coupons', {
        id: 222,
        voucher_code: 'SYNTHETIC_BIRTHDAY',
        voucher_type: '1',
        voucher_val: 0,
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
      await f.connection.query(
        "INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision) VALUES('controls','0',101),('coupon','222',102),('customer','77',103) ON DUPLICATE KEY UPDATE revision=VALUES(revision),last_owner_nonce=NULL,owner_start_revision=NULL",
      );
    });
    async function execute(
      options: {
        percent?: number;
        noReader?: boolean;
        changedControls?: boolean;
        lateClockAdvance?: number;
        couponActive?: boolean;
        free?: boolean;
        freeQuantity?: number;
        freeStock?: number;
        shopify?: boolean;
        lineItems?: boolean;
        couponSelected?: boolean;
        input?: ImportFinancialStart;
        runWith?: (
          adapter: ReturnType<typeof legacyOrderImportFinancialAdapter>,
        ) => Promise<ImportFinancialResult>;
      } = {},
    ) {
      if (options.percent !== undefined)
        await f.connection.query('UPDATE coupons SET voucher_val=? WHERE id=222', [
          options.percent,
        ]);
      const input = options.input ?? f.input();
      if (options.shopify) {
        const { financialPlan } = await import('../legacy-import-financial/fixture.js');
        Object.assign(input, f.input(financialPlan('shopify')));
        if (input.plan.kind === 'shopify') input.plan.discountAmount = '5.00';
        input.planHash = (
          await import('../../src/modules/legacy-order-imports/financial-adapter-crypto.js')
        ).expectedFinancialPlanHash(f.options.secret, input, input.plan);
      }
      if (options.free) {
        input.plan.lines.push({
          productId: '9007199254740994',
          quantity: options.freeQuantity ?? 3,
          unitPrice: '17.00',
          sourceRows: [3],
        });
        input.plan.originalTenderAmount = '50.00';
        input.planHash = (
          await import('../../src/modules/legacy-order-imports/financial-adapter-crypto.js')
        ).expectedFinancialPlanHash(f.options.secret, input, input.plan);
        await f.fixture.insert('products', {
          id: '9007199254740994',
          price: 17,
          spl_price: 0,
          cog: 0,
          prod_type: 4,
          parent_prod_id: 0,
        });
        await f.fixture.insert('products_gs1', {
          id: 2,
          product_id: '9007199254740994',
          gtin: '9007199254740994',
        });
        await f.fixture.insert('product_store', {
          id: 4,
          product_id: '9007199254740994',
          store_id: 1,
          stock: options.freeStock ?? 1,
          is_avail: 1,
          is_del: 0,
        });
      }
      const phases: string[] = [],
        diagnostics: unknown[] = [],
        financial = {
          ...f.options,
          correctionContract: 'pos-import-manager-correction-v1' as const,
          sourceAuthKey: authKey,
          sourceUrl: 'https://private.invalid/internal/pos/legacy-order-imports',
        },
        marker = {
          ...(options.couponSelected === false
            ? {}
            : { automaticCoupon: 'pos-csv-automatic-coupon-v1' as const }),
          ...(options.free ? { complementary: 'pos-csv-pos-complementary-v1' as const } : {}),
        };
      function invoke(operationId: string, body: unknown, phase: 'order' | 'preparation') {
        phases.push(phase);
        const result: unknown = JSON.parse(
          execFileSync(
            resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
            ['-B', resolve('tools/legacy-import-benefits/pipeline_native_driver.py')],
            {
              input: JSON.stringify({
                url: f.config.MYSQL_WRITER_URL,
                sourceRoot:
                  process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ?? resolve('../../backend-tss-api_v2'),
                operationId,
                body,
                phase,
                authKey,
                proofKey: sourceKey,
                historyKey,
                guardKey,
                correctionContract: financial.correctionContract,
                now: f.options.clock!(),
                changedControls: phase === 'order' && options.changedControls,
                lateClockAdvance: phase === 'order' ? options.lateClockAdvance : undefined,
                couponActive: options.couponActive,
                lineItems: options.lineItems,
                freeProducts: options.free ? ['9007199254740994'] : [],
              }),
              encoding: 'utf8',
              maxBuffer: 20000,
              timeout: 20000,
            },
          ),
        );
        if (
          z.object({ code: z.string() }).safeParse(result).success ||
          z.object({ sourceErrors: z.array(z.unknown()).min(1) }).safeParse(result).success
        )
          diagnostics.push(result);
        return result;
      }
      const fetcher: typeof fetch = async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body)),
          { capability } = z
            .object({ capability: z.object({ operationId: z.string() }).passthrough() })
            .passthrough()
            .parse(body);
        return Response.json(invoke(capability.operationId, body, 'preparation'));
      };
      const read = vi.fn<CsvCouponHistoryPort['read']>(async (scope, request) => {
        const body: Omit<QualifiedCouponHistory, 'signature'> = {
          scope,
          reader: 'bigquery',
          generationId: 'd'.repeat(64),
          complete: true,
          fetchedAt: f.options.clock!(),
          publication: {
            sourceCaptureHash: 'e'.repeat(64),
            controlHeadHash: couponHistoryControlHeadHash(scope, request!.witness, sourceKey),
            queryContract: 'pos-source-coupon-selects-2960-v1',
            seal: 'f'.repeat(64),
          },
          globalUsage: '0',
          birthdayTodayUsage: '0',
          customerOrderCount: '0',
          monthlyJoinedUsage: '0',
          lotCounts: [],
        };
        return { ...body, signature: couponHistoryHash(body, historyKey) };
      });
      const prepare = sourceOrderPreparation(
        f.config,
        financial,
        readSourceOrderPreparationOptions({
          UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT: 'pos-import-order-preparation-v1',
          CSV_COUPON_HISTORY_KEY: historyKey,
          CSV_COUPON_GUARD_KEY: guardKey,
        }),
        { fetcher, ...(!options.noReader ? { couponHistoryReader: { read } } : {}) },
      );
      const transport = f.transport();
      transport.order = async (command) => {
        const cap = {
          contract: 'pos-legacy-order-import-source-v1',
          phase: 'order',
          operationId: command.state.scope.operationId,
          requestHash: command.state.requestHash,
          planHash: command.state.planHash,
          namespace: command.state.namespace,
          planDigest: financialSourceHash(authKey, 'plan', command.plan),
          scope: command.state.scope,
          authority: command.state.authority,
          orderId: null,
          nonce: command.nonce,
          issuedAt: command.issuedAt,
          expiresAt: Math.min(
            command.expiresAt,
            command.couponHistory?.capability.expiresAt ?? command.expiresAt,
          ),
          preparationContract: command.state.preparationContract,
          benefitContracts: command.state.benefitContracts,
          ...(command.state.correction
            ? {
                correctionHash: financialSourceHash(
                  authKey,
                  'correction',
                  command.state.correction,
                ),
              }
            : {}),
          ...(command.couponHistory
            ? {
                couponHistoryHash: financialSourceHash(
                  authKey,
                  'coupon-history',
                  command.couponHistory,
                ),
              }
            : {}),
        };
        invoke(
          input.operationId,
          {
            capability: { ...cap, signature: financialSourceHash(authKey, 'capability', cap) },
            plan: command.plan,
            ...(command.couponHistory ? { couponHistory: command.couponHistory } : {}),
          },
          'order',
        );
      };
      transport.confirm = async () => {
        throw new Error('Fixture stops before provider/Go/stock/payment');
      };
      const adapter = legacyOrderImportFinancialAdapter(
        f.config,
        f.db,
        financial,
        transport,
        financialAdapterProfiles({ benefits: { ...marker, sourceProofKey: sourceKey } }),
        prepare,
      );
      const result = options.runWith ? await options.runWith(adapter) : await adapter.start(input);
      return { result, input, phases, diagnostics, read, adapter };
    }
    it('prefetches only after literal eligibility and seals one real source/native coupon descriptor with no broker/payment', async () => {
      const run = await execute();
      expect(run.diagnostics).toEqual([]);
      expect(run.phases).toEqual(['preparation', 'preparation', 'order']);
      expect(run.read).toHaveBeenCalledOnce();
      expect(run.result, JSON.stringify(run.result)).toMatchObject({
        status: 'unknown',
        stage: 'confirmation',
      });
      const order = await f.db
        .get('writer')
        .transaction((tx) => readSourceOrderReceipt(tx, run.input.operationId, sourceKey));
      expect(order).toMatchObject({ payable: '50.00', method: 14 });
      const [rows] = await f.connection.query(
        "SELECT proof FROM pos_rewrite_import_financial_source_receipts WHERE kind='coupon-benefit'",
      );
      const descriptor = automaticCouponReceiptSchema.parse(
        z.array(z.object({ proof: z.unknown() })).parse(rows)[0]!.proof,
      );
      expect(descriptor.headerCouponId).toBe('222');
      expect(descriptor.allocations).toHaveLength(1);
      expect(descriptor.allocations[0]?.quantity).toBe(2);
      expect(descriptor.birthdayClaim.id).toMatch(/^[a-f0-9-]{36}$/);
      const [flags] = await f.connection.query(
        'SELECT payment_status,is_stock_reduced FROM orders',
      );
      expect(flags).toEqual([{ payment_status: 0, is_stock_reduced: 0 }]);
    });
    it('makes unavailable history a native local preparation failure before any order nonce or claim exists', async () => {
      const run = await execute({ noReader: true });
      expect(run.phases).toEqual(['preparation']);
      expect(run.result).toMatchObject({
        status: 'rejected',
        code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
      });
      const [rows] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM pos_rewrite_import_birthday_claims) AS claims,(SELECT COUNT(*) FROM pos_rewrite_import_financial_stages) AS stages',
      );
      expect(rows).toEqual([{ orders: '0', claims: '0', stages: '0' }]);
    });
    it('retains declared tender mismatch as a real signed no-effect source calculation and rolls back its provisional claim', async () => {
      const run = await execute({ percent: 10 });
      expect(run.diagnostics).toEqual([]);
      expect(run.result).toMatchObject({
        status: 'rejected',
        code: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
      });
      const [rows] = await f.connection.query(
        "SELECT status,proof FROM pos_rewrite_import_financial_source_receipts WHERE kind='order'",
      );
      expect(
        z
          .array(
            z.object({
              status: z.string(),
              proof: z
                .object({
                  noFinancialEffects: z.literal(true),
                  code: z.literal('ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH'),
                  review: z
                    .object({
                      calculation: z.object({
                        payable: z.literal('45.00'),
                        profileQualified: z.literal(true),
                      }),
                    })
                    .passthrough(),
                })
                .passthrough(),
            }),
          )
          .parse(rows)[0]?.status,
      ).toBe('rejected');
      const [counts] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM pos_rewrite_import_birthday_claims) AS claims',
      );
      expect(counts).toEqual([{ orders: '0', claims: '0' }]);
    });
    it.each([{ changedControls: true }, { lateClockAdvance: 60000 }])(
      'rolls back changed control/head or expired copied capsule: %j',
      async (options) => {
        const run = await execute(options);
        expect(run.result.status).toBe('rejected');
        const [rows] = await f.connection.query(
          'SELECT (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM has_products) AS hp,(SELECT COUNT(*) FROM pos_rewrite_import_birthday_claims) AS claims',
        );
        expect(rows).toEqual([{ orders: '0', hp: '0', claims: '0' }]);
      },
    );
    it('does not need warehouse publication when the literal automatic flag is disabled', async () => {
      const run = await execute({ couponActive: false, noReader: true });
      expect(run.diagnostics).toEqual([]);
      expect(run.phases).toEqual(['preparation', 'order']);
      expect(run.read).not.toHaveBeenCalled();
      expect(run.result, JSON.stringify(run.result)).toMatchObject({
        status: 'unknown',
        stage: 'confirmation',
      });
    });
    it.each([false, true])(
      'composes exact original POS type4 selection, actual FREEBIE HP/grant and coupon descriptors (per-unit=%s)',
      async (lineItems) => {
        const run = await execute({ free: true, lineItems });
        expect(run.diagnostics).toEqual([]);
        expect(run.result, JSON.stringify(run.result)).toMatchObject({
          status: 'unknown',
          stage: 'confirmation',
        });
        const [rows] = await f.connection.query(
          "SELECT proof FROM pos_rewrite_import_financial_source_receipts WHERE kind='pos-complement'",
        );
        const descriptor = posComplementaryReceiptSchema.parse(
          z.array(z.object({ proof: z.unknown() })).parse(rows)[0]!.proof,
        );
        expect(descriptor.selections).toHaveLength(1);
        expect(descriptor.selections[0]?.line).toMatchObject({
          productId: '9007199254740994',
          quantity: 1,
          type: 'FREEBIE',
        });
        expect(descriptor.selections[0]?.line.id).toBe(
          lineItems ? '9007199254741003' : '9007199254741002',
        );
        expect(descriptor.selections[0]?.grant.id).toBe('9007199254741300');
        expect(descriptor.selections[0]?.priceRule).toBe(
          lineItems ? 'source-zero-per-unit' : 'source-base-aggregate',
        );
        expect(descriptor.selections[0]?.line.refundable).toBe(lineItems ? '0.00' : '12.69');
        expect(descriptor.selections[0]?.grant).toMatchObject({
          level: 'POS_MANUAL',
          triggerKey: 'pos_manual:0',
          status: 'ACTIVE',
        });
      },
    );
    it('runs complementary-only selection without a coupon provider or history witness', async () => {
      const run = await execute({
        free: true,
        lineItems: true,
        couponActive: false,
        couponSelected: false,
        noReader: true,
      });
      expect(run.diagnostics).toEqual([]);
      expect(run.phases).toEqual(['preparation', 'order']);
      expect(run.read).not.toHaveBeenCalled();
      expect(run.result, JSON.stringify(run.result)).toMatchObject({
        status: 'unknown',
        stage: 'confirmation',
      });
      const [rows] = await f.connection.query(
        'SELECT kind FROM pos_rewrite_import_financial_source_receipts ORDER BY kind',
      );
      expect(rows).toEqual([{ kind: 'order' }, { kind: 'pos-complement' }]);
    });
    it('keeps Shopify stock authority on the original declared quantity even when the actual free HP is one', async () => {
      const run = await execute({
        free: true,
        shopify: true,
        freeQuantity: 3,
        freeStock: 1,
        couponActive: false,
      });
      expect(run.diagnostics).toEqual([]);
      expect(run.result).toMatchObject({ status: 'rejected', code: 'ORDER_IMPORT_STOCK_SHORTAGE' });
      const [rows] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM order_freebies) AS grants',
      );
      expect(rows).toEqual([{ orders: '0', grants: '0' }]);
    });
    it('uses the actual rejected source calculation, manager attestation and required approval before creating a corrected discounted source order', async () => {
      const correctionOptions = {
          ...f.options,
          correctionContract: 'pos-import-manager-correction-v1' as const,
        },
        corrections = legacyOrderImportCorrections(f.db, f.config, {
          secret: f.options.secret,
          contract: correctionOptions.correctionContract,
          clock: f.options.clock,
          boundary: financialImportCorrectionBoundary({
            secret: f.options.secret,
            sourceProofKey: sourceKey,
          }),
        }),
        queue = legacyOrderImportRepository(f.db, {
          secret: f.options.secret,
          now: f.options.clock,
          correctionForOperation: corrections.correctionForOperation,
        }),
        upload = runtimeImportInput(),
        session = await mysqlSessions(f.db).create('1', Date.parse('2099-01-01T00:00:00Z'));
      await queue.stage('1', 'fixture-original-birthday-upload', upload);
      const [originalRow] = await f.db
        .get('writer')
        .select()
        .from(legacyOrderImportRows)
        .where(eq(legacyOrderImportRows.jobId, upload.id));
      expect(originalRow).toBeDefined();
      const original = await queue.financialContext('1', upload.id, originalRow!.operationId);
      const rejected = await execute({
        percent: 10,
        input: original,
        runWith: async (adapter) => {
          await queue.runOne(adapter);
          const result = await adapter.read(original);
          if (!result) throw new Error('The original financial outcome must remain available.');
          return result;
        },
      });
      expect(rejected.diagnostics).toEqual([]);
      expect(rejected.result).toMatchObject({
        status: 'rejected',
        code: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
      });
      const review = await corrections.review(
        correctionActor,
        upload.id,
        original.operationId,
        session.sessionId,
      );
      expect(review).toMatchObject({
        eligible: true,
        calculation: { payable: '45.00', profileQualified: true, profileCode: null },
      });
      const command = correctionCommand(review.reviewHash!, '45.00'),
        receipt = await corrections.create(
          correctionActor,
          upload.id,
          original.operationId,
          command,
          session.sessionId,
          'fixture-coupon-correction',
        );
      expect(receipt).toMatchObject({ historicalTenderAmount: '45.00', requiresApproval: true });
      const successor = await queue.financialContext(
        '1',
        command.successorJobId,
        command.successorOperationId,
      );
      expect(successor.plan.originalTenderAmount).toBe('50.98');
      expect(successor.plan.lines).toEqual(original.plan.lines);
      const corrected = await execute({
        input: successor,
        runWith: async (adapter) => {
          await f.db.get('writer').transaction(async (tx) => {
            expect(await adapter.authorizeStart!(tx, successor)).toEqual({
              ready: false,
              code: 'ORDER_IMPORT_APPROVAL_REQUIRED',
            });
          });
          const approvals = legacyOrderImportFinancialApprovals(f.config, f.db, correctionOptions),
            service = legacyOrderImportService(f.config, f.db, {
              runtime: readLegacyOrderImportOptions({
                LEGACY_ORDER_IMPORT_CONTRACT: 'pos-legacy-order-import-v1',
                LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: f.options.secret,
              }),
              adapter,
              approvals,
              corrections,
              correctionForOperation: corrections.correctionForOperation,
            });
          const approval = await service.requestApproval(
            correctionActor,
            command.successorJobId,
            command.successorOperationId,
            { commandId: randomUUID(), reason: 'historical-correction' },
          );
          expect(approval.review.correction).toEqual({
            id: command.id,
            historicalTenderAmount: '45.00',
            sourcePayable: '45.00',
          });
          await f.db
            .get('writer')
            .update(legacyOrderImports)
            .set({ leaseUntil: sql`TIMESTAMP('2026-06-14 00:00:00')` })
            .where(eq(legacyOrderImports.id, command.successorJobId));
          await queue.runOne(adapter);
          const result = await adapter.read(successor);
          if (!result) throw new Error('The corrected financial outcome must remain available.');
          return result;
        },
      });
      expect(corrected.diagnostics).toEqual([]);
      expect(corrected.result, JSON.stringify(corrected.result)).toMatchObject({
        status: 'unknown',
        stage: 'confirmation',
      });
      const order = await f.db
        .get('writer')
        .transaction((tx) => readSourceOrderReceipt(tx, successor.operationId, sourceKey));
      expect(order).toMatchObject({ method: 14, payable: '45.00' });
      const [retained] = await f.db
        .get('writer')
        .select()
        .from(legacyOrderImportRows)
        .where(eq(legacyOrderImportRows.operationId, original.operationId));
      expect(retained).toMatchObject({
        state: 'FAILED',
        orderId: null,
        errorCode: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
      });
      expect(corrected.phases).toEqual(['preparation', 'preparation', 'order']);
    }, 20000);
  },
);
