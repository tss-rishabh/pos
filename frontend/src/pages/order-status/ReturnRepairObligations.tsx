import { useCallback, useEffect, useState } from 'react';
import type { Principal } from '../../api/types';
import { ApiError, captureOperatorScope } from '../../api/client';
import { repairMarkerKey, readStatusMarkers } from './markers';
import {
  listReturnRepairs,
  readReturnRepair,
  recoverReturnRepair,
  recoveryIntentSchema,
  type ReturnRepair,
  type RepairRecoveryIntent,
} from './repair-client';
export function ReturnRepairObligations({
  user,
  storeId,
  orderId,
  online,
}: {
  user: Principal;
  storeId: string;
  orderId: string;
  online: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<ReturnRepair[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState<RepairRecoveryIntent | null>(null),
    key = repairMarkerKey(user, storeId, orderId);
  const load = useCallback(async () => {
    const signal = captureOperatorScope(user.id);
    setBusy(true);
    setError(null);
    try {
      const result = await listReturnRepairs(user.id, storeId, orderId, signal);
      signal.throwIfAborted();
      setRows(result);
      setLoaded(true);
      const saved = readStatusMarkers(user, storeId, orderId).recovery;
      if (saved) {
        const intent = saved,
          row = result.find((value) => value.returnOperationId === intent.returnId);
        if (row && (row.version > intent.expectedVersion || row.state === 'LINKED')) {
          sessionStorage.removeItem(key);
          setPending(null);
        } else setPending(intent);
      }
    } catch (caught: unknown) {
      if (!signal.aborted)
        setError(
          caught instanceof ApiError ? caught.message : 'Could not verify the repair receipts.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }, [key, user.id, storeId, orderId]);
  useEffect(() => {
    if (online) void load();
  }, [online, load]);
  async function act(row: ReturnRepair, recover: boolean) {
    const signal = captureOperatorScope(user.id);
    setBusy(true);
    setError(null);
    try {
      let result: ReturnRepair;
      if (recover) {
        const intent = readStatusMarkers(user, storeId, orderId).recovery ??
          pending ?? {
            returnId: row.returnOperationId,
            operationId: crypto.randomUUID(),
            expectedVersion: row.version,
          };
        if (intent.returnId !== row.returnOperationId)
          throw new Error('Refresh the pending repair first.');
        sessionStorage.setItem(key, JSON.stringify(intent));
        signal.throwIfAborted();
        setPending(intent);
        result = await recoverReturnRepair(user.id, storeId, orderId, intent, signal);
      } else
        result = await readReturnRepair(user.id, storeId, orderId, row.returnOperationId, signal);
      signal.throwIfAborted();
      setRows((values) =>
        values.map((value) =>
          value.returnOperationId === result.returnOperationId ? result : value,
        ),
      );
      const saved = sessionStorage.getItem(key);
      if (saved) {
        const intent = recoveryIntentSchema.parse(JSON.parse(saved) as unknown);
        if (
          intent.returnId === result.returnOperationId &&
          (result.version > intent.expectedVersion || result.state === 'LINKED')
        ) {
          sessionStorage.removeItem(key);
          setPending(null);
        }
      }
    } catch (caught: unknown) {
      if (!signal.aborted)
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not verify the recovery. Refresh its receipt before trying again.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Rejected-return repair obligations">
      <h4>Rejected-return repairs</h4>
      <p>
        These requests repair fulfillment status only. The original return rejection, money and
        stock remain unchanged.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="button secondary"
        disabled={!online || busy}
        onClick={() => void load()}
      >
        Refresh repair obligations
      </button>
      {loaded && rows.length === 0 && !error && (
        <p>No rejected-return repairs recorded for this order.</p>
      )}
      {rows.map((row) => (
        <article key={row.returnOperationId}>
          <p>Original return {row.returnOperationId}</p>
          <p role="status">
            Repair: {row.state}
            {row.command ? ' · PACK: ' + row.command.state : ''}
          </p>
          {row.errorCode && (
            <p>
              Blocked: {row.errorCode}. Rechecking preserves the original return and repair
              identity.
            </p>
          )}
          {row.receiptRefreshError && (
            <p>The external receipt could not be verified. No status action was sent again.</p>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={!online || busy}
            onClick={() => void act(row, false)}
          >
            Refresh repair receipt
          </button>
          {row.state === 'BLOCKED' && (
            <button
              type="button"
              className="button secondary"
              disabled={
                !online || busy || Boolean(pending && pending.returnId !== row.returnOperationId)
              }
              onClick={() => void act(row, true)}
            >
              {pending?.returnId === row.returnOperationId
                ? 'Retry the same recovery'
                : 'Recheck blocked repair'}
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
