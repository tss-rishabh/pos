import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { ImportFinancialScope } from './financial-contracts.js';
import {
  financialImportScopeSchema,
  financialOrderPreparationContract,
  type ImportFinancialState,
} from './financial-adapter-contracts.js';
import {
  equalImportHash,
  financialImportHash,
  financialImportKey,
  importFinancialError,
} from './financial-adapter-crypto.js';
import {
  financialImportPreparations,
  financialImportStages,
  financialImportOrderBindings,
  financialImportSourceReceipts,
  financialImportSourceEffects,
  financialImportProofs,
  financialImportCloseImpacts,
} from './financial-adapter-schema.js';
import { legacyOrderImports, legacyOrderImportRows } from './schema.js';
import { csvMembershipPrefetchSchema } from './membership-profile/bridge.js';
import {
  csvCouponPrefetchSchema,
  csvCouponPrefetchMaximumBytes,
} from './benefit-profile/bridge.js';
import {
  financialPreparationAttemptSchema,
  financialPreparationExecutionSchema,
  financialQueueLeaseSchema,
  nativePreparationClosureSchema,
  preparationLeaseMilliseconds,
  preparationMaximumAttempts,
  type FinancialPreparationAttempt,
  type FinancialPreparationExecution,
  type FinancialQueueLease,
  type NativePreparationClosure,
} from './financial-adapter-preparation-contracts.js';

export const financialPreparationMaximumArtifactBytes = 1048576;
export const financialPreparationMaximumEncryptedBytes =
  Math.ceil((financialPreparationMaximumArtifactBytes + 28) / 3) * 4;
export const financialPreparationOutputSchema = z
  .object({
    membershipHistory: csvMembershipPrefetchSchema.optional(),
    couponHistory: csvCouponPrefetchSchema.optional(),
  })
  .strict();
export type FinancialPreparationOutput = z.infer<typeof financialPreparationOutputSchema>;
const shallowOutputSchema = z
  .object({ membershipHistory: z.unknown().optional(), couponHistory: z.unknown().optional() })
  .strict();
