import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, isNull, inArray, notExists } from 'drizzle-orm';
import { z } from 'zod';
import { operatorSessions } from '../../../auth/session-schema.js';
import { currentAuthenticationVersion } from '../../../auth/revocation.js';
import { PosUser } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { operationHash } from '../crypto.js';
import {
  cashReturnIntentBody,
  type CashReturnControl,
  type CashReturnIntentBody,
} from './intent-contracts.js';
import {
  cashReturnControls,
  cashReturnIntents,
  cashReturnPartitionControls,
} from './intent-schema.js';
import { paymentCorrectionOrders, paymentCorrectionCash } from './schema.js';
import { verifiedClaim } from './intent-claim-evidence.js';
import { cashReturnClaims, cashReturnClaimResolutions } from './intent-claim-schema.js';

export const intentReview = (code = 'CASH_RETURN_EVIDENCE_INVALID') =>
  new AppError(
    409,
    code,
    'The original cash-return intent needs manager reconciliation. Do not return cash again.',
  );
export const intentHash = (body: CashReturnIntentBody, secret: string) =>
  operationHash('cash-return.intent-state.v1', body, secret);
export const intentSessionHash = (userId: string, sessionId: string, secret: string) =>
  operationHash('cash-return.session.v1', { userId, sessionId }, secret);
export const instantSql = (instant: Temporal.Instant) =>
  instant
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime()
    .toString({ smallestUnit: 'millisecond' })
    .replace('T', ' ');
export const canonicalInstant = (instant: Temporal.Instant) =>
  instant.toString({ smallestUnit: 'millisecond' });
