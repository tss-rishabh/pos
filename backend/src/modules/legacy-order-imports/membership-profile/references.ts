import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { assertCheckoutProjection } from '../../checkout/projection.js';
import { operationHash } from '../../checkout/crypto.js';
import { openContactEnvelope, openContactEffects } from '../../customer-contacts/crypto.js';
import { contactMutationReceipt } from '../../customer-contacts/contracts.js';
import { contactWallTime } from '../../customer-contacts/authority.js';
import {
  customerContactChallenges as challenges,
  customerContactDeliveries as deliveries,
  customerContactMutations as mutations,
} from '../../customer-contacts/schema.js';
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
import {
  csvMembershipError,
  type CsvMembershipProvenance,
  type csvMemberStateSchema,
} from './domain.js';
import type { z } from 'zod';
import type { CsvMembershipOptions } from './native.js';
import {
  csvMembershipReferenceContract,
  csvMembershipReferenceSchema,
  membershipReferenceHash,
  type CsvMembershipReference,
  type MembershipContactTransfer,
} from './reference-contracts.js';
import { csvMembershipReferences } from './reference-schema.js';

type Rows = z.infer<typeof csvMemberStateSchema>[];
type Input = {
  state: ImportFinancialState;
  order: SourceOrderReceipt;
  sourceReceiptHash: string;
  activation: CsvMembershipProvenance;
  currentEmail: string;
  currentRevision: string;
  rows: Rows;
};
export type ConsumedMembershipReference = Omit<
  CsvMembershipReference['data'],
  'grantId' | 'managerId' | 'approvedAt'
>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const entity = (value: string, options: CsvMembershipOptions) =>
  operationHash('pending-cancellation.membership-entity.v1', value, options.membershipProofKey);
const rowHash = (value: Rows, options: CsvMembershipOptions) =>
  operationHash(
    'legacy-order-imports.source.membership-reference-rows.v1',
    value,
    options.sourceProofKey,
  );

/** Caller already holds the current customer, Order and membership revision.
 * Contact commit/effect envelopes and mutation receipts are immutable evidence;
 * nonlocking reads avoid delivery-worker -> customer lock inversions. The
 * profile owns READ COMMITTED, so these reads cannot use an old RR snapshot.
 */
export async function consumedMembershipReference(
  tx: AdministrationTransaction,
  input: Input,
  options: CsvMembershipOptions,
): Promise<ConsumedMembershipReference> {
  if (
    options.referenceContract !== csvMembershipReferenceContract ||
    !options.contactSecret ||
    !/^[!-~]{32,4096}$/.test(options.contactSecret) ||
    !options.businessTimezone ||
    BigInt(input.currentRevision) <= BigInt(input.activation.revision)
  )
    throw csvMembershipError();
  try {
    const { state, order, activation } = input;
    const [confirmation] = await tx
      .select()
      .from(financialImportSourceReceipts)
      .where(
        and(
          eq(financialImportSourceReceipts.id, state.scope.operationId + ':confirmation'),
          sql`OCTET_LENGTH(${financialImportSourceReceipts.proof})<=16000`,
        ),
      )
      .limit(1)
      .for('share');
    const [stage] = await tx
      .select()
      .from(financialImportStages)
      .where(
        and(
          eq(financialImportStages.operationId, state.scope.operationId),
          eq(financialImportStages.kind, 'confirmation'),
        ),
      )
      .limit(1)
      .for('share');
    const confirmed = sourceConfirmationReceiptSchema.safeParse(confirmation?.proof);
    if (
      !confirmation ||
      !confirmed.success ||
      !stage ||
      stage.status !== 'confirmed' ||
      confirmation.kind !== 'confirmation' ||
      confirmation.status !== 'completed' ||
      confirmation.operationId !== state.scope.operationId ||
      confirmation.requestHash !== state.requestHash ||
      confirmed.data.operationId !== state.scope.operationId ||
      confirmed.data.requestHash !== state.requestHash ||
      confirmed.data.orderId !== order.orderId ||
      confirmed.data.customerId !== order.customerId ||
      confirmed.data.storeId !== order.storeId ||
      confirmed.data.counterId !== order.counterId ||
      confirmed.data.headerHash !== order.headerHash ||
      confirmed.data.nonce !== stage.nonce ||
      !equalImportHash(
        confirmation.proofHash,
        financialSourceHash(options.sourceProofKey, 'confirmation', confirmed.data),
      )
    )
      throw csvMembershipError();
    await assertCheckoutProjection(tx, {
      orderId: order.orderId,
      customerId: order.customerId,
      storeId: order.storeId,
      counterId: order.counterId,
    });

    const { transfers, currentEntity, currentRowsHash } = await proveMembershipContactTransfer(
      tx,
      {
        customerId: order.customerId,
        provenance: activation,
        currentEmail: input.currentEmail,
        rows: input.rows,
        notBefore: confirmed.data.confirmedAt,
      },
      options,
    );
    return {
      contract: csvMembershipReferenceContract,
      operationId: state.scope.operationId,
      requestHash: state.requestHash,
      planHash: state.planHash,
      namespace: state.namespace,
      orderId: order.orderId,
      customerId: order.customerId,
      sourceReceiptHash: input.sourceReceiptHash,
      confirmationHash: confirmation.proofHash,
      activation,
      currentEntity,
      currentRevision: input.currentRevision,
      currentRowsHash,
      transfers,
    };
  } catch {
    throw csvMembershipError();
  }
}

