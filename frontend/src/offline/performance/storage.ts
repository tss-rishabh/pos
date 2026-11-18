import { z } from 'zod';
import { captureOperatorScope } from '../../api/client';
import { cachedOperatorForStore } from '../operator-session';
import { db, type PosDatabase } from '../database';
import {
  emptyPerformance,
  performanceCapture,
  performanceCommand,
  timingOwner,
  type PerformanceCapture,
  type PerformanceCommand,
  type PerformancePhase,
  type TimingOwner,
} from './contracts';

export interface PerformanceStorageOptions {
  database?: PosDatabase;
  signal?: AbortSignal;
  clock?: () => number;
}
function context(ownerId: string, options: PerformanceStorageOptions) {
  return {
    database: options.database ?? db,
    signal: options.signal ?? captureOperatorScope(ownerId),
    clock: options.clock ?? Date.now,
  };
}
type Context = ReturnType<typeof context>;
async function active(owner: Pick<TimingOwner, 'ownerId' | 'storeId'>, scope: Context) {
  scope.signal.throwIfAborted();
  const session = await scope.database.sessions.get('current');
  try {
    cachedOperatorForStore(session, owner.ownerId, owner.storeId, scope.clock());
  } catch {
    throw new Error('The timing snapshot belongs to a different operator session.');
  }
  if (localStorage.getItem('pos-pending-logout'))
    throw new Error('The timing snapshot belongs to a different operator session.');
  scope.signal.throwIfAborted();
}
function matching(saved: TimingOwner, owner: TimingOwner) {
  return (
    saved.ownerId === owner.ownerId &&
    saved.storeId === owner.storeId &&
    saved.counterId === owner.counterId &&
    saved.draftId === owner.draftId
  );
}
function seed(owner: TimingOwner, now: number): PerformanceCapture {
  const { overall_performance_time: _overall, ...phases } = emptyPerformance();
  return {
    ...owner,
    checkoutId: null,
    connectionOperationId: null,
    connectionVersion: null,
    startedAt: null,
    phases,
    updatedAt: now,
  };
}

/** Metrics are separate from cash state; callers may continue a sale if this fails. */
async function writePerformancePhase(
  raw: TimingOwner,
  phase: PerformancePhase,
  milliseconds: number,
  options: PerformanceStorageOptions = {},
  binding?: { checkoutId: string; version: number },
) {
  const owner = timingOwner.parse(raw),
    scope = context(owner.ownerId, options);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds >= 1e12) return;
  return scope.database.transaction(
    'rw',
    [scope.database.sessions, scope.database.performanceCaptures],
    async () => {
      await active(owner, scope);
      const rawSaved = await scope.database.performanceCaptures.get([owner.ownerId, owner.draftId]);
      const saved = rawSaved ? performanceCapture.parse(rawSaved) : seed(owner, scope.clock());
      if (!matching(saved, owner)) throw new Error('The timing snapshot changed its owning sale.');
      if (
        binding &&
        (saved.checkoutId !== binding.checkoutId ||
          (saved.connectionVersion !== null && binding.version < saved.connectionVersion))
      )
        return;
      const value = performanceCapture.parse({
        ...saved,
        phases: { ...saved.phases, [phase]: milliseconds.toFixed(2) },
        updatedAt: scope.clock(),
      });
      await scope.database.performanceCaptures.put(value);
      scope.signal.throwIfAborted();
    },
  );
}
export function recordPerformancePhase(
  owner: TimingOwner,
  phase: PerformancePhase,
  milliseconds: number,
  options: PerformanceStorageOptions = {},
) {
  return writePerformancePhase(owner, phase, milliseconds, options);
}
export async function recordCustomerHistoryPerformance(
  operatorId: string,
  storeId: string,
  checkoutId: string,
  version: number,
  milliseconds: number,
  options: PerformanceStorageOptions = {},
) {
  const scope = context(operatorId, options);
  await active({ ownerId: operatorId, storeId }, scope);
  const raw = await scope.database.performanceCaptures
    .where('[ownerId+checkoutId]')
    .equals([operatorId, checkoutId])
    .first();
  scope.signal.throwIfAborted();
  const saved = performanceCapture.safeParse(raw);
  if (!saved.success || saved.data.storeId !== storeId) return;
  const { ownerId, counterId, draftId } = saved.data;
  return writePerformancePhase(
    { ownerId, storeId, counterId, draftId },
    'user_behaviour',
    milliseconds,
    options,
    { checkoutId, version },
  );
}
export async function recordCustomerConnection(
  raw: TimingOwner & { checkoutId: string; checkoutVersion?: number },
  operationId: string,
  connected: boolean,
  options: PerformanceStorageOptions = {},
) {
  const { checkoutId, checkoutVersion, ...owner } = raw;
  timingOwner.parse(owner);
  z.uuid().parse(checkoutId);
  z.uuid().parse(operationId);
  if (checkoutVersion !== undefined) z.number().int().nonnegative().parse(checkoutVersion);
  const scope = context(owner.ownerId, options);
  const connectedAt = scope.clock();
  return scope.database.transaction(
    'rw',
    [scope.database.sessions, scope.database.performanceCaptures],
    async () => {
      await active(owner, scope);
      const rawSaved = await scope.database.performanceCaptures.get([owner.ownerId, owner.draftId]);
      const saved = rawSaved ? performanceCapture.parse(rawSaved) : seed(owner, scope.clock());
      if (!matching(saved, owner) || (saved.checkoutId !== null && saved.checkoutId !== checkoutId))
        throw new Error('The timing snapshot changed its owning checkout.');
      if (saved.connectionOperationId === operationId) return;
      if (
        checkoutVersion !== undefined &&
        saved.connectionVersion !== null &&
        checkoutVersion <= saved.connectionVersion
      )
        return;
      await scope.database.performanceCaptures.put(
        performanceCapture.parse({
          ...saved,
          checkoutId,
          connectionOperationId: operationId,
          connectionVersion: checkoutVersion ?? null,
          startedAt: connected ? connectedAt : null,
          // Source customer sync reloads the form, resetting its four phase fields.
          phases: seed(owner, connectedAt).phases,
          updatedAt: scope.clock(),
        }),
      );
      scope.signal.throwIfAborted();
    },
  );
}
type TimingIdentity = Pick<
  PerformanceCommand,
  | 'id'
  | 'ownerId'
  | 'storeId'
  | 'counterId'
  | 'draftId'
  | 'checkoutId'
  | 'draftVersion'
  | 'submissionId'
  | 'paymentId'
