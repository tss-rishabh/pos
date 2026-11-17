import { ApiError, captureOperatorScope } from '../../api/client';
import type { Principal } from '../../api/types';
import { db, type PosDatabase } from '../database';
import { importCashReceiptOrder, type CashOrderImportRequest } from './client';
import { cashReceiptAcceptanceSchema, type CashReceiptAcceptance } from './contracts';
import {
  assertAcceptedCash,
  currentCashScope,
  refreshOfflineCashReceipt,
  type CashRefreshOptions,
} from './sync';
import type { LocalCashOrderImport } from './storage-types';

export interface CashOrderImportOptions extends CashRefreshOptions {
  send?: typeof importCashReceiptOrder;
}
interface ImportContext {
  database: PosDatabase;
  signal: AbortSignal;
  clock: () => number;
}
const reviewRequired = () =>
  new Error('This cash receipt needs manager review before its order can be synchronized.');

async function activeSession(user: Principal, storeId: string, context: ImportContext) {
  context.signal.throwIfAborted();
  const session = await context.database.sessions.get('current');
  return !!(
    session &&
    currentCashScope(session.user, user, storeId) &&
    session.expiresAt > context.clock() &&
    !localStorage.getItem('pos-pending-logout')
  );
}

async function dispatchImport(
  user: Principal,
  storeId: string,
  receiptId: string,
  retry: boolean,
  options: CashOrderImportOptions,
): Promise<CashReceiptAcceptance | undefined> {
  const context: ImportContext = {
      database: options.database || db,
      signal: options.signal || captureOperatorScope(user.id),
      clock: options.clock || Date.now,
    },
    { database, signal, clock } = context;
  if (!(await activeSession(user, storeId, context))) return;
  const existing = await database.offlineCashSync.get(receiptId);
  // Automatic import belongs to the original cashier. A manager's handoff never
  // silently imports another cashier's receipt, including a clean receipt.
  if (!existing || existing.ownerId !== user.id || existing.storeId !== storeId) return;
  if (options.counterId) {
    const original = await database.offlineCashReceipts.get([user.id, receiptId]);
    if (!original || original.envelope.receipt.counterId !== options.counterId) return;
  }
  if (!retry && existing.orderImport) return;

  // This read can prove a lost response committed. It never creates an order.
  const accepted = await refreshOfflineCashReceipt(user, storeId, receiptId, {
    ...options,
    ...context,
  });
  if (!accepted || accepted.status === 'imported') return accepted;
  signal.throwIfAborted();
  const intent = await database.transaction(
    'rw',
    [database.sessions, database.offlineCashReceipts, database.offlineCashSync],
    async (): Promise<LocalCashOrderImport | undefined> => {
      if (!(await activeSession(user, storeId, context))) return;
      const job = await database.offlineCashSync.get(receiptId),
        local = await database.offlineCashReceipts.get([user.id, receiptId]);
      if (
        !job ||
        !local ||
        job.ownerId !== user.id ||
        job.storeId !== storeId ||
        local.envelope.receipt.operatorId !== user.id ||
        local.envelope.receipt.id !== receiptId ||
        local.envelope.receipt.storeId !== storeId ||
        local.acceptance?.status === 'imported'
      )
        return;
      if (
        local.acceptance?.status !== 'accepted' ||
        local.acceptance.conflicts.length ||
        local.acceptance.version !== accepted.version
      ) {
        await database.offlineCashSync.update(receiptId, { autoImportEligible: false });
        if (retry) throw reviewRequired();
        return;
      }
      const saved = job.orderImport;
      if (!retry && saved) return;
      if (retry && !saved)
        throw new Error('There is no saved order synchronization attempt to retry.');
      if (
        saved &&
        (saved.actorId !== user.id ||
          saved.expectedVersion !== local.acceptance.version ||
          saved.state === 'blocked')
      )
        throw reviewRequired();
      if (saved?.state === 'confirmed') return;
      if (saved?.state === 'dispatching' && saved.dispatchedAt + 30_000 > clock())
        throw new Error('Order synchronization is still in progress. Check its status shortly.');
      const next: LocalCashOrderImport = {
        operationId: saved?.operationId || crypto.randomUUID(),
        actorId: user.id,
        expectedVersion: saved?.expectedVersion || local.acceptance.version,
        attempts: (saved?.attempts || 0) + 1,
        state: 'dispatching',
        attemptId: crypto.randomUUID(),
        dispatchedAt: clock(),
        errorCode: null,
      };
      await database.offlineCashSync.update(receiptId, {
        orderImport: next,
        autoImportEligible: true,
      });
      signal.throwIfAborted();
      return next;
    },
  );
  if (!intent) return;
  try {
    if (!(await activeSession(user, storeId, context))) return;
    signal.throwIfAborted();
    const input: CashOrderImportRequest = {
        operationId: intent.operationId,
        expectedVersion: intent.expectedVersion,
      },
      result = cashReceiptAcceptanceSchema.parse(
        await (options.send || importCashReceiptOrder)(user.id, storeId, receiptId, input, {
          signal,
        }),
      ),
      local = await database.offlineCashReceipts.get([user.id, receiptId]);
    if (!local) throw new Error('The original cash receipt is unavailable.');
    assertAcceptedCash(local.envelope, result);
    signal.throwIfAborted();
    const proved = await refreshOfflineCashReceipt(user, storeId, receiptId, {
      ...options,
      ...context,
    });
    if (proved?.status === 'imported' || proved?.status === 'conflicted') return proved;
    throw new Error('The saved order synchronization outcome is not yet confirmed.');
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
    const errorCode =
      error instanceof ApiError && /^[A-Z_]{1,80}$/.test(error.code)
        ? error.code
        : 'OFFLINE_CASH_IMPORT_OUTCOME_UNCONFIRMED';
    await database.transaction('rw', [database.sessions, database.offlineCashSync], async () => {
      if (!(await activeSession(user, storeId, context))) return;
      const job = await database.offlineCashSync.get(receiptId),
        current = job?.orderImport;
      if (
        job?.ownerId !== user.id ||
        current?.operationId !== intent.operationId ||
        current?.attemptId !== intent.attemptId ||
        current.state !== 'dispatching'
      )
        return;
      await database.offlineCashSync.update(receiptId, {
        orderImport: { ...current, state: 'uncertain', attemptId: null, errorCode },
      });
      signal.throwIfAborted();
    });
    throw error;
  }
}

