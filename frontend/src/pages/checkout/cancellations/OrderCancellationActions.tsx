import { useEffect, useRef, useState } from 'react';
import { captureOperatorScope, post, request } from '../../../api/client';
import { RequestReference, useProblem } from '../../../components/common';
import { useOnline } from '../../../hooks/use-pos';
import {
  cancellationContextSchema,
  cancellationPath,
  cancellationResultSchema,
  type CancellationContext,
} from './client';
interface Props {
  ownerId: string;
  storeId: string;
  orderId: string;
  onCancelled: () => void;
}
/** Legacy "Cancel Order" button and confirmation (order/templates/order/show.html:67-72, 1014-1049). */
export function OrderCancellationActions({ ownerId, storeId, orderId, onCancelled }: Props) {
  const online = useOnline(),
    [context, setContext] = useState<CancellationContext | null>(null),
    [problem, setProblem, problemCause, reportProblem] = useProblem(),
    [busy, setBusy] = useState(false),
    [confirming, setConfirming] = useState(false),
    [done, setDone] = useState('');
  const lock = useRef(false),
    callback = useRef(onCancelled);
  callback.current = onCancelled;
  const base = cancellationPath(storeId, orderId);
  useEffect(() => {
    if (!online) return;
    const signal = captureOperatorScope(ownerId);
    request(base, { operatorId: ownerId, signal }, cancellationContextSchema)
      .then((value) => {
        if (signal.aborted) return;
        if (value.orderId !== orderId || value.storeId !== storeId)
          throw new Error('The cancellation response belongs to another order.');
        setContext(value);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) reportProblem(error, 'Cancellation state is unavailable.');
      });
  }, [online, base, ownerId, storeId, orderId]);
  async function cancel() {
    if (lock.current) return;
    const signal = captureOperatorScope(ownerId);
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      const result = await post(base, {}, cancellationResultSchema, ownerId);
      if (signal.aborted) return;
      if (result.orderId !== orderId || result.storeId !== storeId)
        throw new Error('The cancellation response belongs to another order.');
      setDone(result.message);
      setContext({ ...result, eligible: false });
      setConfirming(false);
      callback.current();
    } catch (error) {
      if (!signal.aborted) reportProblem(error, 'Something went wrong.');
    } finally {
      lock.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Pending order cancellation">
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {problem && <RequestReference error={problemCause} />}
      {done ? (
        <p role="status">{done}</p>
      ) : context?.eligible ? (
        confirming ? (
          <>
            <p>Do you want to cancel this order?</p>
            <button
              className="button primary"
              disabled={busy || !online}
              onClick={() => void cancel()}
            >
              Yes, sure!
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="button secondary"
            disabled={busy || !online}
            onClick={() => setConfirming(true)}
          >
            Cancel Order
          </button>
        )
      ) : null}
    </section>
  );
}
