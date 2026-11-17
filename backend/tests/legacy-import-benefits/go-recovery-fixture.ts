import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { splitMigration } from '../../src/db/migrations.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
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
import { financialAdapterProfiles } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { financialImportSourceReceipts } from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import type {
  FinancialSourceCommand,
  LegacyImportFinancialTransport,
} from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';
import type { SourceOrderReceipt } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import { financialClock } from '../legacy-import-financial/fixture.js';
import { benefitFinancialFixture } from './financial-fixture.js';

type Fixture = Awaited<ReturnType<typeof benefitFinancialFixture>>;
const authKey = 'isolated-go-coupon-private-auth-'.repeat(3);

/** Only the already-reviewed original Go Confirm/sourceApply fixture executes
 * consumption. This helper never runs the Python deduction oracle. */
export async function installOriginalGoFixture(f: Fixture) {
  const native = verifiedMysqlFixture(f.connection, [
    'evidence/mysql-global-benefits-schema.json',
    'evidence/mysql-pending-cancellation-benefits-schema.json',
    'evidence/mysql-import-referral-schema.json',
  ]);
  await native.create([
    'order_tss_money',
    'order_tss_point',
    'tss_money_history',
    'tss_point_history',
    'reward_point_history',
    'gift_voucher_history',
    'referral_log',
  ]);
  await f.connection.query(
    'ALTER TABLE referral_log ADD UNIQUE KEY unique_refer_pair(referred_to,referred_by)',
  );
  for (const path of [
    'src/modules/checkout/cancellations/benefit-migration.sql',
    'src/modules/checkout/cancellations/membership-producer-migration.sql',
  ])
    for (const statement of splitMigration(readFileSync(path, 'utf8')))
      await f.connection.query(statement);
}

export function originalGoConfirmation(
  f: Fixture,
  command: FinancialSourceCommand,
  order: SourceOrderReceipt,
) {
  const binary = process.env.POS_IMPORT_COUPON_GO_BINARY;
  if (!binary) throw new Error('Explicit original Go fixture binary required.');
  if (order.orderId !== '5001') throw new Error('Exact disposable original Go order required.');
  const issuedAt = Date.now(),
    cap = {
      contract: 'pos-legacy-order-import-source-v1',
      phase: 'confirmation',
      operationId: command.state.scope.operationId,
      requestHash: command.state.requestHash,
      planHash: command.state.planHash,
      namespace: command.state.namespace,
      planDigest: financialSourceHash(authKey, 'plan', command.plan),
      orderId: order.orderId,
      nonce: command.nonce,
      scope: command.state.scope,
      authority: command.state.authority,
      issuedAt,
      expiresAt: issuedAt + 60000,
    };
  let output: string;
  try {
    output = execFileSync(binary, ['-test.run', '^TestImportCouponExistingSource$', '-test.v'], {
      input: JSON.stringify({
        url: f.config.MYSQL_WRITER_URL,
        authKey,
        proofKey: f.benefits.sourceProofKey,
        orderId: 5001,
        capability: { ...cap, signature: financialSourceHash(authKey, 'capability', cap) },
        selected: true,
        contenders: 1,
        mutation: '',
        reject: false,
        replay: false,
      }),
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 12000,
      env: { ...process.env, POS_IMPORT_COUPON_GO_FIXTURE: '1' },
    });
  } catch {
    throw new Error('Isolated original Go confirmation failed.');
  }
  return z
    .object({ sourceCalls: z.literal(1), created: z.literal(1), refused: z.literal(0) })
    .parse(JSON.parse(output.match(/COUPON_BRIDGE (\{[^\n]+\})/)?.[1] ?? 'null'));
}

/** Real native failed-original ->manager correction ->new historical approval.
 * The original 104.47 tender is never silently changed into source payable45. */
export async function correctedGoImport(f: Fixture, transport: LegacyImportFinancialTransport) {
  const options = { ...f.options, correctionContract: 'pos-import-manager-correction-v1' as const },
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
        ...transport,
        async order(command) {
          if (command.state.correction) return transport.order(command);
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
          throw new Error('Isolated mismatched original tender was rejected.');
        },
      },
      financialAdapterProfiles({ benefits: f.benefits }),
    ),
    csv = runtimeImportInput();
  csv.csv = csv.csv.replace('private-import@example.test', 'fixture@example.test');
  csv.csv +=
    '\n' +
    csv.csv
      .split('\n')[1]!
      .replace(/^fixture-reference,/, ',')
      .replace(',9007199254740993,2,25.49,', ',9007199254740994,3,17.83,');
  await queue.stage('1', 'go-benefit-original', csv);
  if ((await queue.runOne(adapter))?.state !== 'FAILED')
    throw new Error('Original mismatch was not retained.');
  const [original] = await queue.results('1', csv.id),
    sessionId = (await mysqlSessions(f.db).create('1', Date.parse('2099-01-01T00:00:00Z')))
      .sessionId,
    review = await corrections.review(correctionActor, csv.id, original!.operationId, sessionId),
    command = correctionCommand(review.reviewHash!, '45.00');
  command.lines.push({ row: 3, unitPrice: '17.83' });
  await corrections.create(
    correctionActor,
    csv.id,
    original!.operationId,
    command,
    sessionId,
    'go-benefit-correction',
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
  return { input, queue, adapter, options, command };
}
