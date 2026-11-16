import type { Principal } from '../../api/types';
import { ApiError, captureOperatorScope } from '../../api/client';
import { db, type PosDatabase } from '../database';
import { acceptCashReceipt, readCashReceipt } from './client';
import { canonicalCashJson } from './canonical';
import { reconcileCashOrderImport } from './import-state';
import {
  cashReceiptAcceptanceSchema,
  cashReceiptDetailSchema,
  type CashReceiptAcceptance,
  type SignedCashReceipt,
} from './contracts';

export interface CashReplayOptions {
  database?: PosDatabase;
  signal?: AbortSignal;
  clock?: () => number;
  send?: (
    operatorId: string,
    storeId: string,
    envelope: SignedCashReceipt,
  ) => Promise<CashReceiptAcceptance>;
}
export function currentCashScope(cached: Principal, supplied: Principal, storeId: string) {
  return (
    cached.id === supplied.id &&
    cached.role === supplied.role &&
    cached.userType === supplied.userType &&
    JSON.stringify([...cached.storeIds].sort()) === JSON.stringify([...supplied.storeIds].sort()) &&
    ((cached.role === 1 && cached.userType === 1) || cached.storeIds.includes(storeId))
  );
}
export function assertAcceptedCash(envelope: SignedCashReceipt, accepted: CashReceiptAcceptance) {
  const receipt = envelope.receipt;
  for (const field of [
    'operatorId',
    'storeId',
    'counterId',
    'businessDate',
    'payableCents',
    'cashReceivedCents',
    'changeCents',
    'receiptNumber',
    'completedAt',
  ] as const)
    if (receipt[field] !== accepted[field])
      throw new Error('The server cash evidence does not match its immutable device receipt.');
  if (
    accepted.receiptId !== receipt.id ||
    (accepted.status === 'imported'
      ? !accepted.orderId || !accepted.importedAt
      : accepted.orderId !== null || accepted.importedAt !== null)
  )
    throw new Error('The server cash import evidence is incomplete.');
}
export async function replayOfflineCash(
  user: Principal,
  storeId: string,
  options: CashReplayOptions = {},
) {
  const database = options.database || db,
    signal = options.signal || captureOperatorScope(user.id),
    clock = options.clock || Date.now,
    send = options.send || acceptCashReceipt;
  const manager = [1, 2, 3, 4].includes(user.role);
  if (!(user.role === 1 && user.userType === 1) && !user.storeIds.includes(storeId))
    throw new Error('This operator cannot reconcile cash for this store.');
  signal.throwIfAborted();
  const work = await database.offlineCashSync
    .where(manager ? '[storeId+state]' : '[ownerId+state]')
    .anyOf(['pending', 'retry', 'sending'].map((state) => [manager ? storeId : user.id, state]))
    .filter(
      (job) =>
        job.storeId === storeId &&
        job.nextAttemptAt <= clock() &&
        (job.state !== 'sending' || (job.claimedAt || 0) + 30_000 <= clock()),
    )
    .limit(20)
    .toArray();
  for (const candidate of work) {
    signal.throwIfAborted();
    const claimId = crypto.randomUUID();
    const claimed = await database.transaction(
      'rw',
      [database.sessions, database.offlineCashSync],
      async () => {
        signal.throwIfAborted();
        const session = await database.sessions.get('current');
        if (
          !session ||
          !currentCashScope(session.user, user, storeId) ||
          session.expiresAt <= clock() ||
          localStorage.getItem('pos-pending-logout')
        )
          return false;
        const current = await database.offlineCashSync.get(candidate.receiptId);
        if (
          !current ||
          ['accepted', 'imported'].includes(current.state) ||
          current.storeId !== storeId ||
          (!manager && current.ownerId !== user.id) ||
          current.nextAttemptAt > clock() ||
          (current.state === 'sending' && (current.claimedAt || 0) + 30_000 > clock())
        )
          return false;
        await database.offlineCashSync.update(candidate.receiptId, {
          state: 'sending',
          attempts: current.attempts + 1,
          claimId,
          claimedAt: clock(),
        });
        return true;
      },
    );
    if (!claimed) continue;
    try {
      const local = await database.offlineCashReceipts.get([
        candidate.ownerId,
        candidate.receiptId,
      ]);
      if (!local) throw new Error('The saved cash receipt is unavailable.');
      const receipt = local.envelope.receipt,
        accepted = cashReceiptAcceptanceSchema.parse(await send(user.id, storeId, local.envelope));
      assertAcceptedCash(local.envelope, accepted);
      signal.throwIfAborted();
      await database.transaction(
        'rw',
        [database.sessions, database.offlineCashSync, database.offlineCashReceipts],
        async () => {
          signal.throwIfAborted();
          const session = await database.sessions.get('current'),
            job = await database.offlineCashSync.get(receipt.id);
          if (
            !session ||
            !currentCashScope(session.user, user, storeId) ||
            session.expiresAt <= clock() ||
            localStorage.getItem('pos-pending-logout') ||
            job?.claimId !== claimId
          )
            return;
          await database.offlineCashReceipts.update([candidate.ownerId, receipt.id], {
            acceptance: accepted,
            syncState:
              accepted.status === 'imported'
                ? 'imported'
                : accepted.status === 'conflicted'
                  ? 'conflicted'
                  : 'accepted',
            importedAt: accepted.importedAt,
          });
          await database.offlineCashSync.update(receipt.id, {
            state: accepted.status === 'imported' ? 'imported' : 'accepted',
            autoImportEligible: accepted.status === 'accepted' && !accepted.conflicts.length,
            ...(job.orderImport
              ? { orderImport: reconcileCashOrderImport(job.orderImport, accepted) }
              : {}),
            claimId: null,
            claimedAt: null,
            errorCode: null,
          });
          signal.throwIfAborted();
        },
      );
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      const code =
        error instanceof ApiError && /^[A-Z_]{1,80}$/.test(error.code)
          ? error.code
          : 'OFFLINE_CASH_SYNC_UNCONFIRMED';
      await database.transaction('rw', database.offlineCashSync, async () => {
        const job = await database.offlineCashSync.get(candidate.receiptId);
        if (job?.claimId !== claimId) return;
        await database.offlineCashSync.update(job.receiptId, {
          state: 'retry',
          claimId: null,
          claimedAt: null,
          errorCode: code,
          nextAttemptAt: clock() + Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)),
        });
      });
      if (error instanceof ApiError && [401, 403].includes(error.status)) return;
    }
  }
}

