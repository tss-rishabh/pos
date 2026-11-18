import { useRef, useState } from 'react';
import { captureOperatorScope } from '../../api/client';
import { copyOrder, type CopyCancellation, type OrderCopyScope } from './client';
import { markOrderCopyOrigin } from './marker';

export interface OrderCopyPanelProps {
  scope: OrderCopyScope;
  checkoutVersion: number;
  online: boolean;
  disabled?: boolean;
  beforeDispatch?: () => Promise<void>;
  /** TRANSITIONAL: never called; order copies have no cancellation in legacy. */
  onUnsentCancelled?: (proof: CopyCancellation) => Promise<void>;
  onPending: (value: boolean) => void;
  onSaved: () => Promise<void>;
}
/** Legacy "Sync Order Cart" dialog (order/templates/order/create_order.html:7998-8068). */
export function OrderCopyPanel(props: OrderCopyPanelProps) {
  const { scope, online, disabled, beforeDispatch, onPending, onSaved } = props;
  const [orderId, setOrderId] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [problem, setProblem] = useState('');
  const lock = useRef(false);
  async function submit() {
    if (lock.current) return;
    const value = orderId.replace(/_/g, '').trim();
    if (!/^[1-9]\d{0,19}$/.test(value)) {
      setProblem('Please Provide a Valid Order ID');
      return;
    }
    const signal = captureOperatorScope(scope.operatorId);
    lock.current = true;
    setBusy(true);
    setProblem('');
    setMessage('');
    onPending(true);
    try {
      await beforeDispatch?.();
      // The server cart will differ from the local draft: keep this checkout online-only.
      markOrderCopyOrigin(scope.operatorId, scope.storeId, scope.checkoutId, crypto.randomUUID());
      const result = await copyOrder(scope, value);
      if (signal.aborted) return;
      setMessage(result.message);
      setOrderId('');
      await onSaved();
    } catch (error) {
      if (!signal.aborted)
        setProblem(error instanceof Error ? error.message : 'Cart Sync Failed, Please Try Again');
    } finally {
      lock.current = false;
      onPending(false);
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Sync Order Cart">
      <h3>Sync Order Cart</h3>
      <label>
        Order ID
        <input
          inputMode="numeric"
          maxLength={20}
          placeholder="Enter Order Id You Wanna Sync"
          value={orderId}
          onChange={(event) => setOrderId(event.target.value)}
          disabled={busy || disabled || !online}
        />
      </label>
      <button type="button" disabled={busy || disabled || !online} onClick={() => void submit()}>
        Submit
      </button>
      {message && <p role="status">{message}</p>}
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
export { orderCopyRequiresOnlineReview, clearOrderCopyOrigin } from './marker';
