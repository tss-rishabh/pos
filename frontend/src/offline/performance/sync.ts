import { ApiError, captureOperatorScope } from '../../api/client';
import { db } from '../database';
import { performanceApi, assertPerformanceReceipt, type PerformanceApi } from './client';
import { performanceCommand, type PerformanceCommand } from './contracts';
import {
  claimPerformance,
  finishPerformanceClaim,
  type PerformanceStorageOptions,
} from './storage';

export interface PerformanceSyncOptions extends PerformanceStorageOptions {
  api?: PerformanceApi;
}
/** Only optional metadata is retried. This module has no order/payment API. */
export async function recordPreparedPerformance(
  id: string,
  ownerId: string,
  options: PerformanceSyncOptions = {},
) {
  const signal = options.signal ?? captureOperatorScope(ownerId);
  const claimed = await claimPerformance(id, ownerId, { ...options, signal });
  if (!claimed) return null;
  const { command, lookupFirst } = claimed,
    api = options.api ?? performanceApi;
  try {
    let receipt = lookupFirst ? await api.read(command, signal) : null;
    signal.throwIfAborted();
    if (!receipt) receipt = await api.write(command, signal);
    signal.throwIfAborted();
    assertPerformanceReceipt(command, receipt);
    return await finishPerformanceClaim(command, 'recorded', null, { ...options, signal });
  } catch (cause) {
    if (signal.aborted) throw cause;
    const rejected =
      cause instanceof ApiError && [400, 401, 403, 404, 409, 410, 422].includes(cause.status);
    const code =
      cause instanceof ApiError && /^[A-Z0-9_]{1,100}$/.test(cause.code)
        ? cause.code
        : 'PERFORMANCE_SAVE_UNCONFIRMED';
    return finishPerformanceClaim(command, rejected ? 'rejected' : 'unknown', code, {
      ...options,
      signal,
    });
  }
}
export async function syncPreparedPerformance(
  ownerId: string,
  storeId: string,
  counterId: string,
  options: PerformanceSyncOptions = {},
) {
  const database = options.database ?? db,
    signal = options.signal ?? captureOperatorScope(ownerId);
  const now = options.clock?.() ?? Date.now();
  // Only commands already bound to a proved order/receipt are sent. The fast-cash
  // binder that turned 'captured' commands into 'prepared' ones was removed with
  // fast cash; captured records stay inert.
  const records: PerformanceCommand[] = [];
  for (const state of ['prepared', 'sending', 'unknown'] as const) {
    if (records.length >= 10) break;
    records.push(
      ...(await database.performanceCommands
        .where('[ownerId+storeId+counterId+state+nextAttemptAt]')
        .between(
          [ownerId, storeId, counterId, state, 0],
          [ownerId, storeId, counterId, state, now],
          true,
          true,
        )
        .limit(10 - records.length)
        .toArray()),
    );
  }
  for (const record of records) {
    signal.throwIfAborted();
    const parsed = performanceCommand.safeParse(record);
    if (parsed.success)
      await recordPreparedPerformance(parsed.data.id, ownerId, { ...options, signal });
  }
}
