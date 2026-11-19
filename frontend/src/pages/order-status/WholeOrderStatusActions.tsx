import { useCallback, useEffect, useState } from 'react';
import type { Principal } from '../../api/types';
import { captureOperatorScope } from '../../api/client';
import { RequestReference, useProblem } from '../../components/common';
import {
  pushOrderStatus,
  readOrderStatus,
  type StatusPlatform,
  type WholeOrderStatus,
} from './client';
const fallback = 'Could not load the Vinculum status. Try again.';
/**
 * Legacy order detail "Vinculum Status" tab (`order/templates/order/show.html:303-340`): the
 * last status per stage and a retry button for each of PACK/SHIP/DELIVER that has not
 * succeeded. Unprocessed orders show "Order Is Not Processed Yet".
 */
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
  const [expanded, setExpanded] = useState(false),
    [status, setStatus] = useState<WholeOrderStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError, errorCause, reportError] = useProblem(),
    [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const signal = captureOperatorScope(user.id);
    setBusy(true);
    setError('');
    try {
      const value = await readOrderStatus(user.id, storeId, orderId, signal);
      if (!signal.aborted) setStatus(value);
    } catch (caught: unknown) {
      if (!signal.aborted) reportError(caught, fallback, { apiOnly: true });
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }, [user.id, storeId, orderId]);
  useEffect(() => {
    setStatus(null);
    setNotice(null);
    if (expanded && online) void refresh();
  }, [expanded, online, refresh]);
  async function push(platform: StatusPlatform) {
    const signal = captureOperatorScope(user.id);
    setBusy(true);
    setError('');
    setNotice(null);
    try {
      const result = await pushOrderStatus(user.id, storeId, orderId, platform, signal);
      if (!signal.aborted) setNotice(result.message);
    } catch (caught: unknown) {
      if (!signal.aborted) reportError(caught, fallback, { apiOnly: true });
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Vinculum status">
      <button
        type="button"
        className="button secondary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        Vinculum Status
      </button>
      {expanded && (
        <div>
          {!online && <p role="status">Connect to load the Vinculum status.</p>}
          {error && <p role="alert">{error}</p>}
          {error && <RequestReference error={errorCause} />}
          {notice && <p role="status">{notice}</p>}
          {status &&
            (!status.processed ? (
              <p>Order Is Not Processed Yet</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Creation Status</th>
                    {(['PACK', 'SHIP', 'DELIVER'] as const).map((stage) => (
                      <th key={stage}>
                        {stage === 'PACK' ? 'Pack' : stage === 'SHIP' ? 'Ship' : 'Deliver'} Status{' '}
                        {status.stages[stage].status !== 'SUCCESS' && (
                          <button
                            type="button"
                            className="button secondary"
                            disabled={!online || busy}
                            aria-label={`Retry ${stage}`}
                            onClick={() => void push(stage)}
                          >
                            Retry
                          </button>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{status.stages.CREATE.status}</td>
                    {(['PACK', 'SHIP', 'DELIVER'] as const).map((stage) => (
                      <td key={stage}>
                        {status.stages[stage].status}
                        <br />
                        <small>{status.stages[stage].date}</small>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            ))}
        </div>
      )}
    </section>
  );
}