>;
function assertCommand(saved: PerformanceCommand, cash: TimingIdentity) {
  if (
    !matching(saved, cash) ||
    saved.id !== cash.id ||
    saved.checkoutId !== cash.checkoutId ||
    saved.draftVersion !== cash.draftVersion ||
    saved.submissionId !== cash.submissionId ||
    saved.paymentId !== cash.paymentId
  )
    throw new Error('The timing snapshot does not match the original cash intent.');
}
export async function claimPerformance(
  id: string,
  ownerId: string,
  options: PerformanceStorageOptions = {},
) {
  z.uuid().parse(id);
  const scope = context(ownerId, options);
  return scope.database.transaction(
    'rw',
    [scope.database.sessions, scope.database.performanceCommands],
    async () => {
      const raw = await scope.database.performanceCommands.get(id);
      if (!raw) return null;
      const original = performanceCommand.parse(raw);
      if (original.ownerId !== ownerId)
        throw new Error('The timing snapshot belongs to another operator.');
      await active(original, scope);
      const now = scope.clock();
      if (
        !original.orderId ||
        !original.receiptId ||
        ['recorded', 'rejected'].includes(original.state) ||
        original.nextAttemptAt > now ||
        (original.claimId && original.claimedAt !== null && original.claimedAt + 30000 > now)
      )
        return null;
      const lookupFirst = original.attempts > 0 || original.state !== 'prepared';
      const command = performanceCommand.parse({
        ...original,
        state: 'sending',
        claimId: crypto.randomUUID(),
        claimedAt: now,
        attempts: original.attempts + 1,
        nextAttemptAt: now + 30000,
        revision: original.revision + 1,
      });
      await scope.database.performanceCommands.put(command);
      scope.signal.throwIfAborted();
      return { command, lookupFirst };
    },
  );
}
export async function finishPerformanceClaim(
  command: PerformanceCommand,
  state: 'recorded' | 'unknown' | 'rejected',
  errorCode: string | null,
  options: PerformanceStorageOptions = {},
) {
  const scope = context(command.ownerId, options);
  return scope.database.transaction(
    'rw',
    [scope.database.sessions, scope.database.performanceCommands],
    async () => {
      await active(command, scope);
      const latest = performanceCommand.parse(
        await scope.database.performanceCommands.get(command.id),
      );
      assertCommand(latest, command);
      if (latest.claimId !== command.claimId || latest.revision !== command.revision) return latest;
      const result = performanceCommand.parse({
        ...latest,
        state,
        errorCode,
        claimId: null,
        claimedAt: null,
        nextAttemptAt:
          state === 'unknown'
            ? scope.clock() + Math.min(300000, 1000 * 2 ** Math.min(8, latest.attempts))
            : 0,
        revision: latest.revision + 1,
      });
      await scope.database.performanceCommands.put(result);
      scope.signal.throwIfAborted();
      return result;
    },
  );
}