/** Genuine retained contact commit, reused by staged and consumed proofs. */
export async function proveMembershipContactTransfer(
  tx: AdministrationTransaction,
  input: {
    customerId: string;
    provenance: CsvMembershipProvenance;
    currentEmail: string;
    rows: Rows;
    notBefore: number;
  },
  options: CsvMembershipOptions,
) {
  if (!options.contactSecret || !options.businessTimezone) throw csvMembershipError();
  try {
    const candidates = await tx
      .select({
        id: challenges.id,
        customerId: challenges.customerId,
        operatorId: challenges.operatorId,
        storeId: challenges.storeId,
        checkoutId: challenges.checkoutId,
        kind: challenges.kind,
        stage: challenges.stage,
        status: challenges.status,
        currentVerifiedAt: challenges.currentVerifiedAt,
        newVerifiedAt: challenges.newVerifiedAt,
        createdAt: challenges.createdAt,
        expiresAt: challenges.expiresAt,
        encryptedInput: sql<
          string | null
        >`CASE WHEN OCTET_LENGTH(${challenges.encryptedInput})<=342000 THEN ${challenges.encryptedInput} ELSE NULL END`,
      })
      .from(challenges)
      .where(
        and(
          eq(challenges.customerId, input.customerId),
          eq(challenges.kind, 'email'),
          inArray(challenges.status, ['COMMITTING', 'COMMITTED', 'UNCERTAIN']),
        ),
      )
      .orderBy(asc(challenges.createdAt), asc(challenges.id))
      .limit(17);
    if (!candidates.length || candidates.length > 16) throw csvMembershipError();
    const transfers: MembershipContactTransfer[] = [];
    let previous = input.provenance.entityDigest;
    const transferWalls = new Set<string>();
    for (const challenge of candidates) {
      if (!challenge.encryptedInput) throw csvMembershipError();
      const envelope = openContactEnvelope(
          options.contactSecret,
          challenge.id,
          challenge.encryptedInput,
        ),
        before = entity(envelope.oldEmail, options);
      // Older unrelated changes cannot authenticate this activation's identity.
      if (transfers.some((value) => value.previousEntity === before)) throw csvMembershipError();
      if (before !== previous) continue;
      if (
        envelope.id !== challenge.id ||
        envelope.kind !== 'email' ||
        challenge.stage !== 'new' ||
        challenge.currentVerifiedAt === null ||
        challenge.newVerifiedAt === null
      )
        throw csvMembershipError();
      const effects = await tx
        .select({
          id: deliveries.id,
          challengeId: deliveries.challengeId,
          operatorId: deliveries.operatorId,
          customerId: deliveries.customerId,
          createdAt: deliveries.createdAt,
          encryptedPayload: sql<
            string | null
          >`CASE WHEN OCTET_LENGTH(${deliveries.encryptedPayload})<=342000 THEN ${deliveries.encryptedPayload} ELSE NULL END`,
        })
        .from(deliveries)
        .where(and(eq(deliveries.challengeId, challenge.id), eq(deliveries.kind, 'source-effects')))
        .limit(2);
      const delivery = effects[0];
      if (
        effects.length !== 1 ||
        !delivery?.encryptedPayload ||
        delivery.customerId !== input.customerId ||
        delivery.operatorId !== challenge.operatorId
      )
        throw csvMembershipError();
      const effect = openContactEffects(
          options.contactSecret,
          delivery.id,
          delivery.encryptedPayload,
        ),
        [mutation] = await tx
          .select()
          .from(mutations)
          .where(eq(mutations.id, effect.operationId))
          .limit(1),
        receipt = contactMutationReceipt.safeParse(mutation?.result);
      if (
        !mutation ||
        !receipt.success ||
        receipt.data.status !== 'success' ||
        receipt.data.id !== effect.operationId ||
        receipt.data.challengeId !== challenge.id ||
        receipt.data.checkoutVersion === undefined ||
        mutation.action !== 'commit' ||
        mutation.challengeId !== challenge.id ||
        mutation.operatorId !== challenge.operatorId ||
        mutation.checkoutId !== challenge.checkoutId ||
        mutation.createdAt !== delivery.createdAt ||
        mutation.createdAt < input.notBefore ||
        mutation.createdAt < challenge.createdAt ||
        mutation.createdAt >= challenge.expiresAt ||
        mutation.createdAt >= challenge.newVerifiedAt + 600000 ||
        challenge.currentVerifiedAt < challenge.createdAt ||
        challenge.newVerifiedAt < challenge.currentVerifiedAt ||
        challenge.currentVerifiedAt > mutation.createdAt ||
        challenge.newVerifiedAt > mutation.createdAt ||
        effect.kind !== 'email' ||
        effect.challengeId !== challenge.id ||
        effect.customerId !== input.customerId ||
        effect.operatorId !== challenge.operatorId ||
        effect.checkoutId !== challenge.checkoutId ||
        effect.storeId !== challenge.storeId ||
        effect.oldEmail !== envelope.oldEmail ||
        effect.newValue !== envelope.value ||
        effect.oldTelephone !== envelope.oldTelephone
      )
        throw csvMembershipError();
      const next = entity(effect.newValue, options);
      if (
        next === previous ||
        transfers.some((value) => value.previousEntity === previous || value.nextEntity === next)
      )
        throw csvMembershipError();
      transferWalls.add(contactWallTime(mutation.createdAt, options.businessTimezone));
      transfers.push({
        challengeId: challenge.id,
        operationId: mutation.id,
        deliveryId: delivery.id,
        inputHash: sha(challenge.encryptedInput),
        effectHash: sha(delivery.encryptedPayload),
        mutationHash: operationHash(
          'legacy-order-imports.source.membership-reference-contact-mutation.v1',
          {
            id: mutation.id,
            challengeId: mutation.challengeId,
            operatorId: mutation.operatorId,
            checkoutId: mutation.checkoutId,
            action: mutation.action,
            inputHash: mutation.inputHash,
            result: mutation.result,
            createdAt: mutation.createdAt,
          },
          options.sourceProofKey,
        ),
        previousEntity: previous,
        nextEntity: next,
        committedAt: mutation.createdAt,
      });
      previous = next;
    }
    if (
      !transfers.length ||
      previous !== entity(input.currentEmail, options) ||
      input.rows.length !== input.provenance.confirmed.length
    )
      throw csvMembershipError();
    for (const row of input.rows) {
      const original = input.provenance.confirmed.find(
        (value) => value.attribute === row.attribute,
      );
      if (
        !original ||
        row.value !== original.value ||
        row.active !== original.active ||
        row.createdAt !== original.createdAt ||
        (row.updatedAt !== original.updatedAt && !transferWalls.has(row.updatedAt))
      )
        throw csvMembershipError();
    }

    return { transfers, currentEntity: previous, currentRowsHash: rowHash(input.rows, options) };
  } catch {
    throw csvMembershipError();
  }
}

