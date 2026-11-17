import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { sourceRejectionReceiptSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import { legacyOrderImportCorrections } from '../../src/modules/legacy-order-imports/correction-repository.js';
import { financialImportCorrectionBoundary } from '../../src/modules/legacy-order-imports/financial-adapter-correction-boundary.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { legacyOrderImportService } from '../../src/modules/legacy-order-imports/service.js';
import { legacyOrderImportFinancialApprovals } from '../../src/modules/legacy-order-imports/financial-adapter-approval.js';
import { readLegacyOrderImportOptions } from '../../src/modules/legacy-order-imports/options.js';
import { correctionActor, correctionCommand } from '../import-corrections/fixture.js';
import { runtimeImportInput } from '../legacy-order-imports/runtime-fixture.js';
import {
  benefitReceiptHash,
  couponActivationSchema,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { readSourceOrderReceipt } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import { assertNativeImportOrder } from '../../src/modules/legacy-order-imports/financial-adapter-writer.js';
import { financialAdapterProfiles } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import {
  financialImportProofs,
  financialImportSourceReceipts,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import {
  financialImportHash,
  financialSourceHash,
} from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { financialClock } from '../legacy-import-financial/fixture.js';
import { benefitFinancialFixture } from './financial-fixture.js';

const supplied = process.env.IMPORT_BENEFITS_MYSQL_TEST_URL,
  template = supplied
    ? (() => {
        const value = new URL(supplied);
        if (
          !['127.0.0.1', 'localhost'].includes(value.hostname) ||
          value.pathname !== '/pos_rewrite_integration'
        )
          throw new Error('Dedicated source-benefit timezone fixture required.');
        value.pathname = '/pos_rewrite_checkout_test';
        return value.href;
      })()
    : undefined;
describe.skipIf(!template)(
  'benefit profiles in the actual native financial adapter',
  { timeout: 20000 },
  () => {
    let f: Awaited<ReturnType<typeof benefitFinancialFixture>>;
    beforeAll(async () => {
      f = await benefitFinancialFixture(template!);
    }, 20000);
    beforeEach(async () => {
      await f.reset();
    });
    afterAll(async () => {
      await f?.close();
    });
    const profiles = () => financialAdapterProfiles({ benefits: f.benefits });
    it('completes source-proved Shopify coupon/POS selections with original plan stock and no consumption', async () => {
      const source = f.transport(),
        adapter = legacyOrderImportFinancialAdapter(
          f.config,
          f.db,
          f.options,
          source.transport,
          profiles(),
        ),
        input = f.input(f.plan());
      const result = await adapter.start(input);
      expect(source.failures).toEqual([]);
      expect(result.status).toBe('completed');
      expect(await adapter.start(input)).toEqual(result);
      expect(source.calls).toEqual({ order: 1, confirmation: 0, publication: 1 });
      const [proof] = await f.db.get('writer').select().from(financialImportProofs);
      expect(proof?.data.benefits).toMatchObject({
        coupon: { receipt: { consumption: 'shopify-none', headerCouponId: null } },
        complementary: { receipt: { origin: 'original-csv-pos-selection' } },
        activation: null,
        confirmationHash: null,
      });
      expect(proof?.data.order.lines.map((line) => line.quantity)).toEqual([2, 1]);
      const [stock] = await f.connection.query(
        'SELECT product_id,stock FROM product_store ORDER BY id',
      );
      expect(stock).toEqual([
        { product_id: '9007199254740993', stock: 98 },
        { product_id: '9007199254740994', stock: 97 },
      ]);
      const [outcomes] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM order_coupon_log) AS coupons,(SELECT COUNT(*) FROM pos_transaction_logs) AS payments',
      );
      expect(outcomes).toEqual([{ coupons: '0', payments: '0' }]);
    });
    it('keeps completed benefit evidence readable after flags/key/contact/catalog/counter/source-row changes', async () => {
      const source = f.transport(),
        input = f.input(f.plan()),
        adapter = legacyOrderImportFinancialAdapter(
          f.config,
          f.db,
          f.options,
          source.transport,
          profiles(),
        ),
        result = await adapter.start(input);
      expect(result.status).toBe('completed');
      await f.connection.query(
        "UPDATE users SET email='changed@example.test',is_block=1 WHERE id=77",
      );
      await f.connection.query('UPDATE coupons_users SET coupon_used_count=9');
      await f.connection.query('UPDATE products SET price=1000');
      await f.connection.query(
        "UPDATE pos_rewrite_import_financial_source_receipts SET proof='{}',proof_hash=REPEAT('0',64) WHERE kind IN ('coupon-benefit','pos-complement')",
      );
      const reader = legacyOrderImportFinancialAdapter(
        f.config,
        f.db,
        { secret: f.options.secret, clock: () => financialClock },
        source.transport,
      );
      expect(await reader.read(input)).toEqual(result);
      expect(await reader.start(input)).toEqual(result);
      expect(source.calls).toEqual({ order: 1, confirmation: 0, publication: 1 });
    });
    it('authenticates the outer financial HMAC before accepting a changed benefit snapshot', async () => {
      const source = f.transport(),
        input = f.input(f.plan()),
        adapter = legacyOrderImportFinancialAdapter(
          f.config,
          f.db,
          f.options,
          source.transport,
          profiles(),
        );
      expect((await adapter.start(input)).status).toBe('completed');
      const [row] = await f.db.get('writer').select().from(financialImportProofs);
      if (!row?.data.benefits) throw new Error('Expected benefit completion fixture.');
      const changed = {
        ...row.data,
        benefits: { ...row.data.benefits, confirmationHash: 'a'.repeat(64) },
      };
      await f.db
        .get('writer')
        .update(financialImportProofs)
        .set({ data: changed })
        .where(eq(financialImportProofs.id, row.id));
      await expect(adapter.read(input)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_RECEIPT_INVALID',
      });
      await f.db
        .get('writer')
        .update(financialImportProofs)
        .set({ proofHash: financialImportHash(f.options.secret, 'completed', changed) })
        .where(eq(financialImportProofs.id, row.id));
      await expect(adapter.read(input)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID',
      });
    });
    it('refuses a retained benefit descriptor with profiles disabled before any Go/settlement/publication', async () => {
      const source = f.transport(),
        input = f.input(f.plan()),
        adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, source.transport);
      await expect(adapter.start(input)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID',
      });
      expect(source.calls).toEqual({ order: 1, confirmation: 0, publication: 0 });
      expect(await f.db.get('writer').select().from(financialImportProofs)).toEqual([]);
      const [stock] = await f.connection.query('SELECT stock FROM product_store ORDER BY id');
      expect(stock).toEqual([{ stock: 100 }, { stock: 100 }]);
    });
    it('does not turn an authenticated benefit quantity map into an offline tender waiver', async () => {
      const source = f.transport(),
        input = f.input(f.plan('offline')),
        adapter = legacyOrderImportFinancialAdapter(
          f.config,
          f.db,
          f.options,
          source.transport,
          profiles(),
        );
      expect(await adapter.start(input)).toMatchObject({
        status: 'unknown',
        stage: 'order',
        orderId: '5001',
      });
      expect(source.calls).toEqual({ order: 1, confirmation: 0, publication: 0 });
      expect(await f.db.get('writer').select().from(financialImportProofs)).toEqual([]);
    });
    it.each(['kind', 'oversized', 'status'])(
      'refuses a changed %s purpose row rather than treating it as absent',
      async (mutation) => {
        const source = f.transport(),
          input = f.input(f.plan()),
          adapter = legacyOrderImportFinancialAdapter(
            f.config,
            f.db,
            f.options,
            source.transport,
            profiles(),
          ),
          original = source.transport.order;
        source.transport.order = async (command) => {
          await original(command);
          await f.db
            .get('writer')
            .update(financialImportSourceReceipts)
            .set(
              mutation === 'kind'
                ? { kind: 'COUPON-BENEFIT' }
                : mutation === 'status'
                  ? { status: 'changed' }
                  : { proof: { untrusted: 'x'.repeat(500001) } },
            )
            .where(
              and(
                eq(financialImportSourceReceipts.operationId, command.state.scope.operationId),
                eq(financialImportSourceReceipts.kind, 'coupon-benefit'),
              ),
            );
        };
        await expect(adapter.start(input)).rejects.toMatchObject({
          code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID',
        });
        expect(source.calls).toEqual({ order: 1, confirmation: 0, publication: 0 });
      },
    );
    it.each(['completed', 'missing-consumption', 'wrong-confirmation', 'changed-counter'])(
      'retains corrected cash once only with exact consumption proof (%s)',
      async (scenario) => {
        const options = {
            ...f.options,
            correctionContract: 'pos-import-manager-correction-v1' as const,
          },
          source = f.transport(),
          corrections = legacyOrderImportCorrections(f.db, f.config, {
            secret: options.secret,
            contract: options.correctionContract,
            clock: () => financialClock,
            boundary: financialImportCorrectionBoundary({
              secret: options.secret,
              sourceProofKey: f.benefits.sourceProofKey,
            }),
          }),
          queue = legacyOrderImportRepository(f.db, {
            secret: options.secret,
            now: () => financialClock,
            correctionForOperation: corrections.correctionForOperation,
          }),
          adapter = legacyOrderImportFinancialAdapter(
            f.config,
            f.db,
            options,
            {
              ...source.transport,
              async confirm(...args: Parameters<typeof source.transport.confirm>) {
                await source.transport.confirm(...args);
                const operationId = args[0].state.scope.operationId;
                if (scenario === 'missing-consumption')
                  await f.db
                    .get('writer')
                    .delete(financialImportSourceReceipts)
                    .where(
                      and(
                        eq(financialImportSourceReceipts.operationId, operationId),
                        eq(financialImportSourceReceipts.kind, 'coupon-consume'),
                      ),
                    );
                if (scenario === 'changed-counter')
                  await f.connection.query('UPDATE coupons_users SET coupon_used_count=2');
                if (scenario === 'wrong-confirmation') {
                  const [row] = await f.db
                    .get('writer')
                    .select()
                    .from(financialImportSourceReceipts)
                    .where(
                      and(
                        eq(financialImportSourceReceipts.operationId, operationId),
                        eq(financialImportSourceReceipts.kind, 'coupon-consume'),
                      ),
                    );
                  if (!row) throw new Error('Coupon fixture activation missing.');
                  const proof = {
                    ...couponActivationSchema.parse(row.proof),
                    sourceConfirmationHash: '0'.repeat(64),
                  };
                  await f.db
                    .get('writer')
                    .update(financialImportSourceReceipts)
                    .set({
                      proof,
                      proofHash: benefitReceiptHash(
                        'coupon-consumption',
                        proof,
                        f.benefits.sourceProofKey,
                      ),
                    })
                    .where(eq(financialImportSourceReceipts.id, row.id));
                }
              },
              async order(command) {
                if (command.state.correction) return source.transport.order(command);
                const computed = f.calculation(command),
                  calculation = {
                    payable: computed.payable,
                    profileQualified: true,
                    profileCode: null,
                    calculationHash: financialSourceHash(f.benefits.sourceProofKey, 'calculation', {
                      operationId: command.state.scope.operationId,
                      requestHash: command.state.requestHash,
                      namespace: command.state.namespace,
                      planHash: command.state.planHash,
                      stageNonce: command.nonce,
                      rejectedAt: financialClock,
                      payable: computed.payable,
                      profileQualified: true,
                      profileCode: null,
                    }),
                  },
                  proof = sourceRejectionReceiptSchema.parse({
                    contract: 'pos-legacy-order-import-source-v1',
                    operationId: command.state.scope.operationId,
                    requestHash: command.state.requestHash,
                    namespace: command.state.namespace,
                    status: 'rejected',
                    code: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
                    noFinancialEffects: true,
                    review: {
                      contract: 'pos-import-rejection-calculation-v1',
                      planHash: command.state.planHash,
                      stageNonce: command.nonce,
                      rejectedAt: financialClock,
                      calculation,
                    },
                  });
                await f.db
                  .get('writer')
                  .insert(financialImportSourceReceipts)
                  .values({
                    id: command.state.scope.operationId + ':order',
                    operationId: command.state.scope.operationId,
                    kind: 'order',
                    status: 'rejected',
                    requestHash: command.state.requestHash,
                    proof,
                    proofHash: financialSourceHash(f.benefits.sourceProofKey, 'rejection', proof),
                    createdAt: financialClock,
                  });
                throw new Error('Fixture source declined original mismatched tender.');
              },
            },
            profiles(),
          ),
          csv = runtimeImportInput();
        csv.csv = csv.csv.replace('private-import@example.test', 'fixture@example.test');
        csv.csv +=
          '\n' +
          csv.csv
            .split('\n')[1]!
            .replace(/^fixture-reference,/, ',')
            .replace(',9007199254740993,2,25.49,', ',9007199254740994,3,17.83,');
        await queue.stage('1', 'benefit-original-source', csv);
        expect(await queue.runOne(adapter)).toMatchObject({ state: 'FAILED' });
        const [original] = await queue.results('1', csv.id),
          sessionId = (await mysqlSessions(f.db).create('1', Date.parse('2099-01-01T00:00:00Z')))
            .sessionId,
          review = await corrections.review(
            correctionActor,
            csv.id,
            original!.operationId,
            sessionId,
          ),
          command = correctionCommand(review.reviewHash!, '45.00');
        command.lines.push({ row: 3, unitPrice: '17.83' });
        expect(review.original.lines).toHaveLength(2);
        await corrections.create(
          correctionActor,
          csv.id,
          original!.operationId,
          command,
          sessionId,
          'benefit-manager-correction',
        );
        const input = await queue.financialContext(
            '1',
            command.successorJobId,
            command.successorOperationId,
          ),
          service = legacyOrderImportService(f.config, f.db, {
            runtime: readLegacyOrderImportOptions({
              LEGACY_ORDER_IMPORT_CONTRACT: 'pos-legacy-order-import-v1',
              LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: options.secret,
            }),
            adapter,
            corrections,
            correctionForOperation: corrections.correctionForOperation,
            approvals: legacyOrderImportFinancialApprovals(f.config, f.db, options),
          });
        await service.requestApproval(
          correctionActor,
          command.successorJobId,
          command.successorOperationId,
          { commandId: randomUUID(), reason: 'historical-correction' },
        );
        expect(await queue.runOne(adapter)).toMatchObject({
          state: scenario === 'completed' ? 'IMPORTED' : 'RECONCILING',
        });
        expect(source.failures).toEqual([]);
        const result = await adapter.read(input);
        if (scenario !== 'completed') {
          expect(result).toMatchObject({ status: 'unknown', stage: 'settlement' });
          expect(await adapter.start(input)).toEqual(result);
          expect(source.calls).toEqual({ order: 1, confirmation: 1, publication: 0 });
          expect(await f.db.get('writer').select().from(financialImportProofs)).toEqual([]);
          const [logs] = await f.connection.query('SELECT COUNT(*) AS n FROM pos_transaction_logs');
          expect(logs).toEqual([{ n: '0' }]);
          return;
        }
        expect(result?.status).toBe('completed');
        expect(await adapter.start(input)).toEqual(result);
        expect(source.calls).toEqual({ order: 1, confirmation: 1, publication: 1 });
        const [proof] = await f.db
          .get('writer')
          .select()
          .from(financialImportProofs)
          .where(eq(financialImportProofs.operationId, input.operationId));
        expect(proof?.data).toMatchObject({
          correction: { id: command.id, historicalTenderAmount: '45.00' },
          settlement: { cash: '45.00', cashReceived: '45.00' },
          benefits: {
            coupon: { receipt: { consumption: 'offline-go-confirmation' } },
            activation: { receipt: { contract: 'pos-csv-coupon-consumption-v1' } },
          },
        });
        expect(proof?.data.benefits?.activation?.receipt.sourceConfirmationHash).toBe(
          proof?.data.benefits?.confirmationHash,
        );
        const [counts] = await f.connection.query(
          'SELECT (SELECT COUNT(*) FROM pos_transaction_logs) AS payments,(SELECT COUNT(*) FROM order_coupon_log) AS coupons,(SELECT coupon_used_count FROM coupons_users LIMIT 1) AS used',
        );
        expect(counts).toEqual([{ payments: '1', coupons: '1', used: '1' }]);
      },
    );
    it('rejects a verified asset token after its native transaction ends, before a new writer can use it', async () => {
      const source = f.transport(),
        profile = profiles(),
        input = f.input(f.plan()),
        adapter = legacyOrderImportFinancialAdapter(
          f.config,
          f.db,
          f.options,
          {
            ...source.transport,
            async publication() {
              throw new Error('isolated no publication reply');
            },
          },
          profile,
        );
      expect((await adapter.start(input)).status).toBe('unknown');
      const journal = legacyImportFinancialJournal(f.config, f.db, f.options, profile),
        checked = await journal.transaction(async (tx) => {
          const context = await journal.load(tx, input);
          if (!context) throw new Error('Native benefit context missing.');
          await profile.lock(tx, context);
          const order = await readSourceOrderReceipt(
            tx,
            input.operationId,
            f.benefits.sourceProofKey,
          );
          if (!order) throw new Error('Native benefit receipt missing.');
          const token = await profile.qualifiedBenefits(tx, context, order, 'settled');
          if (!token) throw new Error('Verified asset fixture missing.');
          return { context, order, token };
        });
      await expect(
        journal.transaction((tx) =>
          assertNativeImportOrder(
            tx,
            checked.context.state,
            checked.context.plan,
            checked.order,
            null,
            checked.token,
            'settled',
          ),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_BENEFIT_PROOF_INVALID' });
      expect(source.calls).toEqual({ order: 1, confirmation: 0, publication: 0 });
    });
  },
);