export function verifiedIntent(row: typeof cashReturnIntents.$inferSelect, secret: string) {
  const parsed = cashReturnIntentBody.safeParse(row.body);
  if (!parsed.success || secret.length < 32) throw intentReview();
  const body = parsed.data;
  if (
    row.bodyHash !== intentHash(body, secret) ||
    row.id !== body.id ||
    row.impactFrom !==
      [
        body.orderDate,
        body.originalFundingAt.slice(0, 10),
        ...(body.armed
          ? [
              Temporal.Instant.from(body.armed.at)
                .toZonedDateTimeISO(body.businessTimezone)
                .toPlainDate()
                .toString(),
            ]
          : []),
      ].sort()[0] ||
    row.createdAt !== instantSql(Temporal.Instant.from(body.preparedAt)) ||
    row.phase !== body.phase ||
    row.orderId !== body.orderId ||
    row.storeId !== body.storeId ||
    row.counterId !== body.counterId ||
    row.preparedBy !== body.preparedBy ||
    row.originalPaymentId !== body.prepare.originalPaymentId ||
    row.correctionId !== body.prepare.correctionId ||
    row.cashReturnReceiptId !== body.prepare.cashReturnReceiptId ||
    row.activePaymentId !== (body.phase === 'CANCELLED' ? null : body.prepare.originalPaymentId) ||
    body.id !== body.prepare.operationId ||
    body.preparedHash !==
      operationHash(
        'cash-return.prepared.v1',
        {
          id: body.id,
          orderId: body.orderId,
          storeId: body.storeId,
          preparedBy: body.preparedBy,
          preparedAt: body.preparedAt,
          prepare: body.prepare,
          originalPaymentHash: body.originalPaymentHash,
          orderDate: body.orderDate,
          originalFundingAt: body.originalFundingAt,
          businessTimezone: body.businessTimezone,
        },
        secret,
      ) ||
    (body.phase === 'PREPARED' &&
      (body.armed || body.attestation || body.cancellation || body.resolution)) ||
    (body.phase === 'CANCELLED' &&
      (!body.cancellation || body.armed || body.attestation || body.resolution)) ||
    (['RETURN_PENDING', 'ATTESTED', 'RECORDED'].includes(body.phase) &&
      (!body.armed || body.cancellation)) ||
    (body.phase === 'RETURN_PENDING' && (body.attestation || body.resolution)) ||
    (['ATTESTED', 'RECORDED'].includes(body.phase) && !body.attestation) ||
    (body.phase === 'ATTESTED' && body.resolution) ||
    (body.phase === 'RECORDED' &&
      (!body.resolution || body.resolution.correctionId !== body.prepare.correctionId))
  )
    throw intentReview();
  if (
    body.attestation &&
    (body.attestation.evidence.intentId !== body.id ||
      body.attestation.evidence.preparedHash !== body.preparedHash ||
      body.attestation.evidence.attestationId !== body.attestation.operationId ||
      body.attestation.input.operationId !== body.attestation.operationId ||
      body.attestation.evidence.attestedBy !== body.attestation.actorId ||
      body.attestation.evidence.returnedBy !== body.armed?.actorId ||
      body.attestation.evidence.returnedInstant !== body.attestation.input.returnedAt ||
      body.attestation.evidence.businessTimezone !== body.businessTimezone ||
      body.attestation.evidence.returnedAt !==
        Temporal.Instant.from(body.attestation.evidence.returnedInstant)
          .toZonedDateTimeISO(body.businessTimezone)
          .toPlainDateTime()
          .toString({ smallestUnit: 'second' })
          .replace('T', ' ') ||
      body.attestation.evidence.businessDate !== body.attestation.evidence.returnedAt.slice(0, 10))
  )
    throw intentReview();
  if (
    body.cancellation &&
    Temporal.Instant.compare(
      Temporal.Instant.from(body.cancellation.at),
      Temporal.Instant.from(body.preparedAt),
    ) < 0
  )
    throw intentReview();
  if (
    body.armed &&
    Temporal.Instant.compare(
      Temporal.Instant.from(body.armed.at),
      Temporal.Instant.from(body.preparedAt),
    ) < 0
  )
    throw intentReview();
  if (
    body.attestation &&
    (!body.armed ||
      Temporal.Instant.compare(
        Temporal.Instant.from(body.attestation.input.returnedAt),
        Temporal.Instant.from(body.armed.at),
      ) < 0 ||
      Temporal.Instant.compare(
        Temporal.Instant.from(body.attestation.input.returnedAt),
        Temporal.Instant.from(body.attestation.at),
      ) > 0)
  )
    throw intentReview();
  if (
    body.resolution &&
    (!body.attestation ||
      Temporal.Instant.compare(
        Temporal.Instant.from(body.resolution.at),
        Temporal.Instant.from(body.attestation.at),
      ) < 0)
  )
    throw intentReview();
  return body;
}
/** Caller has locked the current operator/check-in/store before this row lock. */
export async function assertIntentSession(
  tx: AdministrationTransaction,
  userId: string,
  sessionId: string,
  secret: string,
) {
  z.uuid().parse(sessionId);
  const [account] = await tx
    .select()
    .from(PosUser)
    .where(and(eq(PosUser.id, BigInt(userId)), eq(PosUser.is_active, true)))
    .limit(1)
    .for('share');
  if (!account) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  const [session] = await tx
    .select()
    .from(operatorSessions)
    .where(
      and(
        eq(operatorSessions.id, sessionId),
        eq(operatorSessions.userId, userId),
        isNull(operatorSessions.revokedAt),
        gt(operatorSessions.expiresAt, new Date()),
      ),
    )
    .limit(1)
    .for('share');
  if (!session || session.authVersion !== (await currentAuthenticationVersion(tx, account)))
    throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return intentSessionHash(userId, sessionId, secret);
}
export function publicIntent(body: CashReturnIntentBody) {
  return {
    id: body.id,
    contract: body.contract,
    revision: body.revision,
    phase: body.phase,
    orderId: body.orderId,
    storeId: body.storeId,
    counterId: body.counterId,
    preparedBy: body.preparedBy,
    preparedAt: body.preparedAt,
    correctionId: body.prepare.correctionId,
    cashReturnReceiptId: body.prepare.cashReturnReceiptId,
    originalPaymentId: body.prepare.originalPaymentId,
    returnedCash: body.prepare.returnedCash,
    reason: body.prepare.reason,
    armed: body.armed ? { actorId: body.armed.actorId, at: body.armed.at } : null,
    attestation: body.attestation
      ? {
          actorId: body.attestation.actorId,
          at: body.attestation.at,
          evidenceId: body.attestation.input.evidenceId,
          evidence: body.attestation.evidence,
        }
      : null,
    cancellation: body.cancellation
      ? {
          actorId: body.cancellation.actorId,
          at: body.cancellation.at,
          reason: body.cancellation.input.reason,
          evidenceId: body.cancellation.input.evidenceId,
        }
      : null,
    resolution: body.resolution
      ? {
          actorId: body.resolution.actorId,
          at: body.resolution.at,
          correctionId: body.resolution.correctionId,
        }
      : null,
  };
}
export function controlProof(
  row: Omit<typeof cashReturnControls.$inferSelect, 'proofHash'>,
  secret: string,
) {
  return operationHash(
    'cash-return.current-control.v1',
    { ...row, revision: String(row.revision) },
    secret,
  );
}
export function verifiedControl(
  row: typeof cashReturnControls.$inferSelect,
  secret: string,
): CashReturnControl {
  const { proofHash, ...fields } = row;
  if (
    secret.length < 32 ||
    row.revision < 1n ||
    proofHash !== controlProof(fields, secret) ||
    (row.unresolvedCount === 0) !== (row.pendingFrom === null) ||
    !Number.isSafeInteger(row.partitionCount) ||
    row.partitionCount < 0 ||
    (row.partitionCount === 0 &&
      (row.partitionManifestHash !== '0'.repeat(64) || row.unresolvedCount !== 0)) ||
    !/^[a-f0-9]{64}$/.test(row.partitionManifestHash)
  )
    throw intentReview();
  return {
    storeId: row.storeId,
    revision: String(row.revision),
    manifestHash: row.manifestHash,
    unresolvedCount: row.unresolvedCount,
  };
}
export const emptyControl = (storeId: string): CashReturnControl => ({
  storeId,
  revision: '0',
  manifestHash: '0'.repeat(64),
  unresolvedCount: 0,
});
export async function advanceFinancialControl(
  tx: AdministrationTransaction,
  event: { storeId: string; id: string; hash: string; dates: readonly string[] },
  delta: number,
  secret: string,
  now: string,
) {
  if (secret.length < 32 || !/^[a-f0-9]{64}$/.test(event.hash) || ![-1, 0, 1].includes(delta))
    throw intentReview();
  const [previous] = await tx
    .select()
    .from(cashReturnControls)
    .where(eq(cashReturnControls.storeId, event.storeId))
    .limit(1)
    .for('update');
  const old = previous ? verifiedControl(previous, secret) : emptyControl(event.storeId),
    revision = BigInt(old.revision) + 1n,
    unresolvedCount = old.unresolvedCount + delta;
  if (
    revision > 18446744073709551615n ||
    !Number.isSafeInteger(unresolvedCount) ||
    unresolvedCount < 0 ||
    unresolvedCount > 2147483647
  )
    throw intentReview();
  const existingPartitions = await tx
    .select()
    .from(cashReturnPartitionControls)
    .where(eq(cashReturnPartitionControls.storeId, event.storeId))
    .orderBy(asc(cashReturnPartitionControls.businessDate))
    .limit(70001)
    .for('update');
  verifyPartitionSet(existingPartitions, previous, secret);
  const pending = await tx
    .select()
    .from(cashReturnIntents)
    .where(
      and(
        eq(cashReturnIntents.storeId, event.storeId),
        inArray(cashReturnIntents.phase, ['RETURN_PENDING', 'ATTESTED']),
      ),
    )
    .orderBy(asc(cashReturnIntents.id))
    .limit(1001)
    .for('update');
  const claims = await tx
    .select()
    .from(cashReturnClaims)
    .where(
      and(
        eq(cashReturnClaims.storeId, event.storeId),
        notExists(
          tx
            .select({ id: cashReturnClaimResolutions.id })
            .from(cashReturnClaimResolutions)
            .where(eq(cashReturnClaimResolutions.id, cashReturnClaims.id)),
        ),
      ),
    )
    .orderBy(asc(cashReturnClaims.id))
    .limit(1001)
    .for('update');
  if (
    pending.length > 1000 ||
    claims.length > 1000 ||
    unresolvedCount !== pending.length + claims.length
  )
    throw intentReview();
  for (const row of pending) verifiedIntent(row, secret);
  for (const row of claims) verifiedClaim(row, secret);
  const pendingFrom = [...pending, ...claims].map((row) => row.impactFrom).sort()[0] ?? null;
  if ((unresolvedCount === 0) !== (pendingFrom === null)) throw intentReview();
  const fields = {
    storeId: event.storeId,
    revision,
    manifestHash: operationHash(
      'cash-return.control-step.v1',
      {
        previous: old.manifestHash,
        revision: String(revision),
        eventId: event.id,
        eventHash: event.hash,
      },
      secret,
    ),
    unresolvedCount,
    pendingFrom,
    partitionCount: previous?.partitionCount ?? 0,
    partitionManifestHash: previous?.partitionManifestHash ?? '0'.repeat(64),
    updatedAt: now,
  };
  const controlFields = fields;
  const dates = [...new Set(event.dates.map((value) => z.iso.date().parse(value)))].sort();
  if (!dates.length && delta !== 0) throw intentReview();
  const financial = new Map<string, Set<string>>();
  if (dates.length) {
    const orders = await tx
      .select({
        recordId: paymentCorrectionOrders.orderId,
        date: paymentCorrectionOrders.orderDate,
      })
      .from(paymentCorrectionOrders)
      .where(
        and(
          eq(paymentCorrectionOrders.storeId, event.storeId),
          inArray(paymentCorrectionOrders.orderDate, dates),
        ),
      )
      .limit(1001)
      .for('update');
    const movements = await tx
      .select({ recordId: paymentCorrectionCash.id, date: paymentCorrectionCash.businessDate })
      .from(paymentCorrectionCash)
      .where(
        and(
          eq(paymentCorrectionCash.storeId, event.storeId),
          inArray(paymentCorrectionCash.businessDate, dates),
        ),
      )
      .limit(10001)
      .for('update');
    if (orders.length > 1000 || movements.length > 10000) throw intentReview();
    for (const row of [
      ...orders.map((row) => ({ ...row, key: 'order:' + row.recordId })),
      ...movements.map((row) => ({ ...row, key: 'cash:' + row.recordId })),
    ]) {
      const group = financial.get(row.date) || new Set<string>();
      group.add(row.key);
      if (group.size > 11000) throw intentReview();
      financial.set(row.date, group);
    }
  }
  for (const date of dates) {
    const id = event.storeId + ':' + date,
      [previous] = await tx
        .select()
        .from(cashReturnPartitionControls)
        .where(eq(cashReturnPartitionControls.id, id))
        .limit(1)
        .for('update');
    if (previous) verifiedPartitionControl(previous, secret);
    const revision = (previous?.revision ?? 0n) + 1n;
    if (revision > 18446744073709551615n) throw intentReview();
    const fields = {
      id,
      storeId: event.storeId,
      businessDate: date,
      revision,
      financialFactCount: financial.get(date)?.size ?? 0,
      financialFactHash: financialScopeHash(
        event.storeId,
        date,
        [...(financial.get(date) || [])],
        secret,
      ),
      manifestHash: operationHash(
        'cash-return.partition-step.v1',
        {
          previous: previous?.manifestHash ?? '0'.repeat(64),
          revision: String(revision),
          eventId: event.id,
          eventHash: event.hash,
          financialFactCount: financial.get(date)?.size ?? 0,
          financialFactHash: financialScopeHash(
            event.storeId,
            date,
            [...(financial.get(date) || [])],
            secret,
          ),
        },
        secret,
      ),
      updatedAt: now,
    };
    const row = { ...fields, proofHash: partitionControlProof(fields, secret) };
    if (!previous) controlFields.partitionCount++;
    else
      controlFields.partitionManifestHash = xorControlDigest(
        controlFields.partitionManifestHash,
        partitionMemberHash(previous, secret),
      );
    controlFields.partitionManifestHash = xorControlDigest(
      controlFields.partitionManifestHash,
      partitionMemberHash(row, secret),
    );
    await tx.insert(cashReturnPartitionControls).values(row).onDuplicateKeyUpdate({ set: row });
  }
  const row = { ...controlFields, proofHash: controlProof(controlFields, secret) };
  await tx.insert(cashReturnControls).values(row).onDuplicateKeyUpdate({ set: row });
}
export async function advanceIntentControl(
  tx: AdministrationTransaction,
  body: CashReturnIntentBody,
  delta: number,
  secret: string,
  now: string,
) {
  const dates = [
    body.orderDate,
    body.originalFundingAt.slice(0, 10),
    ...(body.armed
      ? [
          Temporal.Instant.from(body.armed.at)
            .toZonedDateTimeISO(body.businessTimezone)
            .toPlainDate()
            .toString(),
        ]
      : []),
    ...(body.attestation ? [body.attestation.evidence.businessDate] : []),
  ];
  return advanceFinancialControl(
    tx,
    { storeId: body.storeId, id: body.id, hash: intentHash(body, secret), dates },
    delta,
    secret,
    now,
  );
}
export function partitionControlProof(
  row: Omit<typeof cashReturnPartitionControls.$inferSelect, 'proofHash'>,
  secret: string,
) {
  return operationHash(
    'cash-return.partition-control.v1',
    { ...row, revision: String(row.revision) },
    secret,
  );
}
export function verifiedPartitionControl(
  row: typeof cashReturnPartitionControls.$inferSelect,
  secret: string,
) {
  const { proofHash, ...fields } = row;
  if (
    secret.length < 32 ||
    row.id !== row.storeId + ':' + row.businessDate ||
    row.revision < 1n ||
    !Number.isSafeInteger(row.financialFactCount) ||
    row.financialFactCount < 0 ||
    row.financialFactCount > 11000 ||
    !/^[a-f0-9]{64}$/.test(row.financialFactHash) ||
    proofHash !== partitionControlProof(fields, secret)
  )
    throw intentReview();
  return {
    storeId: row.storeId,
    date: row.businessDate,
    revision: String(row.revision),
    manifestHash: row.manifestHash,
  };
}

