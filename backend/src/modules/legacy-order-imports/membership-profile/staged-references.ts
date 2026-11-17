import { and, eq, sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { assertCheckoutProjection } from '../../checkout/projection.js';
import {
  financialImportSourceReceipts,
  financialImportStages,
} from '../financial-adapter-schema.js';
import {
  sourceConfirmationReceiptSchema,
  type ImportFinancialState,
  type SourceOrderReceipt,
} from '../financial-adapter-contracts.js';
import { financialSourceHash, equalImportHash } from '../financial-adapter-crypto.js';
import { csvMembershipError, type CsvMembershipProvenance } from './domain.js';
import type { CsvMembershipOptions } from './native.js';
import { proveMembershipContactTransfer } from './references.js';
import {
  csvMembershipStagedReferenceContract,
  csvMembershipStagedReferenceSchema,
  csvMembershipReferenceActivationSchema,
  stagedReferenceHash,
  referenceActivationHash,
  assertReferenceActivationMutation,
  type CsvMembershipStagedReference,
} from './staged-reference-contracts.js';
import { csvMembershipStagedReferences } from './staged-reference-schema.js';
type Facts = Omit<CsvMembershipStagedReference['data'], 'grantId' | 'managerId' | 'approvedAt'>;

export async function stagedMembershipReference(
  tx: AdministrationTransaction,
  input: {
    state: ImportFinancialState;
    order: SourceOrderReceipt;
    sourceReceiptHash: string;
    original: CsvMembershipProvenance;
    currentEmail: string;
    currentRevision: string;
    rows: CsvMembershipStagedReference['data']['currentRows'];
    sourceRecordedAt: number;
  },
  options: CsvMembershipOptions,
): Promise<Facts> {
  if (
    options.stagedReferenceContract !== csvMembershipStagedReferenceContract ||
    !options.contactSecret ||
    BigInt(input.currentRevision) <= BigInt(input.original.revision)
  )
    throw csvMembershipError();
  const transfer = await proveMembershipContactTransfer(
    tx,
    {
      customerId: input.order.customerId,
      provenance: input.original,
      currentEmail: input.currentEmail,
      rows: input.rows,
      notBefore: input.sourceRecordedAt,
    },
    options,
  );
  return {
    contract: csvMembershipStagedReferenceContract,
    operationId: input.state.scope.operationId,
    requestHash: input.state.requestHash,
    planHash: input.state.planHash,
    namespace: input.state.namespace,
    orderId: input.order.orderId,
    customerId: input.order.customerId,
    sourceReceiptHash: input.sourceReceiptHash,
    original: input.original,
    currentEntity: transfer.currentEntity,
    currentRevision: input.currentRevision,
    currentRows: input.rows,
    transfers: transfer.transfers,
  };
}
export async function captureStagedMembershipReference(
  tx: AdministrationTransaction,
  facts: Facts,
  approval: { id: string; managerId: string; issuedAt: number },
  options: CsvMembershipOptions,
) {
  if (approval.issuedAt < facts.transfers.at(-1)!.committedAt) throw csvMembershipError();
  const data = {
      ...facts,
      grantId: approval.id,
      managerId: approval.managerId,
      approvedAt: approval.issuedAt,
    },
    proof = csvMembershipStagedReferenceSchema.parse({
      data,
      sourceHash: stagedReferenceHash(data, options.sourceProofKey),
    });
  const [prior] = await tx
    .select()
    .from(csvMembershipStagedReferences)
    .where(eq(csvMembershipStagedReferences.id, proof.sourceHash))
    .limit(1)
    .for('share');
  if (prior) {
    if (
      prior.operationId !== facts.operationId ||
      prior.orderId !== facts.orderId ||
      prior.grantId !== approval.id ||
      JSON.stringify(prior.data) !== JSON.stringify(proof)
    )
      throw csvMembershipError();
  } else
    await tx.insert(csvMembershipStagedReferences).values({
      id: proof.sourceHash,
      operationId: facts.operationId,
      orderId: facts.orderId,
      grantId: approval.id,
      data: proof,
      createdAt: approval.issuedAt,
    });
  return proof;
}
export async function readStagedMembershipReference(
  tx: AdministrationTransaction,
  operationId: string,
  grantId: string,
  options: CsvMembershipOptions,
) {
  const [row] = await tx
    .select()
    .from(csvMembershipStagedReferences)
    .where(
      and(
        eq(csvMembershipStagedReferences.operationId, operationId),
        eq(csvMembershipStagedReferences.grantId, grantId),
        sql`OCTET_LENGTH(${csvMembershipStagedReferences.data})<=262144`,
      ),
    )
    .limit(1)
    .for('share');
  if (!row) throw csvMembershipError();
  const proof = csvMembershipStagedReferenceSchema.parse(row.data);
  if (
    row.id !== proof.sourceHash ||
    proof.data.operationId !== operationId ||
    proof.data.grantId !== grantId ||
    proof.data.orderId !== row.orderId ||
    !equalImportHash(proof.sourceHash, stagedReferenceHash(proof.data, options.sourceProofKey))
  )
    throw csvMembershipError();
  return proof;
}
export function sameStagedReferenceFacts(proof: CsvMembershipStagedReference, facts: Facts) {
  const { grantId: _grant, managerId: _manager, approvedAt: _at, ...body } = proof.data;
  if (JSON.stringify(body) !== JSON.stringify(facts)) throw csvMembershipError();
}

/** Original confirmation + transition are native source facts in one Go TX.
 * This does not authorize another activation or consult current eligibility. */
export async function readMembershipReferenceActivation(
  tx: AdministrationTransaction,
  input: {
    state: ImportFinancialState;
    order: SourceOrderReceipt;
    original: CsvMembershipProvenance;
    current: CsvMembershipProvenance;
    sourceReceiptHash: string;
    source: { kind: 'new' | 'upgrade' | 'auto-free'; productId: string };
  },
  options: CsvMembershipOptions,
) {
  const [row] = await tx
    .select()
    .from(financialImportSourceReceipts)
    .where(
      and(
        eq(financialImportSourceReceipts.operationId, input.state.scope.operationId),
        eq(financialImportSourceReceipts.kind, 'member-reference'),
        sql`OCTET_LENGTH(${financialImportSourceReceipts.proof})<=262144`,
      ),
    )
    .limit(1)
    .for('share');
  const parsed = csvMembershipReferenceActivationSchema.safeParse(row?.proof);
  if (
    !row ||
    !parsed.success ||
    row.status !== 'completed' ||
    row.requestHash !== input.state.requestHash ||
    !equalImportHash(row.proofHash, referenceActivationHash(parsed.data, options.sourceProofKey))
  )
    throw csvMembershipError();
  const activation = parsed.data;
  const [referenceRow] = await tx
    .select({ grantId: csvMembershipStagedReferences.grantId })
    .from(csvMembershipStagedReferences)
    .where(eq(csvMembershipStagedReferences.id, activation.referenceHash))
    .limit(1)
    .for('share');
  if (!referenceRow) throw csvMembershipError();
  const reference = await readStagedMembershipReference(
      tx,
      input.state.scope.operationId,
      referenceRow.grantId,
      options,
    ),
    expected = reference.data;
  const [confirmationRow] = await tx
    .select()
    .from(financialImportSourceReceipts)
    .where(
      and(
        eq(financialImportSourceReceipts.operationId, input.state.scope.operationId),
        eq(financialImportSourceReceipts.kind, 'confirmation'),
        sql`OCTET_LENGTH(${financialImportSourceReceipts.proof})<=16000`,
      ),
    )
    .limit(1)
    .for('share');
  const confirmed = sourceConfirmationReceiptSchema.safeParse(confirmationRow?.proof);
  const [stage] = await tx
    .select({ nonce: financialImportStages.nonce })
    .from(financialImportStages)
    .where(
      and(
        eq(financialImportStages.operationId, input.state.scope.operationId),
        eq(financialImportStages.kind, 'confirmation'),
      ),
    )
    .limit(1)
    .for('share');
  if (
    row.id !== input.state.scope.operationId + ':member-reference' ||
    activation.operationId !== input.state.scope.operationId ||
    activation.requestHash !== input.state.requestHash ||
    activation.planHash !== input.state.planHash ||
    activation.orderId !== input.order.orderId ||
    activation.customerId !== input.order.customerId ||
    activation.sourceReceiptHash !== input.sourceReceiptHash ||
    activation.originalStageHash !== input.original.proofHash ||
    activation.referenceHash !== reference.sourceHash ||
    expected.sourceReceiptHash !== input.sourceReceiptHash ||
    expected.operationId !== input.state.scope.operationId ||
    expected.requestHash !== input.state.requestHash ||
    expected.planHash !== input.state.planHash ||
    expected.namespace !== input.state.namespace ||
    expected.orderId !== input.order.orderId ||
    expected.customerId !== input.order.customerId ||
    JSON.stringify(expected.original) !== JSON.stringify(input.original) ||
    JSON.stringify(activation.activation) !== JSON.stringify(input.current) ||
    input.current.entityDigest !== expected.currentEntity ||
    JSON.stringify(input.current.before) !== JSON.stringify(input.original.before) ||
    !stage ||
    activation.nonce !== stage.nonce ||
    !confirmationRow ||
    !confirmed.success ||
    confirmationRow.status !== 'completed' ||
    confirmationRow.requestHash !== input.state.requestHash ||
    activation.confirmationHash !== confirmationRow.proofHash ||
    !equalImportHash(
      confirmationRow.proofHash,
      financialSourceHash(options.sourceProofKey, 'confirmation', confirmed.data),
    ) ||
    confirmed.data.operationId !== activation.operationId ||
    confirmed.data.orderId !== activation.orderId ||
    confirmed.data.requestHash !== activation.requestHash ||
    confirmed.data.nonce !== activation.nonce ||
    confirmed.data.headerHash !== input.order.headerHash ||
    confirmed.data.succession?.id !== expected.grantId
  )
    throw csvMembershipError();
  assertReferenceActivationMutation(reference, activation, input.source);
  await assertCheckoutProjection(tx, {
    orderId: input.order.orderId,
    storeId: input.order.storeId,
    counterId: input.order.counterId,
    customerId: input.order.customerId,
  });
  return { reference, activation, sourceHash: row.proofHash };
}
