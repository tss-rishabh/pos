import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { splitMigration } from '../../src/db/migrations.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { legacyOrderImportCorrections } from '../../src/modules/legacy-order-imports/correction-repository.js';
import { financialImportCorrectionBoundary } from '../../src/modules/legacy-order-imports/financial-adapter-correction-boundary.js';
import { legacyOrderImportFinancialApprovals } from '../../src/modules/legacy-order-imports/financial-adapter-approval.js';
import { legacyOrderImportRows } from '../../src/modules/legacy-order-imports/schema.js';
import { sourceRejectionReceiptSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import { runtimeImportInput } from '../legacy-order-imports/runtime-fixture.js';
import { correctionActor, correctionCommand } from '../import-corrections/fixture.js';
import { importFinancialFixture, financialPlan, financialClock, sourceKey } from './fixture.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import {
  financialImportApprovals,
  financialImportSourceReceipts,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { importCorrections } from '../../src/modules/legacy-order-imports/correction-schema.js';
import { readSourceOrderReceipt } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import { assertNativeImportOrder } from '../../src/modules/legacy-order-imports/financial-adapter-writer.js';
import type { FinancialSourceCommand } from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { settleNativeImport } from '../../src/modules/legacy-order-imports/financial-adapter-writer.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
function sourcePlan(kind: 'offline' | 'shopify') {
  const plan = financialPlan(kind);
  if (plan.kind === 'shopify')
    plan.address = {
      shipping_name: 'Fixture',
      shipping_street: 'Road',
      shipping_address1: 'Building',
      shipping_address2: '',
      shipping_phone: '9000000000',
      shipping_country: 'India',
      shipping_province: 'Fixture state',
      shipping_zip: '400001',
      shipping_city: 'Fixture city',
    };
  return plan;
}
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  authKey = 'fixture-private-source-authority-key-'.repeat(3);
describe.skipIf(!template)('literal API-v2 source order inside private native receiver', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>;
  let sourceFixture: ReturnType<typeof verifiedMysqlFixture>;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    sourceFixture = verifiedMysqlFixture(f.connection, [
      'evidence/mysql-order-import-address-schema.json',
      'evidence/mysql-import-referral-schema.json',
      'evidence/mysql-pending-cancellation-benefits-schema.json',
      'evidence/mysql-global-benefits-schema.json',
    ]);
    await sourceFixture.create([
      'cities',
      'zones',
      'pricelist',
      'pricelist_meta',
      'has_categories',
      'has_addresses',
      'order_address_mapping',
      'flag_history',
      'order_cancel_message_mapping',
      'referral_log',
      'order_tss_money',
      'order_tss_point',
      'tss_money_history',
      'tss_point_history',
      'reward_point_history',
      'gift_voucher_history',
    ]);
    await f.connection.query(
      'ALTER TABLE referral_log ADD UNIQUE KEY unique_refer_pair(referred_to,referred_by)',
    );
    for (const path of [
      'migrations/0002_auth_sessions.sql',
      'src/modules/checkout/cancellations/benefit-migration.sql',
      'src/modules/checkout/cancellations/membership-producer-migration.sql',
      'src/modules/administration/migration.sql',
      'src/modules/legacy-order-imports/correction-migration.sql',
      'src/modules/legacy-order-imports/correction-command-migration.sql',
    ])
      for (const statement of splitMigration(readFileSync(path, 'utf8')))
        await f.connection.query(statement);
  }, 30000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
    for (const name of [
      'pos_rewrite_import_corrections',
      'pos_rewrite_import_correction_commands',
      'pos_rewrite_sessions',
      'pos_rewrite_operator_checkins',
    ])
      await f.connection.query('DELETE FROM ' + name);
    await f.connection.query('ALTER TABLE orders AUTO_INCREMENT=5001');
    for (const name of [
      'cities',
      'zones',
      'pricelist',
      'pricelist_meta',
      'has_categories',
      'has_addresses',
      'order_address_mapping',
      'flag_history',
      'order_cancel_message_mapping',
      'referral_log',
      'order_tss_money',
      'order_tss_point',
      'tss_money_history',
      'tss_point_history',
      'reward_point_history',
      'gift_voucher_history',
    ])
      await f.connection.query('DELETE FROM `' + name + '`');
    await f.fixture.insert('cities', { id: 10, city_name: 'Fixture city', state_id: 20 });
    await f.fixture.insert('zones', { id: 20, name: 'Fixture state' });
    await f.connection.query(
      "UPDATE stores SET city_id=10,store_name='Fixture store',address='Fixture address',alt_address='',phone='9000000000',pincode='400001' WHERE id=1",
    );
    await f.connection.query(
      "UPDATE users SET firstname='Fixture',lastname='Import',cashback=0,tss_money=0,tss_points=0 WHERE id=77",
    );
    await f.connection.query(
      'UPDATE products SET price=25,spl_price=0,cog=0,parent_prod_id=0 WHERE id=9007199254740993',
    );
    await f.fixture.insert('pricelist_meta', { id: 1, is_active: 1 });
    await sourceFixture.insert('has_addresses', { id: 88, user_id: 77 });
  });
  function driverValue(
    input: FinancialSourceCommand,
    mode?: string,
    phase: 'order' | 'publication' = 'order',
  ) {
    const cap = {
      contract: 'pos-legacy-order-import-source-v1',
      phase,
      operationId: input.state.scope.operationId,
      requestHash: input.state.requestHash,
      planHash: input.state.planHash,
      namespace: input.state.namespace,
      planDigest: financialSourceHash(authKey, 'plan', input.plan),
      scope: input.state.scope,
      authority: input.state.authority,
      orderId: phase === 'order' ? null : input.state.orderId,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      ...(phase === 'order' && input.state.correction
        ? { correctionHash: financialSourceHash(authKey, 'correction', input.state.correction) }
        : {}),
    };
    return {
      url: f.config.MYSQL_WRITER_URL,
      sourceRoot: process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ?? resolve('../../backend-tss-api_v2'),
      authKey,
      proofKey: sourceKey,
      now: input.issuedAt,
      operationId: input.state.scope.operationId,
      mode,
      phase,
      ...(input.state.correction ? { correctionContract: 'pos-import-manager-correction-v1' } : {}),
      body: {
        capability: { ...cap, signature: financialSourceHash(authKey, 'capability', cap) },
        ...(phase === 'order' ? { plan: input.plan } : { orderId: input.state.orderId }),
      },
    };
  }
  function driverInput(
    input: FinancialSourceCommand,
    mode?: string,
    phase: 'order' | 'publication' = 'order',
  ) {
    return JSON.stringify(driverValue(input, mode, phase));
  }
  function run(
    input: FinancialSourceCommand,
    mode?: string,
    phase: 'order' | 'publication' = 'order',
  ) {
    return runRaw(driverInput(input, mode, phase));
  }
  function runRaw(input: string) {
    const result: unknown = JSON.parse(
      execFileSync(
        resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
        ['-B', resolve('compatibility/upstream/legacy-order-imports/native_source_driver.py')],
        {
          input,
          encoding: 'utf8',
          timeout: 20000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
          maxBuffer: 16000,
        },
      ),
    );
    return result;
  }
  for (const scenario of [
    'accepted',
    'accepted-go',
    'missing-correction-hash',
    'missing-source-contract',
    'changed-retained-binding',
    'changed-original-receipt',
    'wrong-approval-reason',
    'recalculated-payable',
  ] as const) {
    it.skipIf(scenario === 'accepted-go' && !process.env.POS_IMPORT_CORRECTION_GO_BINARY)(
      `qualifies the source calculator and manager successor: ${scenario}`,
      async () => {
        await f.connection.query(
          "INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,expires_at,checked_in_at) VALUES('1',1,2,'2099-01-01 00:00:00','2026-06-15 12:00:00')",
        );
        let confirmationFailure: string | null = null;
        const session = await mysqlSessions(f.db).create('1', Date.parse('2099-01-01T00:00:00Z')),
          options = {
            ...f.options,
            clock: scenario === 'accepted-go' ? Date.now : () => financialClock,
            correctionContract: 'pos-import-manager-correction-v1' as const,
          },
          corrections = legacyOrderImportCorrections(f.db, f.config, {
            secret: options.secret,
            contract: options.correctionContract,
            clock: options.clock,
            boundary: financialImportCorrectionBoundary({
              secret: options.secret,
              sourceProofKey: sourceKey,
            }),
          }),
          queue = legacyOrderImportRepository(f.db, {
            secret: options.secret,
            now: options.clock,
            correctionForOperation: corrections.correctionForOperation,
          }),
          transport = f.transport(),
          adapter = legacyOrderImportFinancialAdapter(f.config, f.db, options, {
            ...transport,
            async order(command) {
              if (command.state.correction) {
                const value = driverValue(
                  command,
                  scenario === 'recalculated-payable'
                    ? 'correction-current-discount'
                    : 'correction-calculator',
                );
                if (scenario === 'missing-correction-hash') {
                  delete value.body.capability.correctionHash;
                  const { signature: _signature, ...unsigned } = value.body.capability;
                  value.body.capability.signature = financialSourceHash(
                    authKey,
                    'capability',
                    unsigned,
                  );
                }
                if (scenario === 'missing-source-contract') delete value.correctionContract;
                if (scenario === 'changed-retained-binding')
                  await f.db
                    .get('writer')
                    .update(importCorrections)
                    .set({ body: { ...command.state.correction, historicalTenderAmount: '49.00' } })
                    .where(eq(importCorrections.id, command.state.correction.id));
                if (scenario === 'changed-original-receipt')
                  await f.db
                    .get('writer')
                    .update(financialImportSourceReceipts)
                    .set({ proofHash: '0'.repeat(64) })
                    .where(
                      eq(
                        financialImportSourceReceipts.operationId,
                        command.state.correction.original.operationId,
                      ),
                    );
                if (scenario === 'wrong-approval-reason') {
                  const [grant] = await f.db
                    .get('writer')
                    .select()
                    .from(financialImportApprovals)
                    .where(eq(financialImportApprovals.id, command.state.authority.approvalId!));
                  await f.db
                    .get('writer')
                    .update(financialImportApprovals)
                    .set({ data: { ...grant!.data, reason: 'late-recording' } })
                    .where(eq(financialImportApprovals.id, grant!.id));
                }
                expect(runRaw(JSON.stringify(value))).toMatchObject({ recorded: true });
              } else
                expect(run(command, 'correction-calculator')).toMatchObject({ recorded: true });
            },
            async publication(command) {
              expect(run(command, undefined, 'publication')).toMatchObject({ recorded: true });
            },
            async confirm(command, order, customer) {
              if (scenario !== 'accepted-go') return transport.confirm(command, order, customer);
              const { signature: _signature, ...unsigned } = driverValue(
                command,
                undefined,
                'publication',
              ).body.capability;
              const capability = { ...unsigned, phase: 'confirmation', orderId: order.orderId };
              let output: string;
              try {
                output = execFileSync(
                  process.env.POS_IMPORT_CORRECTION_GO_BINARY!,
                  ['-test.run', '^TestImportCorrectionExistingSource$', '-test.v'],
                  {
                    input: JSON.stringify({
                      url: f.config.MYSQL_WRITER_URL,
                      authKey,
                      proofKey: sourceKey,
                      orderId: Number(order.orderId),
                      capability: {
                        ...capability,
                        signature: financialSourceHash(authKey, 'capability', capability),
                      },
                    }),
                    env: { ...process.env, POS_IMPORT_CORRECTION_GO_FIXTURE: '1' },
                    encoding: 'utf8',
                    timeout: 25000,
                    maxBuffer: 16000,
                  },
                );
              } catch (error: unknown) {
                const raw =
                  typeof error === 'object' &&
                  error !== null &&
                  'stdout' in error &&
                  (typeof error.stdout === 'string' || Buffer.isBuffer(error.stdout))
                    ? error.stdout.toString()
                    : '';
                confirmationFailure =
                  raw.match(/local correction [^\r\n]*/)?.[0] ?? 'GO_CORRECTION_FIXTURE_FAILED';
                throw new Error('The isolated Go correction fixture failed.');
              }
              expect(output).toContain('PASS');
            },
          }),
          input = runtimeImportInput();
        await queue.stage('1', 'source-correction-original', input);
        if (scenario === 'accepted-go') {
          const [row] = await f.db
            .get('writer')
            .select()
            .from(legacyOrderImportRows)
            .where(eq(legacyOrderImportRows.jobId, input.id));
          const current = await queue.financialContext('1', input.id, row!.operationId);
          await legacyOrderImportFinancialApprovals(f.config, f.db, options).request({
            approverId: '1',
            scope: {
              actorId: current.actorId,
              operationId: current.operationId,
              storeId: current.storeId,
              counterId: current.counterId,
            },
            plan: current.plan,
            planHash: current.planHash,
            commandId: randomUUID(),
            reason: 'late-recording',
          });
        }
        await queue.runOne(adapter);
        const [original] = await f.db
          .get('writer')
          .select()
          .from(legacyOrderImportRows)
          .where(eq(legacyOrderImportRows.jobId, input.id));
        expect(original).toMatchObject({
          state: 'FAILED',
          errorCode: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
        });
        const [negative] = await f.db
          .get('writer')
          .select()
          .from(financialImportSourceReceipts)
          .where(eq(financialImportSourceReceipts.operationId, original!.operationId));
        const proof = sourceRejectionReceiptSchema.parse(negative!.proof);
        expect(proof.review?.calculation).toMatchObject({
          payable: '50.00',
          profileQualified: true,
          profileCode: null,
        });
        expect(negative!.proofHash).toBe(financialSourceHash(sourceKey, 'rejection', proof));
        const [effects] = await f.connection.query(
          'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM has_products) AS lines_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_source_effects) AS effects_count',
        );
        expect(effects).toEqual([{ orders_count: '0', lines_count: '0', effects_count: '0' }]);
        const review = await corrections.review(
            correctionActor,
            input.id,
            original!.operationId,
            session.sessionId,
          ),
          command = correctionCommand(review.reviewHash!);
        await corrections.create(
          correctionActor,
          input.id,
          original!.operationId,
          command,
          session.sessionId,
          'source-correction-successor',
        );
        const context = await queue.financialContext(
            '1',
            command.successorJobId,
            command.successorOperationId,
          ),
          approvals = legacyOrderImportFinancialApprovals(f.config, f.db, options);
        await approvals.request({
          approverId: '1',
          scope: {
            actorId: context.actorId,
            operationId: context.operationId,
            storeId: context.storeId,
            counterId: context.counterId,
          },
          plan: context.plan,
          planHash: context.planHash,
          correction: context.correction,
          commandId: randomUUID(),
          reason: 'historical-correction',
        });
        const result = await adapter.start(context);
        expect(confirmationFailure).toBeNull();
        if (scenario !== 'accepted' && scenario !== 'accepted-go') {
          expect(result).toMatchObject({
            status: 'rejected',
            operationId: command.successorOperationId,
            code:
              scenario === 'missing-source-contract'
                ? 'ORDER_IMPORT_CORRECTION_DISABLED'
                : scenario === 'wrong-approval-reason'
                  ? 'ORDER_IMPORT_APPROVAL_REQUIRED'
                  : scenario === 'recalculated-payable'
                    ? 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH'
                    : 'ORDER_IMPORT_CORRECTION_EVIDENCE_INVALID',
          });
          const [none] = await f.connection.query(
            'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM has_products) AS lines_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_source_effects) AS effects_count',
          );
          expect(none).toEqual([{ orders_count: '0', lines_count: '0', effects_count: '0' }]);
          return;
        }
        expect(result).toMatchObject({
          status: 'completed',
          operationId: command.successorOperationId,
        });
        const [native] = await f.connection.query(
          'SELECT o.pay_amt,hp.price,hp.qty,hp.amount_to_be_refunded FROM orders o JOIN has_products hp ON hp.order_id=o.id',
        );
        expect(native).toEqual([
          { pay_amt: 50, price: 50.98, qty: '2', amount_to_be_refunded: 50 },
        ]);
        expect(await adapter.read(context)).toMatchObject({ status: 'completed' });
      },
      30000,
    );
  }
  it('never exposes an unbound source order when literal inner commits flush before the outer receipt transaction', async () => {
    const input = f.input(),
      journal = legacyImportFinancialJournal(f.config, f.db, f.options);
    await journal.reserve(input);
    const command = await journal.dispatch(input, 'order');
    const child = spawn(
      resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
      ['-B', resolve('compatibility/upstream/legacy-order-imports/native_source_driver.py')],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let output = '';
    const flushed = new Promise<void>((fulfill, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('SOURCE_FLUSHED\n')) fulfill();
      });
      child.once('error', reject);
      child.once('exit', () => {
        if (!output.includes('SOURCE_FLUSHED\n'))
          reject(new Error('Source fixture did not reach its flush barrier.'));
      });
    });
    const finished = new Promise<void>((fulfill, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? fulfill() : reject(new Error('Source fixture did not complete.')),
      );
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdin.end(driverInput(command, 'visibility-barrier'));
    try {
      await flushed;
      const [before] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings) AS bindings_count',
      );
      expect(before).toEqual([{ orders_count: '0', bindings_count: '0' }]);
      await finished;
      expect(JSON.parse(output.split('\n').at(-2)!)).toEqual({
        recorded: true,
        fixtureFailures: [],
      });
      const [after] = await f.connection.query(
        "SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings WHERE status='held') AS bindings_count",
      );
      expect(after).toEqual([{ orders_count: '1', bindings_count: '1' }]);
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  }, 30000);
  it.each(['offline', 'shopify'] as const)(
    'commits the literal %s source body and native signed order/HP/refund receipt together',
    async (kind) => {
      const plan = financialPlan(kind);
      if (plan.kind === 'shopify') {
        plan.address = {
          shipping_name: 'Fixture',
          shipping_street: 'Road',
          shipping_address1: 'Building',
          shipping_address2: '',
          shipping_phone: '9000000000',
          shipping_country: 'India',
          shipping_province: 'Fixture state',
          shipping_zip: '400001',
          shipping_city: 'Fixture city',
        };
        plan.currency = 'USD';
        plan.shippingCharges = '7.50';
        plan.discountAmount = '2.00';
      }
      const input = f.input(plan),
        journal = legacyImportFinancialJournal(f.config, f.db, f.options);
      await journal.reserve(input);
      const command = await journal.dispatch(input, 'order');
      const result = run(command);
      expect(result).toEqual({ recorded: true, fixtureFailures: [] });
      const receipt = await f.db
        .get('writer')
        .transaction((tx) => readSourceOrderReceipt(tx, input.operationId, sourceKey));
      expect(receipt).not.toBeNull();
      await f.db
        .get('writer')
        .transaction((tx) => assertNativeImportOrder(tx, command.state, plan, receipt!));
      expect(receipt!.method).toBe(kind === 'offline' ? 14 : 15);
      if (kind === 'shopify') {
        const [headers] = await f.connection.query(
          'SELECT currency,currency_conv_rate,shipping_amt,coupon_amt_used FROM orders',
        );
        expect(headers).toEqual([
          { currency: 'USD', currency_conv_rate: '0', shipping_amt: 0, coupon_amt_used: 0 },
        ]);
      }
      // Duplicate private request reads its original native receipt, without another source order.
      expect(run(command)).toEqual({ recorded: true, fixtureFailures: [] });
      const [rows] = await f.connection.query('SELECT COUNT(*) AS n FROM orders');
      expect(rows).toEqual([{ n: '1' }]);
    },
    30000,
  );
  it.each(['offline', 'shopify'] as const)(
    'records the unmodified %s source model failure without claiming a successful legacy import',
    async (kind) => {
      const input = f.input(sourcePlan(kind)),
        journal = legacyImportFinancialJournal(f.config, f.db, f.options);
      await journal.reserve(input);
      const command = await journal.dispatch(input, 'order');
      const result = run(command, 'original-model');
      expect(result).toMatchObject({
        recorded: true,
        fixtureFailures: [
          kind === 'offline'
            ? { type: 'DataError', nativeCode: 1265, column: 'reward_points_cron' }
            : { type: 'TypeError', column: 'currency' },
        ],
      });
      const [rows] = await f.connection.query('SELECT COUNT(*) AS n FROM orders');
      expect(rows).toEqual([{ n: '0' }]);
      const [record] = await f.db
        .get('writer')
        .select()
        .from(financialImportSourceReceipts)
        .where(eq(financialImportSourceReceipts.operationId, input.operationId));
      expect(record?.status).toBe('rejected');
    },
    30000,
  );
  async function pendingPublication() {
    const plan = sourcePlan('shopify'),
      input = f.input(plan),
      journal = legacyImportFinancialJournal(f.config, f.db, f.options);
    await journal.reserve(input);
    const orderCommand = await journal.dispatch(input, 'order');
    expect(run(orderCommand)).toEqual({ recorded: true, fixtureFailures: [] });
    const order = await f.db
      .get('writer')
      .transaction((tx) => readSourceOrderReceipt(tx, input.operationId, sourceKey));
    if (!order) throw new Error('Native source receipt missing.');
    await journal.transaction(async (tx) => {
      await journal.confirm(tx, orderCommand.state, 'order', order);
      await journal.save(tx, { ...orderCommand.state, orderId: order.orderId });
    });
    const settlementCommand = await journal.dispatch(input, 'settlement');
    await journal.transaction(async (tx) => {
      const settlement = await settleNativeImport(
        tx,
        settlementCommand.state,
        plan,
        order,
        f.options,
      );
      await journal.confirm(tx, settlementCommand.state, 'settlement', settlement);
    });
    return { input, command: await journal.dispatch(input, 'publication') };
  }
  it('completes only after literal source producer jobs receive durable queue acceptance and native seals', async () => {
    const { input, command } = await pendingPublication();
    expect(run(command, undefined, 'publication')).toMatchObject({
      recorded: true,
      fixtureFailures: [],
      queueCalls: expect.any(Number),
    });
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, f.transport());
    expect(await adapter.read(input)).toMatchObject({
      status: 'completed',
      businessDate: '2026-06-15',
    });
    // The public completion seal advances the operation/stage. A stale private
    // capability is then refused; only its original GET receipt is needed.
    expect(run(command, undefined, 'publication')).toMatchObject({
      code: 'ORDER_IMPORT_NATIVE_SCOPE_INVALID',
      queueCalls: 0,
    });
    const [orders] = await f.connection.query('SELECT payment_status,order_status FROM orders');
    expect(orders).toEqual([{ payment_status: 1, order_status: 1 }]);
  }, 30000);
  it('freezes a partly accepted producer batch and never republishes after lost queue acknowledgment', async () => {
    const { input, command } = await pendingPublication();
    expect(run(command, 'lost-queue-ack', 'publication')).toMatchObject({
      code: 'ORDER_IMPORT_PUBLICATION_UNCONFIRMED',
      queueCalls: 3,
    });
    expect(run(command, undefined, 'publication')).toMatchObject({
      code: 'ORDER_IMPORT_ORIGINAL_STAGE_UNCERTAIN',
      queueCalls: 0,
    });
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, f.transport());
    expect(await adapter.read(input)).toMatchObject({ status: 'unknown', stage: 'publication' });
    const [rows] = await f.connection.query(
      'SELECT status,JSON_LENGTH(deliveries) AS accepted FROM pos_rewrite_import_financial_source_effects',
    );
    expect(rows).toEqual([{ status: 'uncertain', accepted: '2' }]);
  }, 30000);
  it('rolls back literal partial commits on a late source failure and seals one permanent no-effects rejection', async () => {
    const input = f.input(),
      journal = legacyImportFinancialJournal(f.config, f.db, f.options);
    await journal.reserve(input);
    const command = await journal.dispatch(input, 'order');
    run(command, 'late-failure');
    const [orders] = await f.connection.query('SELECT COUNT(*) AS n FROM orders');
    expect(orders).toEqual([{ n: '0' }]);
    const [source] = await f.db
      .get('writer')
      .select()
      .from(financialImportSourceReceipts)
      .where(eq(financialImportSourceReceipts.operationId, input.operationId));
    expect(source?.status).toBe('rejected');
    expect(source?.proof).toMatchObject({
      code: 'ORDER_IMPORT_FIXTURE_LATE_FAILURE',
      noFinancialEffects: true,
    });
    expect(run(command)).toEqual({ recorded: true, fixtureFailures: [] });
    const [lines] = await f.connection.query('SELECT COUNT(*) AS n FROM has_products');
    expect(lines).toEqual([{ n: '0' }]);
  }, 30000);
});
