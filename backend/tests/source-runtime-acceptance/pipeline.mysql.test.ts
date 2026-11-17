import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publicScreeningFixture } from '../public-screening-writer/native-fixture.js';
import { sourceKey } from '../legacy-import-financial/fixture.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { readSourceOrderReceipt } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import { splitMigration } from '../../src/db/migrations.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { financialAdapterProfiles } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import { sourceOrderPreparation } from '../../src/modules/legacy-order-imports/source-order-preparation.js';
import { readSourceOrderPreparationOptions } from '../../src/modules/legacy-order-imports/source-order-preparation-options.js';
import { z } from 'zod';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const authKey = 'fixture-actual-pipeline-source-authority-'.repeat(3);
describe.skipIf(!template)(
  'literal private catalog→Cart→Validate→Processing→PosOrder native boundary',
  () => {
    let f: Awaited<ReturnType<typeof publicScreeningFixture>>;
    beforeAll(async () => {
      f = await publicScreeningFixture(template!);
      for (const sql of splitMigration(
        readFileSync('src/modules/legacy-order-imports/preparation-migration.sql', 'utf8'),
      ))
        await f.connection.query(sql);
    }, 30000);
    beforeEach(async () => {
      await f.connection.query('DELETE FROM pos_rewrite_import_financial_preparations');
      await f.reset();
      await f.fixture.insert('products_gs1', {
        id: 1,
        product_id: '9007199254740993',
        gtin: '8900000000001',
      });
      await f.fixture.insert('user_eav', {
        entity: 'private-import@example.test',
        attribute: 'EXCLUSIVE_MEMBER',
        value: '1',
        is_active: 1,
      });
      await f.connection.query(
        'UPDATE products SET price=25,cog=0,spl_price=0 WHERE id=9007199254740993',
      );
    });
    afterAll(async () => {
      await f?.close();
    });
    it('runs actual selected rollback-only preview before dispatch, with no BQ dependency for an active member', async () => {
      const phases: string[] = [],
        previewDiagnostics: unknown[] = [];
      function invoke(operationId: string, body: unknown, phase: 'order' | 'preparation') {
        phases.push(phase);
        return JSON.parse(
          execFileSync(
            resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
            ['-B', resolve('tools/source-runtime-acceptance/pipeline_native_driver.py')],
            {
              encoding: 'utf8',
              timeout: 20000,
              maxBuffer: 16000,
              input: JSON.stringify({
                url: f.config.MYSQL_WRITER_URL,
                sourceRoot:
                  process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ?? resolve('../../backend-tss-api_v2'),
                operationId,
                authKey,
                proofKey: sourceKey,
                now: f.options.clock!(),
                phase,
                body,
              }),
            },
          ),
        ) as unknown;
      }
      const options = {
        ...f.options,
        sourceAuthKey: authKey,
        sourceUrl: 'https://fixture.invalid/internal/pos/legacy-order-imports',
      };
      const fetcher: typeof fetch = async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body));
        const { capability } = z
          .object({ capability: z.object({ operationId: z.string() }).passthrough() })
          .passthrough()
          .parse(body);
        const result = invoke(capability.operationId, body, 'preparation');
        if (z.object({ code: z.string() }).safeParse(result).success)
          previewDiagnostics.push(result);
        return Response.json(result);
      };
      const prepare = sourceOrderPreparation(
        f.config,
        options,
        readSourceOrderPreparationOptions({
          UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT: 'pos-import-order-preparation-v1',
        }),
        { fetcher },
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
          expiresAt: command.expiresAt,
          preparationContract: command.state.preparationContract,
        };
        expect(
          invoke(
            command.state.scope.operationId,
            {
              capability: { ...cap, signature: financialSourceHash(authKey, 'capability', cap) },
              plan: command.plan,
            },
            'order',
          ),
        ).toMatchObject({ recorded: true, queueCalls: 0 });
      };
      // Stop at the next external boundary: this fixture proves source order,
      // never a synthetic Go/payment/stock completion certificate.
      transport.confirm = async () => {
        throw new Error('Fixture stops before financial provider');
      };
      const adapter = legacyOrderImportFinancialAdapter(
          f.config,
          f.db,
          options,
          transport,
          financialAdapterProfiles(),
          prepare,
        ),
        input = f.input();
      const started = await adapter.start(input);
      expect(previewDiagnostics).toEqual([]);
      expect([phases, started]).toEqual([
        ['preparation', 'order'],
        expect.objectContaining({ status: 'unknown', operationId: input.operationId }),
      ]);
      const [attempts] = await f.connection.query(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.phase')) AS phase FROM pos_rewrite_import_financial_preparations",
      );
      expect(attempts).toEqual([{ phase: 'DISPATCHED' }]);
      expect(
        await f.db
          .get('writer')
          .transaction((tx) => readSourceOrderReceipt(tx, input.operationId, sourceKey)),
      ).toMatchObject({ payable: '50.00' });
      const [header] = await f.connection.query(
        'SELECT payment_status,is_stock_reduced FROM orders',
      );
      expect(header).toEqual([{ payment_status: 0, is_stock_reduced: 0 }]);
    });
    for (const lateFailure of [false, true])
      it(`uses literal source processing with ${lateFailure ? 'atomic late rollback' : 'one exact source/native receipt'}`, async () => {
        const input = f.input(),
          journal = legacyImportFinancialJournal(f.config, f.db, f.options);
        await journal.reserve(input);
        const command = await journal.dispatch(input, 'order');
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
          expiresAt: command.expiresAt,
        };
        const result: unknown = JSON.parse(
          execFileSync(
            resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
            ['-B', resolve('tools/source-runtime-acceptance/pipeline_native_driver.py')],
            {
              encoding: 'utf8',
              timeout: 20000,
              maxBuffer: 16000,
              input: JSON.stringify({
                url: f.config.MYSQL_WRITER_URL,
                sourceRoot:
                  process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ?? resolve('../../backend-tss-api_v2'),
                operationId: input.operationId,
                authKey,
                proofKey: sourceKey,
                now: command.issuedAt,
                lateFailure,
                body: {
                  capability: {
                    ...cap,
                    signature: financialSourceHash(authKey, 'capability', cap),
                  },
                  plan: command.plan,
                },
              }),
            },
          ),
        ) as unknown;
        expect(result).toMatchObject({
          queueCalls: 0,
          trace: ['catalog', 'cart', 'catalog', 'cart', 'cart', 'validate', 'calculator', 'order'],
          recorded: true,
        });
        const [totals] = await f.connection.query(
          'SELECT (SELECT COUNT(*) FROM orders) AS header_count,(SELECT COUNT(*) FROM has_products) AS line_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_source_effects) AS effect_count',
        );
        expect(totals).toEqual([
          {
            header_count: lateFailure ? '0' : '1',
            line_count: lateFailure ? '0' : '1',
            effect_count: lateFailure ? '0' : '1',
          },
        ]);
        if (!lateFailure) {
          const proof = await f.db
            .get('writer')
            .transaction((tx) => readSourceOrderReceipt(tx, input.operationId, sourceKey));
          expect(proof).toMatchObject({
            payable: '50.00',
            lines: [{ productId: '9007199254740993', quantity: 2 }],
          });
          const [refund] = await f.connection.query(
            'SELECT amount_to_be_refunded FROM has_products',
          );
          expect(refund).toEqual([{ amount_to_be_refunded: 50 }]);
          const [effects] = await f.connection.query(
            'SELECT payload,status FROM pos_rewrite_import_financial_source_effects',
          );
          expect(effects).toMatchObject([{ status: 'pending' }]);
          expect(JSON.stringify(effects)).not.toContain('private-import@example.test');
        } else {
          const [receipts] = await f.connection.query(
            "SELECT status,proof FROM pos_rewrite_import_financial_source_receipts WHERE kind='order'",
          );
          expect(receipts).toMatchObject([
            {
              status: 'rejected',
              proof: { code: 'ORDER_IMPORT_FIXTURE_LATE_FAILURE', noFinancialEffects: true },
            },
          ]);
        }
      });
  },
);
