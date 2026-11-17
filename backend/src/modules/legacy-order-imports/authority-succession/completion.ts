import type { ImportCompletedProof } from '../financial-adapter-contracts.js';
import { successionSnapshotSchema } from './contracts.js';
import { importFinancialError } from '../financial-adapter-primitives.js';
/** Enclosing financial seal MUST be checked first. Original source keys, current
 * actor/contact/configuration are not required to recognize completed money. */
export function assertCompletedAuthoritySuccession(proof: ImportCompletedProof) {
  if (proof.authoritySuccession === undefined) return;
  const value = successionSnapshotSchema.parse(proof.authoritySuccession),
    last = value.grants.at(-1);
  if (
    !last ||
    value.head.id !== last.data.id ||
    value.head.sequence !== last.data.sequence ||
    value.head.hash !== last.sourceHash
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  for (let index = 0; index < value.grants.length; index++) {
    const envelope = value.grants[index]!,
      g = envelope.data,
      prior = value.grants[index - 1];
    if (
      g.sequence !== index + 1 ||
      JSON.stringify(g.originalScope) !== JSON.stringify(proof.scope) ||
      g.namespace !== proof.order.namespace ||
      g.requestHash !== proof.requestHash ||
      g.planHash !== proof.planHash ||
      g.orderId !== proof.order.orderId ||
      g.headerHash !== proof.order.headerHash ||
      g.lineHash !== proof.order.lineHash ||
      g.authority.customerId !== proof.authority.customerId ||
      g.businessDate !== proof.businessDate ||
      JSON.stringify(g.previous) !==
        JSON.stringify(
          prior
            ? { id: prior.data.id, sequence: prior.data.sequence, hash: prior.sourceHash }
            : null,
        )
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  }
  const reference = proof.membership?.reference;
  if (reference) {
    const grant = value.grants.find((item) => item.data.id === reference.data.grantId);
    if (
      !grant ||
      grant.data.managerId !== reference.data.managerId ||
      grant.data.issuedAt !== reference.data.approvedAt ||
      grant.data.orderId !== reference.data.orderId
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  }
  const stagedReference = proof.membership?.stagedReference;
  if (stagedReference) {
    const grant = value.grants.find((item) => item.data.id === stagedReference.data.grantId);
    if (
      !grant ||
      grant.data.managerId !== stagedReference.data.managerId ||
      grant.data.issuedAt !== stagedReference.data.approvedAt ||
      grant.data.orderId !== stagedReference.data.orderId
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  }
  for (const claim of value.claims) {
    const grant = value.grants.find((v) => v.data.id === claim.grant.id);
    if (
      !grant ||
      claim.operationId !== proof.scope.operationId ||
      claim.grant.sequence !== grant.data.sequence ||
      claim.grant.hash !== grant.sourceHash
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  }
  for (const stage of ['confirmation', 'settlement', 'publication'] as const) {
    const applied = value.applied[stage];
    if (
      applied &&
      !value.claims.some(
        (c) => c.stage === stage && JSON.stringify(c.grant) === JSON.stringify(applied),
      )
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  }
  if (
    JSON.stringify(proof.settlement.succession ?? null) !==
      JSON.stringify(value.applied.settlement) ||
    JSON.stringify(proof.publication.succession ?? null) !==
      JSON.stringify(value.applied.publication)
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
}