/** Authenticated unordered set commitment; primary keys prevent duplicate leaves.
 * XOR allows bounded remove-old/add-new updates under the Store lock. The signed
 * count and every leaf HMAC are also verified; the zero digest is not an absence proof.
 */
export function xorControlDigest(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) throw intentReview();
  const a = Buffer.from(left, 'hex'),
    b = Buffer.from(right, 'hex');
  for (let i = 0; i < a.length; i++) a[i] = a[i]! ^ b[i]!;
  return a.toString('hex');
}
export function partitionMemberHash(
  row: Pick<
    typeof cashReturnPartitionControls.$inferSelect,
    'storeId' | 'businessDate' | 'revision' | 'manifestHash'
  >,
  secret: string,
) {
  return operationHash(
    'cash-return.partition-member.v1',
    {
      storeId: row.storeId,
      date: row.businessDate,
      revision: String(row.revision),
      manifestHash: row.manifestHash,
    },
    secret,
  );
}
export function verifyPartitionSet(
  rows: readonly (typeof cashReturnPartitionControls.$inferSelect)[],
  control: typeof cashReturnControls.$inferSelect | undefined,
  secret: string,
) {
  if (rows.length > 70000 || (!control && rows.length)) throw intentReview();
  let manifest = '0'.repeat(64);
  for (const row of rows) {
    verifiedPartitionControl(row, secret);
    if (control && row.storeId !== control.storeId) throw intentReview();
    manifest = xorControlDigest(manifest, partitionMemberHash(row, secret));
  }
  if (
    control &&
    (control.partitionCount !== rows.length || control.partitionManifestHash !== manifest)
  )
    throw intentReview();
}

export function financialScopeHash(
  storeId: string,
  date: string,
  recordIds: readonly string[],
  secret: string,
) {
  return operationHash(
    'cash-return.financial-scope.v1',
    { storeId, date, recordIds: [...new Set(recordIds)].sort() },
    secret,
  );
}
