import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { splitMigration } from '../../src/db/migrations.js';
import { MUser } from '../../src/db/legacy-schema.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { legacyOrderImportService } from '../../src/modules/legacy-order-imports/service.js';
import { legacyOrderImportCorrections } from '../../src/modules/legacy-order-imports/correction-repository.js';
import { financialImportCorrectionBoundary } from '../../src/modules/legacy-order-imports/financial-adapter-correction-boundary.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { legacyOrderImportFinancialApprovals } from '../../src/modules/legacy-order-imports/financial-adapter-approval.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { sourceRejectionReceiptSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  financialImportOperations,
  financialImportProofs,
  financialImportSourceReceipts,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import {
  legacyOrderImports,
  legacyOrderImportRows,
} from '../../src/modules/legacy-order-imports/schema.js';
import { runtimeImportInput } from '../legacy-order-imports/runtime-fixture.js';
import { readLegacyOrderImportOptions } from '../../src/modules/legacy-order-imports/options.js';
import { correctionActor, correctionCommand } from '../import-corrections/fixture.js';
import { importFinancialFixture, financialClock, sourceKey } from './fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('manager corrections with the real native financial core', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>, sessionId: string;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    for (const path of [
      'migrations/0002_auth_sessions.sql',
      'src/modules/administration/migration.sql',
      'src/modules/legacy-order-imports/correction-migration.sql',
      'src/modules/legacy-order-imports/correction-command-migration.sql',
    ])
      for (const statement of splitMigration(readFileSync(path, 'utf8')))
        await f.connection.query(statement);
  }, 30000);
  afterAll(async () => f?.close());
  beforeEach(async () => {
    for (const table of [
      'pos_rewrite_import_corrections',
      'pos_rewrite_import_correction_commands',
      'pos_rewrite_sessions',
      'pos_rewrite_operator_checkins',
    ])
      await f.connection.query('DELETE FROM ' + table);
    await f.reset();
    await f.connection.query(
      "INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,expires_at,checked_in_at) VALUES('1',1,2,'2099-01-01 00:00:00','2026-06-15 12:00:00')",
    );
    sessionId = (await mysqlSessions(f.db).create('1', Date.parse('2099-01-01T00:00:00Z')))
      .sessionId;
  });

  it('keeps the rejected input, requires approval on an open day, settles the attested tender once and retains correction evidence', async () => {
    const options = {
        ...f.options,
        correctionContract: 'pos-import-manager-correction-v1' as const,
      },
      corrections = legacyOrderImportCorrections(f.db, f.config, {
        secret: options.secret,
        contract: options.correctionContract,
        clock: () => financialClock,
        boundary: financialImportCorrectionBoundary({
          secret: options.secret,
          sourceProofKey: sourceKey,
        }),
      }),
      queue = legacyOrderImportRepository(f.db, {
        secret: options.secret,
        now: () => financialClock,
        correctionForOperation: corrections.correctionForOperation,
      }),
      transport = f.transport();
    let rejectedOperation: string | null = null,
      sourceCalls = 0;
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, options, {
      ...transport,
      async order(command) {
        sourceCalls++;
        if (command.state.correction) return transport.order(command);
        rejectedOperation = command.state.scope.operationId;
        // A trusted fixture source transaction records the signed rollback
        // outcome. This test exercises the real Node core, not source Python.
        const calculation = {
            payable: '50.00',
            profileQualified: true,
            profileCode: null,
            calculationHash: financialSourceHash(sourceKey, 'calculation', {
              operationId: rejectedOperation,
              requestHash: command.state.requestHash,
              namespace: command.state.namespace,
              planHash: command.state.planHash,
              stageNonce: command.nonce,
              rejectedAt: financialClock,
              payable: '50.00',
              profileQualified: true,
              profileCode: null,
            }),
          },
          proof = sourceRejectionReceiptSchema.parse({
            contract: 'pos-legacy-order-import-source-v1',
            operationId: rejectedOperation,
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
            id: rejectedOperation + ':order',
            operationId: rejectedOperation,
            kind: 'order',
            status: 'rejected',
            requestHash: command.state.requestHash,
            proof,
            proofHash: financialSourceHash(sourceKey, 'rejection', proof),
            createdAt: financialClock,
          });
        throw new Error('Trusted fixture source declined the original mismatched tender.');
      },
    });
    const input = runtimeImportInput();
    await queue.stage('1', 'original-financial-fixture', input);
    await queue.runOne(adapter);
    expect(rejectedOperation).not.toBeNull();
    const [original] = await f.db
      .get('writer')
      .select()
      .from(legacyOrderImportRows)
      .where(eq(legacyOrderImportRows.operationId, rejectedOperation!));
    expect(original).toMatchObject({ state: 'FAILED', orderId: null });
    const review = await corrections.review(
        correctionActor,
        input.id,
        rejectedOperation!,
        sessionId,
      ),
      command = correctionCommand(review.reviewHash!),
      receipt = await corrections.create(
        correctionActor,
        input.id,
        rejectedOperation!,
        command,
        sessionId,
        'correction-financial-fixture',
      );
    expect(receipt).toMatchObject({
      historicalTenderAmount: '50.00',
      correctedLineValue: '50.98',
      requiresApproval: true,
    });
    const context = await queue.financialContext(
        '1',
        command.successorJobId,
        command.successorOperationId,
      ),
      approvals = legacyOrderImportFinancialApprovals(f.config, f.db, options),
      service = legacyOrderImportService(f.config, f.db, {
        runtime: readLegacyOrderImportOptions({
          LEGACY_ORDER_IMPORT_CONTRACT: 'pos-legacy-order-import-v1',
          LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: options.secret,
        }),
        adapter,
        approvals,
        corrections,
        correctionForOperation: corrections.correctionForOperation,
      });
    expect(context.correction?.id).toBe(command.id);
    await f.db.get('writer').transaction(async (tx) => {
      expect(await adapter.authorizeStart!(tx, context)).toEqual({
        ready: false,
        code: 'ORDER_IMPORT_APPROVAL_REQUIRED',
      });
    });
    expect(
      await f.db
        .get('writer')
        .select()
        .from(financialImportOperations)
        .where(eq(financialImportOperations.id, command.successorOperationId)),
    ).toEqual([]);
    await expect(
      service.requestApproval(
        correctionActor,
        command.successorJobId,
        command.successorOperationId,
        { commandId: randomUUID(), reason: 'late-recording' },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_CORRECTION_APPROVAL_REQUIRED' });
    const approved = await service.requestApproval(
      correctionActor,
      command.successorJobId,
      command.successorOperationId,
      { commandId: randomUUID(), reason: 'historical-correction' },
    );
    expect(approved.review).toMatchObject({
      lineValue: '50.98',
      correction: { id: command.id, historicalTenderAmount: '50.00', sourcePayable: '50.00' },
    });
    expect(approved.approval.reason).toBe('historical-correction');
    await f.db.get('writer').transaction(async (tx) => {
      expect(await adapter.authorizeStart!(tx, context)).toEqual({ ready: true });
    });
    await f.db
      .get('writer')
      .update(legacyOrderImports)
      .set({ leaseUntil: sql`TIMESTAMP('2026-06-14 00:00:00')` })
      .where(eq(legacyOrderImports.id, command.successorJobId));
    await queue.runOne(adapter);
    const result = await adapter.read(context);
    expect(result).toMatchObject({
      status: 'completed',
      operationId: command.successorOperationId,
    });
    expect(await adapter.start(context)).toEqual(result);
    expect(sourceCalls).toBe(2);
    const [saved] = await f.db
      .get('writer')
      .select()
      .from(financialImportProofs)
      .where(eq(financialImportProofs.operationId, command.successorOperationId));
    expect(saved?.data).toMatchObject({
      correction: { id: command.id },
      order: { payable: '50.00' },
      settlement: { cash: '50.00', cashReceived: '50.00', manualOther: '0.00' },
    });
    expect(
      await f.db
        .get('writer')
        .select()
        .from(legacyOrderImportRows)
        .where(eq(legacyOrderImportRows.operationId, rejectedOperation!)),
    ).toEqual([original]);
    await f.db
      .get('writer')
      .update(MUser)
      .set({ email: 'changed-contact@example.test' })
      .where(eq(MUser.id, 77n));
    const retained = legacyOrderImportFinancialAdapter(
      f.config,
      f.db,
      { ...options, correctionContract: undefined },
      transport,
    );
    expect(await retained.read(context)).toEqual(result);
    expect(sourceCalls).toBe(2);
  });
});
