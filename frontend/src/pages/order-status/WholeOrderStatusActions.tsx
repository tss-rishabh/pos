import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Principal } from '../../api/types';
import { ApiError, captureOperatorScope } from '../../api/client';
import { ReturnRepairObligations } from './ReturnRepairObligations';
import { statusMarkerKey, inspectStatusMarkers, readStatusMarkers } from './markers';
import {
  readOrderStatus,
  readStatusCommand,
  saveOrderStatus,
  type StatusIntent,
  type StatusCommand,
  type WholeOrderStatus,
} from './client';
const activeStates = ['PENDING', 'SENDING', 'QUEUED', 'UNCERTAIN'];
const message = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : 'Could not verify the status request. Refresh its receipt before continuing.';
/** A marker contains only an immutable operation ID, stage and line-scope digest. */
const markerKey = statusMarkerKey;
export function WholeOrderStatusActions({
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
  return (
    <WholeOrderStatusContent
      key={markerKey(user, storeId, orderId)}
      user={user}
      storeId={storeId}
      orderId={orderId}
      online={online}
    />
  );
}
function WholeOrderStatusContent({
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
  const [initial] = useState(() => inspectStatusMarkers(user, storeId, orderId));
  const key = useMemo(() => markerKey(user, storeId, orderId), [user, storeId, orderId]),
    [expanded, setExpanded] = useState(initial.expanded),
    [storageBlocked, setStorageBlocked] = useState(initial.blocked),
    [status, setStatus] = useState<WholeOrderStatus | null>(null),
    [intent, setIntent] = useState<StatusIntent | null>(null),
    [command, setCommand] = useState<StatusCommand | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notRecorded, setNotRecorded] = useState(false);
  const guard = useCallback(() => captureOperatorScope(user.id), [user.id]);
  const refresh = useCallback(async () => {
    const signal = guard();
    setBusy(true);
    setError(null);
    setNotRecorded(false);
    try {
      const value = await readOrderStatus(user.id, storeId, orderId, signal);
      signal.throwIfAborted();
      setStatus(value);
      let frozen: StatusIntent | null = null;
      try {
        frozen = readStatusMarkers(user, storeId, orderId).intent;
      } catch {
        setStorageBlocked(true);
        throw new Error('Invalid saved status metadata.');
      }
      setIntent(frozen);
      const current = frozen
        ? await readStatusCommand(user.id, storeId, orderId, frozen.operationId, signal)
        : (value.commands[0] ?? null);
      signal.throwIfAborted();
      setCommand(current);
      if (current)
        setStatus({
          ...value,
          commands: value.commands.map((row) =>
            row.operationId === current.operationId ? current : row,
          ),
        });
      if (current && !activeStates.includes(current.state)) {
        sessionStorage.removeItem(key);
        setIntent(null);
      }
    } catch (caught: unknown) {
      if (!signal.aborted) {
        setError(message(caught));
        if (caught instanceof ApiError && caught.code === 'WHOLE_ORDER_STATUS_COMMAND_NOT_FOUND')
          setNotRecorded(true);
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }, [guard, key, user.id, storeId, orderId]);
  useEffect(() => {
    setStatus(null);
    setCommand(null);
    setIntent(null);
    setError(null);
    if (expanded && online) void refresh();
  }, [expanded, online, refresh]);
  async function save(frozen: StatusIntent) {
    const signal = guard();
    setBusy(true);
    setError(null);
    setNotRecorded(false);
    try {
      try {
        const saved = readStatusMarkers(user, storeId, orderId);
        if (saved.intent && JSON.stringify(saved.intent) !== JSON.stringify(frozen))
          throw new Error('An immutable request is already pending.');
      } catch {
        setStorageBlocked(true);
        throw new Error('Saved status metadata needs reconciliation.');
      }
      sessionStorage.setItem(key, JSON.stringify(frozen));
      signal.throwIfAborted();
      setIntent(frozen);
      const saved = await saveOrderStatus(user.id, storeId, orderId, frozen, signal);
      signal.throwIfAborted();
      setCommand(saved);
    } catch (caught: unknown) {
      if (!signal.aborted) setError(message(caught));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  const active = Boolean(
      storageBlocked ||
      intent ||
      (command && activeStates.includes(command.state)) ||
      status?.commands.some((row) => activeStates.includes(row.state)),
    ),
    disabled = !online || busy;
  return (
    <section aria-label="Whole-order fulfillment status">
      <button
        type="button"
        className="button secondary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        Whole-order status
      </button>
      {expanded && (
        <div>
          <p>
            Pack, ship and delivery requests apply to every item in this store order. A queued
            request is awaiting processing.
          </p>
          {!online && <p role="status">Connect to refresh or request a status.</p>}
          {error && <p role="alert">{error}</p>}
          {storageBlocked && (
            <p role="alert">
              Saved status metadata needs reconciliation. New status actions are blocked.
            </p>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() => void refresh()}
          >
            Refresh status receipt
          </button>
          {status && (
            <>
              <dl>
                {(['CREATE', 'PACK', 'SHIP', 'DELIVER'] as const).map((stage) => (
                  <div key={stage}>
                    <dt>{stage}</dt>
                    <dd>
                      {status.stages[stage].status ?? '-'} {status.stages[stage].date}
                    </dd>
                  </div>
                ))}
              </dl>
              {!status.eligible && (
                <p>This order is not currently ready for a whole-order status request.</p>
              )}
              {!status.adapterReady && (
                <p>The qualified fulfillment connection is not configured.</p>
              )}
              {(['PACK', 'SHIP', 'DELIVER'] as const)
                .filter((stage) => status.stages[stage].status !== 'SUCCESS')
                .map((stage) => (
                  <button
                    type="button"
                    className="button secondary"
                    key={stage}
                    disabled={disabled || active || !status.eligible || !status.adapterReady}
                    onClick={() =>
                      void save({
                        operationId: crypto.randomUUID(),
                        platform: stage,
                        scopeHash: status.scopeHash,
                      })
                    }
                  >
                    Queue {stage}
                  </button>
                ))}
            </>
          )}
          {command && (
            <p role="status">
              {command.platform}: {command.state}. {command.lineCount} item rows.{' '}
              {command.state === 'UNCERTAIN'
                ? 'The outcome needs reconciliation. This action will not be sent again.'
                : command.state === 'SUCCEEDED'
                  ? 'All requested fulfillment stages completed.'
                  : command.state === 'REJECTED'
                    ? 'The fulfillment chain stopped with a recorded rejection.'
                    : ''}
            </p>
          )}
          {intent && notRecorded && (
            <button
              type="button"
              className="button secondary"
              disabled={disabled}
              onClick={() => void save(intent)}
            >
              Retry saving the same request
            </button>
          )}
          {user.role <= 4 && (
            <ReturnRepairObligations
              user={user}
              storeId={storeId}
              orderId={orderId}
              online={online}
            />
          )}
        </div>
      )}
    </section>
  );
}
