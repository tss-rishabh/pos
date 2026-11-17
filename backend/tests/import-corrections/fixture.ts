import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { splitMigration } from '../../src/db/migrations.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import type { Principal } from '../../src/domain/access.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { legacyOrderImportRows } from '../../src/modules/legacy-order-imports/schema.js';
import { legacyOrderImportCorrections } from '../../src/modules/legacy-order-imports/correction-repository.js';
import type {
  ImportCorrectionBoundaryPort,
  ImportCorrectionInput,
} from '../../src/modules/legacy-order-imports/correction-contracts.js';
import type { ImportFinancialStart } from '../../src/modules/legacy-order-imports/financial-contracts.js';
import {
  orderImportRuntimeFixture,
  runtimeImportInput,
  runtimeImportSecret,
} from '../legacy-order-imports/runtime-fixture.js';

export const correctionActor: Principal = {
  id: '1',
  role: 1,
  userType: 1,
  storeIds: ['1'],
  name: 'Fixture manager',
  email: '',
};
export const correctionClock = Date.parse('2026-11-17T12:00:00.000Z');
export const correctionSecret = runtimeImportSecret;

export async function correctionFixture(template: string) {
  const native = await orderImportRuntimeFixture(template);
  for (const path of [
    'migrations/0002_auth_sessions.sql',
    'migrations/0006_operator_auth_epochs.sql',
    'src/modules/administration/migration.sql',
    'src/modules/legacy-order-imports/correction-migration.sql',
    'src/modules/legacy-order-imports/correction-command-migration.sql',
  ])
    for (const statement of splitMigration(readFileSync(path, 'utf8')))
      await native.connection.query(statement);
  const contexts = new Map<string, ImportFinancialStart>();
  let payable = '50.00',
    qualified = true,
    proofAvailable = true,
    noCalculation = false,
    inspections = 0;
  // This is deliberately an isolated typed financial-core boundary port. These
  // tests certify coordinator/authority/atomicity, not external source receipts.
  const boundary: ImportCorrectionBoundaryPort = {
    async inspectRejectedBoundary(_tx, input) {
      inspections++;
      const original = contexts.get(input.scope.operationId);
      if (!proofAvailable || !original || original.planHash !== input.planHash)
        throw new Error('Unproved original source outcome.');
      return {
        contract: 'pos-import-rejected-boundary-v1',
        scope: input.scope,
        planHash: input.planHash,
        financialRequestHash: 'a'.repeat(64),
        namespace: 'pos-import-v1:' + input.scope.operationId,
        stageNonce: '63ce1b77-b1cf-4c9f-a517-d8913d2eb659',
        stageRequestHash: 'b'.repeat(64),
        rejectionHash: 'c'.repeat(64),
        rejectionCode: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
        rejectedAt: correctionClock,
        customerId: '9007199254740994',
        contact: { revision: '0', digest: 'd'.repeat(64) },
        noFinancialEffects: true,
        calculation: noCalculation
          ? null
          : {
              payable,
              calculationHash: 'e'.repeat(64),
              profileQualified: qualified,
              profileCode: qualified ? null : 'ORDER_IMPORT_AUTO_BENEFIT_PROFILE_REQUIRED',
            },
      };
    },
  };
  const corrections = legacyOrderImportCorrections(native.db, native.config, {
      secret: correctionSecret,
      contract: 'pos-import-manager-correction-v1',
      boundary,
      clock: () => correctionClock,
    }),
    queue = legacyOrderImportRepository(native.db, {
      secret: correctionSecret,
      now: () => correctionClock,
      correctionForOperation: corrections.correctionForOperation,
    });
  async function reset() {
    for (const table of [
      'pos_rewrite_import_corrections',
      'pos_rewrite_import_correction_commands',
      'pos_rewrite_sessions',
      'pos_rewrite_operator_checkins',
      'pos_rewrite_operator_auth_epochs',
    ])
      await native.connection.query('DELETE FROM ' + table);
    await native.reset();
    await native.connection.query(
      "INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,expires_at,checked_in_at) VALUES('1',1,2,'2099-01-01 00:00:00','2026-11-17 12:00:00')",
    );
    payable = '50.00';
    qualified = true;
    proofAvailable = true;
    noCalculation = false;
    inspections = 0;
    contexts.clear();
    const session = await mysqlSessions(native.db).create('1', Date.parse('2099-01-01T00:00:00Z'));
    return session;
  }
  async function original(sibling = true) {
    const input = runtimeImportInput(),
      line = input.csv.split('\n')[1]!;
    if (sibling) input.csv += '\n' + line.replace('fixture-reference', 'fixture-sibling');
    await queue.stage('1', 'fixture-original-upload', input);
    await queue.runOne({
      async start(start) {
        contexts.set(start.operationId, start);
        return {
          status: 'rejected',
          operationId: start.operationId,
          code: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
        };
      },
      async read() {
        return null;
      },
    });
    if (sibling)
      await queue.runOne({
        async start(start) {
          return {
            status: 'completed',
            operationId: start.operationId,
            orderId: '9007199254741999',
            receiptId: randomUUID(),
            businessDate: start.plan.createdAt.slice(0, 10),
            projectionHash: 'f'.repeat(64),
          };
        },
        async read() {
          return null;
        },
      });
    const [row] = await native.db
      .get('writer')
      .select()
      .from(legacyOrderImportRows)
      .where(eq(legacyOrderImportRows.jobId, input.id))
      .orderBy(legacyOrderImportRows.sequence);
    if (!row) throw new Error('Expected the original failed import row.');
    return { jobId: input.id, operationId: row.operationId };
  }
  return {
    ...native,
    corrections,
    queue,
    contexts,
    boundary,
    reset,
    original,
    inspections: () => inspections,
    setPayable: (value: string) => {
      payable = value;
    },
    setQualified: (value: boolean) => {
      qualified = value;
    },
    setProofAvailable: (value: boolean) => {
      proofAvailable = value;
    },
    setNoCalculation: (value: boolean) => {
      noCalculation = value;
    },
  };
}
export function correctionCommand(reviewHash: string, tender = '50.00'): ImportCorrectionInput {
  return {
    id: randomUUID(),
    successorJobId: randomUUID(),
    successorOperationId: randomUUID(),
    reviewHash,
    historicalTenderAmount: tender,
    evidenceId: randomUUID(),
    confirmHistoricalTender: true,
    lines: [{ row: 2, unitPrice: '25.49' }],
  };
}