export interface CashRefreshOptions {
  database?: PosDatabase;
  signal?: AbortSignal;
  clock?: () => number;
  read?: typeof readCashReceipt;
}
/** Read-only server reconciliation; never re-dispatches an order or cash completion. */
export async function refreshOfflineCashReceipt(
  user: Principal,
  storeId: string,
  receiptId: string,
  options: CashRefreshOptions = {},
) {
  const database = options.database || db,
    signal = options.signal || captureOperatorScope(user.id),
    clock = options.clock || Date.now;
  signal.throwIfAborted();
  const job = await database.offlineCashSync.get(receiptId);
  if (
    !job ||
    job.storeId !== storeId ||
    (![1, 2, 3, 4].includes(user.role) && job.ownerId !== user.id)
  )
    return;
  const local = await database.offlineCashReceipts.get([job.ownerId, receiptId]);
  if (!local) return;
  const session = await database.sessions.get('current');
  if (
    !session ||
    !currentCashScope(session.user, user, storeId) ||
    session.expiresAt <= clock() ||
    localStorage.getItem('pos-pending-logout')
  )
    return;
  const detail = cashReceiptDetailSchema.parse(
    await (options.read || readCashReceipt)(user.id, storeId, receiptId),
  );
  if (canonicalCashJson(local.envelope) !== canonicalCashJson(detail.envelope))
    throw new Error('The server changed the original signed cash receipt.');
  const accepted = cashReceiptAcceptanceSchema.strip().parse(detail);
  assertAcceptedCash(local.envelope, accepted);
  signal.throwIfAborted();
  return database.transaction(
    'rw',
    [database.sessions, database.offlineCashReceipts, database.offlineCashSync],
    async () => {
      signal.throwIfAborted();
      const currentSession = await database.sessions.get('current'),
        current = await database.offlineCashReceipts.get([job.ownerId, receiptId]),
        currentJob = await database.offlineCashSync.get(receiptId);
      if (
        !currentSession ||
        !currentCashScope(currentSession.user, user, storeId) ||
        currentSession.expiresAt <= clock() ||
        localStorage.getItem('pos-pending-logout') ||
        !current ||
        !currentJob ||
        currentJob.ownerId !== job.ownerId ||
        currentJob.storeId !== storeId
      )
        return;
      if (current.acceptance && accepted.version < current.acceptance.version) return;
      if (
        current.acceptance &&
        accepted.version === current.acceptance.version &&
        canonicalCashJson(accepted) !== canonicalCashJson(current.acceptance)
      )
        throw new Error('The server returned conflicting cash reconciliation evidence.');
      if (
        current.importedAt !== null &&
        (accepted.status !== 'imported' ||
          accepted.importedAt !== current.importedAt ||
          accepted.orderId !== current.acceptance?.orderId)
      )
        throw new Error('The immutable cash import link changed.');
      await database.offlineCashReceipts.update([job.ownerId, receiptId], {
        acceptance: accepted,
        importedAt: accepted.importedAt,
        syncState:
          accepted.status === 'imported'
            ? 'imported'
            : accepted.status === 'conflicted'
              ? 'conflicted'
              : 'accepted',
      });
      await database.offlineCashSync.update(receiptId, {
        state: accepted.status === 'imported' ? 'imported' : 'accepted',
        autoImportEligible: accepted.status === 'accepted' && !accepted.conflicts.length,
        ...(currentJob.orderImport
          ? { orderImport: reconcileCashOrderImport(currentJob.orderImport, accepted) }
          : {}),
        claimId: null,
        claimedAt: null,
        errorCode: null,
      });
      signal.throwIfAborted();
      return accepted;
    },
  );
}
export async function refreshOfflineCash(
  user: Principal,
  storeId: string,
  options: CashRefreshOptions = {},
) {
  const database = options.database || db,
    manager = [1, 2, 3, 4].includes(user.role),
    signal = options.signal || captureOperatorScope(user.id);
  const jobs = await database.offlineCashSync
    .where(manager ? '[storeId+state]' : '[ownerId+state]')
    .equals([manager ? storeId : user.id, 'accepted'])
    .filter((job) => job.storeId === storeId)
    .limit(20)
    .toArray();
  for (const job of jobs) {
    signal.throwIfAborted();
    await refreshOfflineCashReceipt(user, storeId, job.receiptId, { ...options, signal });
  }
}