export async function captureMembershipReference(
  tx: AdministrationTransaction,
  facts: ConsumedMembershipReference,
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
    proof = csvMembershipReferenceSchema.parse({
      data,
      sourceHash: membershipReferenceHash(data, options.sourceProofKey),
    });
  const [prior] = await tx
    .select()
    .from(csvMembershipReferences)
    .where(eq(csvMembershipReferences.id, proof.sourceHash))
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
    return proof;
  }
  await tx.insert(csvMembershipReferences).values({
    id: proof.sourceHash,
    operationId: facts.operationId,
    orderId: facts.orderId,
    grantId: approval.id,
    data: proof,
    createdAt: approval.issuedAt,
  });
  return proof;
}

export async function readCapturedMembershipReference(
  tx: AdministrationTransaction,
  facts: ConsumedMembershipReference,
  grantId: string,
  options: CsvMembershipOptions,
) {
  const [row] = await tx
    .select()
    .from(csvMembershipReferences)
    .where(
      and(
        eq(csvMembershipReferences.operationId, facts.operationId),
        eq(csvMembershipReferences.grantId, grantId),
        sql`OCTET_LENGTH(${csvMembershipReferences.data})<=262144`,
      ),
    )
    .limit(1)
    .for('share');
  if (!row) throw csvMembershipError();
  const proof = csvMembershipReferenceSchema.parse(row.data),
    { grantId: _grant, managerId: _manager, approvedAt: _at, ...recorded } = proof.data;
  if (
    row.id !== proof.sourceHash ||
    row.orderId !== facts.orderId ||
    proof.data.grantId !== grantId ||
    !equalImportHash(
      proof.sourceHash,
      membershipReferenceHash(proof.data, options.sourceProofKey),
    ) ||
    JSON.stringify(recorded) !== JSON.stringify(facts)
  )
    throw csvMembershipError();
  return proof;
}