/** A new clean receipt gets one automatic dispatch, protected by a durable cross-tab claim. */
export const startOfflineCashOrderImport = (
  user: Principal,
  storeId: string,
  receiptId: string,
  options: CashOrderImportOptions = {},
) => dispatchImport(user, storeId, receiptId, false, options);

/** The owner explicitly retries only the exact saved intent after a read-only reconciliation. */
export const retryOfflineCashOrderImport = (
  user: Principal,
  storeId: string,
  receiptId: string,
  options: CashOrderImportOptions = {},
) => dispatchImport(user, storeId, receiptId, true, options);

export async function startOfflineCashOrderImports(
  user: Principal,
  storeId: string,
  options: CashOrderImportOptions = {},
) {
  const database = options.database || db,
    signal = options.signal || captureOperatorScope(user.id);
  const candidates = options.counterId
    ? database.offlineCashSync
        .where('[ownerId+storeId+counterId+state]')
        .equals([user.id, storeId, options.counterId, 'accepted'])
    : database.offlineCashSync.where('[ownerId+state]').equals([user.id, 'accepted']);
  const jobs = await candidates
    .filter(
      (job) => job.storeId === storeId && !job.orderImport && job.autoImportEligible !== false,
    )
    .limit(20)
    .toArray();
  for (const job of jobs) {
    signal.throwIfAborted();
    try {
      await startOfflineCashOrderImport(user, storeId, job.receiptId, { ...options, signal });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) return;
      // The durable intent exposes an unknown result for explicit recovery.
      // Other clean receipts may still progress; this intent is never auto-retried.
    }
  }
}
