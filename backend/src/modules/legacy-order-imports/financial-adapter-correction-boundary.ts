import { and, eq, sql } from 'drizzle-orm';
import type { ImportCorrectionBoundaryPort } from './correction-contracts.js';
import { importCorrectionBoundarySchema } from './correction-contracts.js';
import {
  financialImportPlanSchema,
  sourceRejectionReceiptSchema,
} from './financial-adapter-contracts.js';
import {
  financialImportOrderBindings,
  financialImportCloseImpacts,
  financialImportProofs,
  financialImportSourceEffects,
  financialImportSourceReceipts,
  financialImportStages,
} from './financial-adapter-schema.js';
import { lockFinancialImportScope } from './financial-adapter-authority.js';
import { readFinancialImportRecord } from './financial-adapter-record.js';
import {
  equalImportHash,
  expectedFinancialPlanHash,
  financialImportHash,
  financialSourceHash,
  importFinancialError,
} from './financial-adapter-crypto.js';

const unavailable = () => importFinancialError('ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED');

/** A rejected HTTP response or absence of an order is never sufficient proof. */
export function financialImportCorrectionBoundary(options: {
  secret: string;
  sourceProofKey: string;
}): ImportCorrectionBoundaryPort {
  return {
    async inspectRejectedBoundary(tx, input) {
      if (!/^[!-~]{32,4096}$/.test(options.sourceProofKey)) throw unavailable();
      await lockFinancialImportScope(tx, input.scope);
      const loaded = await readFinancialImportRecord(tx, input.scope, options.secret);
      if (
        !loaded ||
        loaded.state.status !== 'rejected' ||
        loaded.state.orderId !== null ||
        loaded.state.stage !== 'order' ||
        loaded.state.planHash !== input.planHash ||
        !equalImportHash(
          expectedFinancialPlanHash(options.secret, input.scope, input.plan, input.correction),
          input.planHash,
        ) ||
        !equalImportHash(
          financialImportHash(options.secret, 'plan-equivalence', loaded.plan),
          financialImportHash(
            options.secret,
            'plan-equivalence',
            financialImportPlanSchema.parse(input.plan),
          ),
        ) ||
        !equalImportHash(
          financialImportHash(
            options.secret,
            'correction-equivalence',
            loaded.state.correction ?? null,
          ),
          financialImportHash(options.secret, 'correction-equivalence', input.correction ?? null),
        )
      )
        throw unavailable();
      // Current access is required above. A later login/contact epoch does not
      // erase this immutable no-effect receipt; a successor requires fresh approval.
      const stages = await tx
        .select({
          kind: financialImportStages.kind,
          status: financialImportStages.status,
          nonce: financialImportStages.nonce,
          requestHash: financialImportStages.requestHash,
          proofHash: financialImportStages.proofHash,
          createdAt: financialImportStages.createdAt,
          hasProof: sql<number>`(${financialImportStages.proof} IS NOT NULL AND JSON_TYPE(${financialImportStages.proof})<>'NULL')`,
        })
        .from(financialImportStages)
        .where(eq(financialImportStages.operationId, input.scope.operationId))
        .limit(6)
        .for('update');
      const stage = stages[0];
      if (
        stages.length !== 1 ||
        !stage ||
        stage.kind !== 'order' ||
        stage.status !== 'dispatched' ||
        Number(stage.hasProof) !== 0 ||
        stage.proofHash !== null ||
        !equalImportHash(
          stage.requestHash,
          financialImportHash(options.secret, 'stage', {
            scope: loaded.state.scope,
            kind: 'order',
            requestHash: loaded.state.requestHash,
            nonce: stage.nonce,
          }),
        )
      )
        throw unavailable();
      const receipts = await tx
        .select({
          id: financialImportSourceReceipts.id,
          kind: financialImportSourceReceipts.kind,
          status: financialImportSourceReceipts.status,
        })
        .from(financialImportSourceReceipts)
        .where(eq(financialImportSourceReceipts.operationId, input.scope.operationId))
        .limit(6)
        .for('update');
      const negativeHead = receipts[0];
      if (
        receipts.length !== 1 ||
        !negativeHead ||
        negativeHead.kind !== 'order' ||
        negativeHead.status !== 'rejected'
      )
        throw unavailable();
      const [negative] = await tx
        .select()
        .from(financialImportSourceReceipts)
        .where(
          and(
            eq(financialImportSourceReceipts.id, negativeHead.id),
            sql`OCTET_LENGTH(${financialImportSourceReceipts.proof})<=16000`,
          ),
        )
        .limit(1)
        .for('update');
      if (!negative) throw unavailable();
      const proof = sourceRejectionReceiptSchema.parse(negative.proof);
      if (
        proof.operationId !== input.scope.operationId ||
        proof.namespace !== loaded.state.namespace ||
        proof.requestHash !== loaded.state.requestHash ||
        negative.requestHash !== proof.requestHash ||
        proof.code !== loaded.state.errorCode ||
        !equalImportHash(
          negative.proofHash,
          financialSourceHash(options.sourceProofKey, 'rejection', proof),
        )
      )
        throw unavailable();
      const [bindings, completions, effects, closeImpacts] = await Promise.all([
        tx
          .select({ id: financialImportOrderBindings.orderId })
          .from(financialImportOrderBindings)
          .where(eq(financialImportOrderBindings.operationId, input.scope.operationId))
          .limit(1)
          .for('share'),
        tx
          .select({ id: financialImportProofs.id })
          .from(financialImportProofs)
          .where(eq(financialImportProofs.operationId, input.scope.operationId))
          .limit(1)
          .for('share'),
        tx
          .select({ id: financialImportSourceEffects.operationId })
          .from(financialImportSourceEffects)
          .where(eq(financialImportSourceEffects.operationId, input.scope.operationId))
          .limit(1)
          .for('share'),
        tx
          .select({ id: financialImportCloseImpacts.id })
          .from(financialImportCloseImpacts)
          .where(eq(financialImportCloseImpacts.operationId, input.scope.operationId))
          .limit(1)
          .for('share'),
      ]);
      if (bindings.length || completions.length || effects.length || closeImpacts.length)
        throw unavailable();
      if (proof.review) {
        const { calculation, planHash, stageNonce, rejectedAt } = proof.review;
        if (
          planHash !== loaded.state.planHash ||
          stageNonce !== stage.nonce ||
          rejectedAt < stage.createdAt ||
          rejectedAt > negative.createdAt ||
          !equalImportHash(
            calculation.calculationHash,
            financialSourceHash(options.sourceProofKey, 'calculation', {
              operationId: input.scope.operationId,
              requestHash: loaded.state.requestHash,
              namespace: loaded.state.namespace,
              planHash,
              stageNonce,
              rejectedAt,
              payable: calculation.payable,
              profileQualified: calculation.profileQualified,
              profileCode: calculation.profileCode,
            }),
          )
        )
          throw unavailable();
      }
      return importCorrectionBoundarySchema.parse({
        contract: 'pos-import-rejected-boundary-v1',
        scope: loaded.state.scope,
        planHash: loaded.state.planHash,
        financialRequestHash: loaded.state.requestHash,
        namespace: loaded.state.namespace,
        stageNonce: stage.nonce,
        stageRequestHash: stage.requestHash,
        rejectionHash: negative.proofHash,
        rejectionCode: proof.code,
        rejectedAt: proof.review?.rejectedAt ?? negative.createdAt,
        customerId: loaded.state.authority.customerId,
        contact: {
          revision: loaded.state.authority.contact.revision,
          digest: loaded.state.authority.contact.digest,
        },
        noFinancialEffects: true,
        calculation: proof.review?.calculation ?? null,
      });
    },
  };
}
