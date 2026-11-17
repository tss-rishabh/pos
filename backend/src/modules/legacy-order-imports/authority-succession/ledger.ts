import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { ImportFinancialState } from '../financial-adapter-contracts.js';
import {
  financialImportStages,
  financialImportSourceReceipts,
} from '../financial-adapter-schema.js';
import {
  financialImportHash,
  financialSourceHash,
  equalImportHash,
  importFinancialError,
} from '../financial-adapter-crypto.js';
import {
  successionEnvelopeSchema,
  successionClaimSchema,
  successionSnapshotSchema,
  successionReferenceSchema,
  type ImportSuccessionEnvelope,
  type ImportSuccessionReference,
  type ImportSuccessionClaim,
  type ImportSuccessionStage,
} from './contracts.js';
import {
  importAuthorityHeads,
  importAuthoritySuccessions,
  importAuthorityStageClaims,
} from './schema.js';
export interface SuccessionKeys {
  secret: string;
  sourceAuthKey?: string;
}
export const successionRef = (value: ImportSuccessionEnvelope): ImportSuccessionReference => ({
  id: value.data.id,
  sequence: value.data.sequence,
  hash: value.sourceHash,
});
export function successionGrantProof(
  row: Omit<typeof importAuthoritySuccessions.$inferSelect, 'proofHash'>,
  key: string,
) {
  return financialImportHash(key, 'authority-succession-record', row);
}
export function successionHeadProof(
  row: Omit<typeof importAuthorityHeads.$inferSelect, 'proofHash'>,
  key: string,
) {
  return financialImportHash(key, 'authority-succession-head', row);
}
export function verifySuccessionGrant(
  row: typeof importAuthoritySuccessions.$inferSelect,
  state: ImportFinancialState,
  keys: SuccessionKeys,
  sourceRequired = true,
) {
  const envelope = successionEnvelopeSchema.parse(row.data),
    g = envelope.data,
    { proofHash, ...body } = row;
  if (
    !equalImportHash(proofHash, successionGrantProof(body, keys.secret)) ||
    g.id !== row.id ||
    g.sequence !== row.sequence ||
    g.originalScope.operationId !== row.operationId ||
    g.managerId !== row.managerId ||
    g.sessionDigest !== createHash('sha256').update(row.managerSessionId).digest('hex') ||
    g.issuedAt !== row.createdAt ||
    g.namespace !== state.namespace ||
    g.requestHash !== state.requestHash ||
    g.planHash !== state.planHash ||
    JSON.stringify(g.originalScope) !== JSON.stringify(state.scope) ||
    g.authority.customerId !== state.authority.customerId ||
    g.authority.approvalId !== null ||
    g.expiresAt !== g.issuedAt + 3600000 ||
    g.reviewedAt > g.issuedAt
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  if (
    sourceRequired &&
    (!keys.sourceAuthKey ||
      !equalImportHash(
        envelope.sourceHash,
        financialSourceHash(keys.sourceAuthKey, 'authority-succession', g),
      ) ||
      !equalImportHash(
        g.originalAuthorityHash,
        financialSourceHash(keys.sourceAuthKey, 'succession-original-authority', state.authority),
      ))
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  return envelope;
}
export async function readSuccessionHead(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
  keys: SuccessionKeys,
  sourceRequired = true,
) {
  const [head] = await tx
    .select()
    .from(importAuthorityHeads)
    .where(eq(importAuthorityHeads.operationId, state.scope.operationId))
    .limit(1)
    .for('update');
  if (!head) {
    if (state.authoritySuccession)
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
    return null;
  }
  const { proofHash, ...body } = head;
  if (
    !equalImportHash(proofHash, successionHeadProof(body, keys.secret)) ||
    !state.authoritySuccession ||
    head.grantId !== state.authoritySuccession.id ||
    head.sequence !== state.authoritySuccession.sequence ||
    head.sourceHash !== state.authoritySuccession.hash
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  const [row] = await tx
    .select()
    .from(importAuthoritySuccessions)
    .where(
      and(
        eq(importAuthoritySuccessions.id, head.grantId),
        sql`OCTET_LENGTH(${importAuthoritySuccessions.data})<=16000`,
      ),
    )
    .limit(1)
    .for('share');
  if (!row) throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  return { head, envelope: verifySuccessionGrant(row, state, keys, sourceRequired), row };
}
export async function setActiveContinuation(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
  keys: SuccessionKeys,
  commandId: string,
) {
  const value = await readSuccessionHead(tx, state, keys);
  if (!value) throw importFinancialError('ORDER_IMPORT_SUCCESSION_REQUIRED');
  if (value.head.activeCommandId && value.head.activeCommandId !== commandId)
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_ORIGINAL_UNKNOWN');
  const { proofHash: _proof, ...fields } = { ...value.head, activeCommandId: commandId };
  await tx
    .update(importAuthorityHeads)
    .set({ activeCommandId: commandId, proofHash: successionHeadProof(fields, keys.secret) })
    .where(eq(importAuthorityHeads.operationId, state.scope.operationId));
  return value.envelope;
}
export async function claimSuccessionStage(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
  envelope: ImportSuccessionEnvelope,
  commandId: string,
  kind: ImportSuccessionStage,
  keys: SuccessionKeys,
  now: number,
) {
  const value = await readSuccessionHead(tx, state, keys);
  if (
    !value ||
    value.head.activeCommandId !== commandId ||
    value.envelope.sourceHash !== envelope.sourceHash
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_SCOPE_CHANGED');
  const id = state.scope.operationId + ':' + kind,
    [stage] = await tx
      .select()
      .from(financialImportStages)
      .where(eq(financialImportStages.id, id))
      .limit(1)
      .for('update');
  if (stage?.status === 'confirmed') return null;
  if (stage && stage.status !== 'dispatched')
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_ORIGINAL_UNKNOWN');
  const nonce = stage?.nonce ?? crypto.randomUUID(),
    stageRequestHash =
      stage?.requestHash ??
      financialImportHash(keys.secret, 'stage', {
        scope: state.scope,
        kind,
        requestHash: state.requestHash,
        nonce,
      });
  if (!stage)
    await tx.insert(financialImportStages).values({
      id,
      operationId: state.scope.operationId,
      kind,
      nonce,
      status: 'dispatched',
      requestHash: stageRequestHash,
      proofHash: null,
      proof: null,
      createdAt: now,
      updatedAt: now,
    });
  const claim = successionClaimSchema.parse({
      contract: envelope.data.contract,
      operationId: state.scope.operationId,
      stage: kind,
      nonce,
      stageRequestHash,
      grant: successionRef(envelope),
      commandId,
      claimedAt: now,
    }),
    claimId = id + ':' + envelope.data.id,
    [prior] = await tx
      .select()
      .from(importAuthorityStageClaims)
      .where(eq(importAuthorityStageClaims.id, claimId))
      .limit(1)
      .for('update');
  if (prior) throw importFinancialError('ORDER_IMPORT_SUCCESSION_ORIGINAL_UNKNOWN');
  const sourceHash = financialSourceHash(keys.sourceAuthKey ?? '', 'succession-stage', claim),
    fields = {
      id: claimId,
      operationId: state.scope.operationId,
      stage: kind,
      grantId: envelope.data.id,
      data: claim,
      sourceHash,
    };
  await tx.insert(importAuthorityStageClaims).values({
    ...fields,
    proofHash: financialImportHash(keys.secret, 'authority-succession-stage', fields),
  });
  return {
    nonce,
    issuedAt: now,
    expiresAt: Math.min(now + 60000, envelope.data.expiresAt),
    succession: envelope,
  };
}
export async function successionCompletionSnapshot(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
  keys: SuccessionKeys,
) {
  if (!state.authoritySuccession) return null;
  const latest = await readSuccessionHead(tx, state, keys);
  if (!latest) throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  const rows = await tx
    .select()
    .from(importAuthoritySuccessions)
    .where(eq(importAuthoritySuccessions.operationId, state.scope.operationId))
    .orderBy(asc(importAuthoritySuccessions.sequence))
    .limit(101)
    .for('share');
  if (!rows.length || rows.length > 100)
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  const grants = rows.map((row) => verifySuccessionGrant(row, state, keys));
  for (let index = 0; index < grants.length; index++) {
    const g = grants[index]!;
    if (
      g.data.sequence !== index + 1 ||
      JSON.stringify(g.data.previous) !==
        JSON.stringify(index ? successionRef(grants[index - 1]!) : null)
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  }
  const claims = await tx
    .select()
    .from(importAuthorityStageClaims)
    .where(eq(importAuthorityStageClaims.operationId, state.scope.operationId))
    .orderBy(asc(importAuthorityStageClaims.id))
    .limit(301)
    .for('share');
  if (claims.length > 300) throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  const result: ImportSuccessionClaim[] = [];
  for (const row of claims) {
    const { proofHash, ...body } = row,
      value = successionClaimSchema.parse(row.data),
      grant = grants.find((g) => g.data.id === row.grantId);
    if (
      !grant ||
      !equalImportHash(
        proofHash,
        financialImportHash(keys.secret, 'authority-succession-stage', body),
      ) ||
      !equalImportHash(
        row.sourceHash,
        financialSourceHash(keys.sourceAuthKey ?? '', 'succession-stage', value),
      ) ||
      JSON.stringify(value.grant) !== JSON.stringify(successionRef(grant)) ||
      value.operationId !== state.scope.operationId ||
      value.stage !== row.stage ||
      row.id !== value.operationId + ':' + value.stage + ':' + value.grant.id
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
    result.push(value);
  }
  const applied: {
    confirmation: ImportSuccessionReference | null;
    settlement: ImportSuccessionReference | null;
    publication: ImportSuccessionReference | null;
  } = { confirmation: null, settlement: null, publication: null };
  for (const stage of ['confirmation', 'settlement', 'publication'] as const) {
    const [native] =
      stage === 'settlement'
        ? await tx
            .select({ proof: financialImportStages.proof })
            .from(financialImportStages)
            .where(
              and(
                eq(financialImportStages.operationId, state.scope.operationId),
                eq(financialImportStages.kind, stage),
                eq(financialImportStages.status, 'confirmed'),
              ),
            )
            .limit(1)
            .for('share')
        : await tx
            .select({ proof: financialImportSourceReceipts.proof })
            .from(financialImportSourceReceipts)
            .where(
              and(
                eq(financialImportSourceReceipts.operationId, state.scope.operationId),
                eq(financialImportSourceReceipts.kind, stage),
                eq(financialImportSourceReceipts.status, 'completed'),
              ),
            )
            .limit(1)
            .for('share');
    if (native?.proof && typeof native.proof === 'object' && 'succession' in native.proof) {
      const ref = successionReferenceSchema.parse(native.proof.succession),
        claim = result.find(
          (v) => v.stage === stage && JSON.stringify(v.grant) === JSON.stringify(ref),
        );
      if (!claim) throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
      const [nativeStage] = await tx
        .select({ nonce: financialImportStages.nonce })
        .from(financialImportStages)
        .where(
          and(
            eq(financialImportStages.operationId, state.scope.operationId),
            eq(financialImportStages.kind, stage),
          ),
        )
        .limit(1)
        .for('share');
      if (!nativeStage || nativeStage.nonce !== claim.nonce)
        throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
      applied[stage] = ref;
    }
  }
  return successionSnapshotSchema.parse({
    contract: latest.envelope.data.contract,
    head: state.authoritySuccession,
    grants,
    claims: result,
    applied,
  });
}