const invalid = () => importFinancialError('ORDER_IMPORT_PREPARATION_PROOF_INVALID');
const retryRequired = () => importFinancialError('ORDER_IMPORT_PREPARATION_RETRY_REQUIRED');
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
function sameScope(left: ImportFinancialScope, right: ImportFinancialScope) {
  return (
    JSON.stringify(financialImportScopeSchema.parse(left)) ===
    JSON.stringify(financialImportScopeSchema.parse(right))
  );
}
export function preparationAuthorityHash(secret: string, state: ImportFinancialState) {
  return financialImportHash(secret, 'preparation-authority', state.authority);
}
export function nativePreparationClosureHash(secret: string, proof: NativePreparationClosure) {
  return financialImportHash(
    secret,
    'native-no-dispatch',
    nativePreparationClosureSchema.parse(proof),
  );
}
function ownerHash(
  secret: string,
  attempt: Pick<FinancialPreparationAttempt, 'id' | 'scope' | 'requestHash'>,
  token: string,
) {
  return financialImportHash(secret, 'preparation-owner', {
    attemptId: attempt.id,
    scope: attempt.scope,
    requestHash: attempt.requestHash,
    token: z.uuid().parse(token),
  });
}
function matches(
  state: ImportFinancialState,
  attempt: FinancialPreparationAttempt,
  secret: string,
) {
  if (
    state.preparationContract !== financialOrderPreparationContract ||
    !sameScope(state.scope, attempt.scope) ||
    state.planHash !== attempt.planHash ||
    state.requestHash !== attempt.requestHash ||
    preparationAuthorityHash(secret, state) !== attempt.authorityHash
  )
    throw invalid();
  if (attempt.closure) {
    const p = attempt.closure;
    if (
      !sameScope(p.scope, state.scope) ||
      p.planHash !== state.planHash ||
      p.requestHash !== state.requestHash ||
      p.authorityHash !== attempt.authorityHash ||
      p.namespace !== state.namespace ||
      !attempt.closureHash ||
      !equalImportHash(attempt.closureHash, nativePreparationClosureHash(secret, p))
    )
      throw invalid();
  }
}
/** Must be called under the operation lock and the cooperating dispatch fence. */
export async function assertPreparationNoDispatch(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
) {
  if (
    state.preparationContract !== financialOrderPreparationContract ||
    state.orderId !== null ||
    state.stage !== 'preparation' ||
    state.status === 'completed'
  )
    throw invalid();
  const stages = await tx
    .select({ id: financialImportStages.id })
    .from(financialImportStages)
    .where(eq(financialImportStages.operationId, state.scope.operationId))
    .limit(1)
    .for('share');
  const bindings = await tx
    .select({ id: financialImportOrderBindings.orderId })
    .from(financialImportOrderBindings)
    .where(eq(financialImportOrderBindings.operationId, state.scope.operationId))
    .limit(1)
    .for('share');
  const receipts = await tx
    .select({ id: financialImportSourceReceipts.id })
    .from(financialImportSourceReceipts)
    .where(eq(financialImportSourceReceipts.operationId, state.scope.operationId))
    .limit(1)
    .for('share');
  const effects = await tx
    .select({ id: financialImportSourceEffects.operationId })
    .from(financialImportSourceEffects)
    .where(eq(financialImportSourceEffects.operationId, state.scope.operationId))
    .limit(1)
    .for('share');
  const proofs = await tx
    .select({ id: financialImportProofs.id })
    .from(financialImportProofs)
    .where(eq(financialImportProofs.operationId, state.scope.operationId))
    .limit(1)
    .for('share');
  const closes = await tx
    .select({ id: financialImportCloseImpacts.id })
    .from(financialImportCloseImpacts)
    .where(eq(financialImportCloseImpacts.operationId, state.scope.operationId))
    .limit(1)
    .for('share');
  if (
    stages.length +
    bindings.length +
    receipts.length +
    effects.length +
    proofs.length +
    closes.length
  )
    throw invalid();
}
/** Immutable local control metadata, not a source/provider no-effects receipt. */
export function financialPreparationLedger(secret: string, clock: () => number = Date.now) {
  const queueWitness = new WeakMap<AdministrationTransaction, Set<string>>();
  const queueKey = (scope: ImportFinancialScope, lease: FinancialQueueLease) =>
    JSON.stringify([
      scope.actorId,
      scope.operationId,
      scope.storeId,
      scope.counterId,
      lease.jobId,
      lease.claimToken,
    ]);
  async function history(tx: AdministrationTransaction, state: ImportFinancialState) {
    const rows = await tx
      .select({
        id: financialImportPreparations.id,
        operationId: financialImportPreparations.operationId,
        sequence: financialImportPreparations.sequence,
        proofHash: financialImportPreparations.proofHash,
        data: sql<unknown>`CASE WHEN OCTET_LENGTH(${financialImportPreparations.data})<=16000 THEN ${financialImportPreparations.data} ELSE NULL END`,
      })
      .from(financialImportPreparations)
      .where(eq(financialImportPreparations.operationId, state.scope.operationId))
      .orderBy(desc(financialImportPreparations.sequence))
      .limit(preparationMaximumAttempts + 1)
      .for('update');
    if (rows.length > preparationMaximumAttempts) throw invalid();
    const result = rows.map((row) => {
      const raw =
        typeof row.data === 'string'
          ? (() => {
              try {
                return JSON.parse(row.data) as unknown;
              } catch {
                throw invalid();
              }
            })()
          : row.data;
      const value = parsed(financialPreparationAttemptSchema, raw);
      if (
        row.id !== value.id ||
        row.operationId !== value.scope.operationId ||
        row.sequence !== value.sequence ||
        !equalImportHash(row.proofHash, financialImportHash(secret, 'preparation-attempt', value))
      )
        throw invalid();
      matches(state, value, secret);
      return value;
    });
    for (let i = 0; i < result.length; i++) {
      const value = result[i]!,
        prior = result[i + 1];
      if (
        value.sequence !== result.length - i ||
        (prior ? value.previousId !== prior.id : value.previousId !== null)
      )
        throw invalid();
    }
    return result;
  }
  async function save(
    tx: AdministrationTransaction,
    value: FinancialPreparationAttempt,
    artifact?: string | null,
  ) {
    const data = financialPreparationAttemptSchema.parse({ ...value, updatedAt: clock() });
    await tx
      .update(financialImportPreparations)
      .set({
        data,
        proofHash: financialImportHash(secret, 'preparation-attempt', data),
        ...(artifact === undefined ? {} : { artifact }),
      })
      .where(eq(financialImportPreparations.id, data.id));
    return data;
  }
  async function insert(tx: AdministrationTransaction, value: FinancialPreparationAttempt) {
    const data = financialPreparationAttemptSchema.parse(value);
    await tx.insert(financialImportPreparations).values({
      id: data.id,
      operationId: data.scope.operationId,
      sequence: data.sequence,
      data,
      proofHash: financialImportHash(secret, 'preparation-attempt', data),
      artifact: null,
    });
    return data;
  }
  async function latest(tx: AdministrationTransaction, state: ImportFinancialState) {
    const [value] = await history(tx, state);
    if (!value) throw invalid();
    return value;
  }
  async function queue(
    tx: AdministrationTransaction,
    scope: ImportFinancialScope,
    input: FinancialQueueLease,
  ) {
    const lease = financialQueueLeaseSchema.parse(input),
      [job] = await tx
        .select()
        .from(legacyOrderImports)
        .where(eq(legacyOrderImports.id, lease.jobId))
        .limit(1)
        .for('update'),
      [row] = await tx
        .select({
          state: legacyOrderImportRows.state,
          storeId: legacyOrderImportRows.storeId,
          counterId: legacyOrderImportRows.counterId,
        })
        .from(legacyOrderImportRows)
        .where(
          and(
            eq(legacyOrderImportRows.jobId, lease.jobId),
            eq(legacyOrderImportRows.operationId, scope.operationId),
          ),
        )
        .limit(1)
        .for('update');
    const expiry = job?.leaseUntil ? Date.parse(job.leaseUntil.replace(' ', 'T') + 'Z') : NaN;
    if (
      !job ||
      job.actorId !== scope.actorId ||
      job.claimToken !== lease.claimToken ||
      job.state !== 'RUNNING' ||
      !Number.isFinite(expiry) ||
      expiry <= clock() ||
      !row ||
      row.state !== 'STARTING' ||
      row.storeId !== scope.storeId ||
      row.counterId !== scope.counterId
    )
      throw retryRequired();
    let validated = queueWitness.get(tx);
    if (!validated) {
      validated = new Set();
      queueWitness.set(tx, validated);
    }
    validated.add(queueKey(scope, lease));
    return lease;
  }
  async function begin(
    tx: AdministrationTransaction,
    state: ImportFinancialState,
    queueLease?: FinancialQueueLease,
  ) {
    await assertPreparationNoDispatch(tx, state);
    if (queueLease && !queueWitness.get(tx)?.has(queueKey(state.scope, queueLease)))
      throw retryRequired();
    const rows = await history(tx, state),
      prior = rows[0];
    if (prior && prior.phase !== 'AUTHORIZED') throw retryRequired();
    if (
      prior &&
      ((prior.queue === null) !== (queueLease === undefined) ||
        (prior.queue && prior.queue.jobId !== queueLease?.jobId))
    )
      throw invalid();
    const id = prior?.id ?? randomUUID(),
      token = randomUUID(),
      now = clock(),
      data: FinancialPreparationAttempt = {
        contract: financialOrderPreparationContract,
        id,
        scope: state.scope,
        planHash: state.planHash,
        requestHash: state.requestHash,
        authorityHash: preparationAuthorityHash(secret, state),
        sequence: prior?.sequence ?? 1,
        previousId: prior?.previousId ?? null,
        authorizedBy: prior?.authorizedBy ?? null,
        phase: 'RESERVED',
        queue: queueLease ?? null,
        ownerHash: null,
        expiresAt: now + preparationLeaseMilliseconds,
        artifactHash: null,
        closure: null,
        closureHash: null,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
    data.ownerHash = ownerHash(secret, data, token);
    if (prior) await save(tx, data);
    else await insert(tx, data);
    return financialPreparationExecutionSchema.parse({
      kind: 'preparation',
      attemptId: id,
      ownerToken: token,
      ...(queueLease ? { queue: queueLease } : {}),
    });
  }
  async function owned(
    tx: AdministrationTransaction,
    state: ImportFinancialState,
    execution: FinancialPreparationExecution,
  ) {
    const lease = financialPreparationExecutionSchema.parse(execution);
    if (lease.kind !== 'preparation') throw retryRequired();
    const value = await latest(tx, state);
    if (value.queue && !queueWitness.get(tx)?.has(queueKey(state.scope, value.queue)))
      throw retryRequired();
    if (
      value.id !== lease.attemptId ||
      !value.ownerHash ||
      !equalImportHash(value.ownerHash, ownerHash(secret, value, lease.ownerToken)) ||
      JSON.stringify(value.queue) !== JSON.stringify(lease.queue ?? null) ||
      value.expiresAt === null ||
      clock() >= value.expiresAt
    )
      throw retryRequired();
    return value;
  }
  function artifact(state: ImportFinancialState, value: unknown, expiresAt?: number) {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
      if (typeof serialized !== 'string') throw invalid();
      const shallow = parsed(shallowOutputSchema, value);
      if (shallow.couponHistory !== undefined) {
        const encoded = JSON.stringify(shallow.couponHistory);
        if (typeof encoded !== 'string') throw invalid();
        const couponBytes = Buffer.byteLength(encoded, 'utf8');
        if (!state.benefitContracts?.automaticCoupon || couponBytes > csvCouponPrefetchMaximumBytes)
          throw invalid();
      }
    } catch {
      throw invalid();
    }
    if (Buffer.byteLength(serialized, 'utf8') > financialPreparationMaximumArtifactBytes)
      throw invalid();
    const parsedOutput = parsed(financialPreparationOutputSchema, value);
    for (const h of [parsedOutput.membershipHistory, parsedOutput.couponHistory]) {
      if (
        h &&
        (h.capability.scope.operationId !== state.scope.operationId ||
          h.capability.scope.requestHash !== state.requestHash ||
          h.capability.scope.planHash !== state.planHash ||
          h.capability.scope.customerId !== state.authority.customerId ||
          JSON.stringify(h.capability.scope) !== JSON.stringify(h.document.scope) ||
          h.capability.generationId !== h.document.generationId ||
          h.capability.expiresAt <= clock() ||
          (expiresAt !== undefined && h.capability.expiresAt > expiresAt))
      )
        throw invalid();
    }
    return parsedOutput;
  }
  function encrypt(
    state: ImportFinancialState,
    attempt: FinancialPreparationAttempt,
    value: FinancialPreparationOutput,
  ) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', financialImportKey(secret, 'encryption'), nonce);
    cipher.setAAD(
      Buffer.from(
        financialImportHash(secret, 'preparation-artifact-aad', {
          scope: state.scope,
          requestHash: state.requestHash,
          attemptId: attempt.id,
        }),
      ),
    );
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  return {
    history,
    latest,
    queue,
    begin,
    owned,
    artifact,
    async direct(tx: AdministrationTransaction, scope: ImportFinancialScope) {
      const [row] = await tx
        .select({ jobId: legacyOrderImportRows.jobId })
        .from(legacyOrderImportRows)
        .where(eq(legacyOrderImportRows.operationId, scope.operationId))
        .limit(1)
        .for('update');
      if (row) throw retryRequired();
    },
    async consume(
      tx: AdministrationTransaction,
      state: ImportFinancialState,
      execution: FinancialPreparationExecution,
    ) {
      const value = await owned(tx, state, execution);
      if (value.phase !== 'RESERVED') return null;
      await assertPreparationNoDispatch(tx, state);
      return save(tx, { ...value, phase: 'RUNNING' });
    },
    async dispatched(
      tx: AdministrationTransaction,
      state: ImportFinancialState,
      execution: FinancialPreparationExecution,
      supplied: unknown,
    ) {
      const value = await owned(tx, state, execution);
      if (value.phase !== 'RUNNING') throw retryRequired();
      await assertPreparationNoDispatch(tx, state);
      const output = artifact(state, supplied, value.expiresAt!),
        data = {
          ...value,
          phase: 'DISPATCHED' as const,
          artifactHash: financialImportHash(secret, 'preparation-artifact', output),
        };
      await save(tx, data, encrypt(state, value, output));
      return output;
    },
    async close(
      tx: AdministrationTransaction,
      state: ImportFinancialState,
      code: NativePreparationClosure['code'],
      execution?: FinancialPreparationExecution,
    ) {
      const value = await latest(tx, state);
      if (value.phase === 'CLOSED') {
        await assertPreparationNoDispatch(tx, state);
        return value.closure!;
      }
      if (
        value.phase === 'DISPATCHED' ||
        (value.phase === 'AUTHORIZED' && code !== 'ORDER_IMPORT_PREPARATION_CANCELLED')
      )
        throw retryRequired();
      if (execution) {
        const lease = financialPreparationExecutionSchema.parse(execution);
        if (
          lease.kind !== 'preparation' ||
          lease.attemptId !== value.id ||
          !value.ownerHash ||
          !equalImportHash(value.ownerHash, ownerHash(secret, value, lease.ownerToken))
        )
          throw retryRequired();
      } else if (
        code !== 'ORDER_IMPORT_PREPARATION_CANCELLED' &&
        (value.expiresAt === null || clock() < value.expiresAt)
      )
        return null;
      await assertPreparationNoDispatch(tx, state);
      const proof = nativePreparationClosureSchema.parse({
        contract: 'pos-import-native-no-dispatch-v1',
        scope: state.scope,
        planHash: state.planHash,
        requestHash: state.requestHash,
        authorityHash: value.authorityHash,
        namespace: state.namespace,
        attemptId: value.id,
        sequence: value.sequence,
        code,
        noFinancialEffects: true,
        closedAt: clock(),
        nonce: randomUUID(),
      });
      await save(tx, {
        ...value,
        phase: 'CLOSED',
        closure: proof,
        closureHash: nativePreparationClosureHash(secret, proof),
      });
      return proof;
    },
    async authorize(tx: AdministrationTransaction, state: ImportFinancialState, commandId: string) {
      const value = await latest(tx, state);
      if (
        value.phase !== 'CLOSED' ||
        !value.closure ||
        value.closure.code === 'ORDER_IMPORT_PREPARATION_CANCELLED' ||
        value.sequence >= preparationMaximumAttempts
      )
        throw retryRequired();
      await assertPreparationNoDispatch(tx, state);
      const now = clock();
      return insert(tx, {
        ...value,
        id: randomUUID(),
        sequence: value.sequence + 1,
        previousId: value.id,
        authorizedBy: z.uuid().parse(commandId),
        phase: 'AUTHORIZED',
        ownerHash: null,
        expiresAt: null,
        artifactHash: null,
        closure: null,
        closureHash: null,
        createdAt: now,
        updatedAt: now,
      });
    },
    async readArtifact(tx: AdministrationTransaction, state: ImportFinancialState) {
      const value = await latest(tx, state);
      if (value.phase !== 'DISPATCHED' || !value.artifactHash) throw invalid();
      const [row] = await tx
        .select({
          value: sql<
            string | null
          >`CASE WHEN OCTET_LENGTH(${financialImportPreparations.artifact})<=${financialPreparationMaximumEncryptedBytes} THEN ${financialImportPreparations.artifact} ELSE NULL END`,
        })
        .from(financialImportPreparations)
        .where(eq(financialImportPreparations.id, value.id))
        .limit(1)
        .for('share');
      try {
        if (!row?.value || !/^[A-Za-z0-9_-]+$/.test(row.value)) throw invalid();
        const bytes = Buffer.from(row.value, 'base64url');
        if (bytes.length < 28 || bytes.toString('base64url') !== row.value) throw invalid();
        const decipher = createDecipheriv(
          'aes-256-gcm',
          financialImportKey(secret, 'encryption'),
          bytes.subarray(0, 12),
        );
        decipher.setAAD(
          Buffer.from(
            financialImportHash(secret, 'preparation-artifact-aad', {
              scope: state.scope,
              requestHash: state.requestHash,
              attemptId: value.id,
            }),
          ),
        );
        decipher.setAuthTag(bytes.subarray(12, 28));
        const output = parsed(
          financialPreparationOutputSchema,
          JSON.parse(
            Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
          ) as unknown,
        );
        if (
          !equalImportHash(
            value.artifactHash,
            financialImportHash(secret, 'preparation-artifact', output),
          )
        )
          throw invalid();
        return output;
      } catch {
        throw invalid();
      }
    },
  };
}
