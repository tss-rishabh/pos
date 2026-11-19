import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import {
  cancelTerminalTransaction,
  checkTerminalStatus,
  type PaymentContext,
  type PaymentResult,
} from './client';
import {
  PAYTM_CANCEL_CONFIRMATION,
  PINE_POLL_INTERVAL_MS,
  PINE_POLL_MAX_ATTEMPTS,
  PINE_POLL_TIMEOUT_MESSAGE,
} from './form';

interface TerminalStatusProps {
  ownerId: string;
  storeId: string;
  orderId: string;
  online: boolean;
  transaction: NonNullable<PaymentContext['activeTransaction']>;
  /** Paid, cancelled, timed out or vanished: the parent reloads the payment context. */
  onSettled: (result: PaymentResult | null, notice: string) => void;
}
/**
 * Uploaded terminal payment (order/templates/order/show.html:446-700): status check and
 * cancel, with automatic Pine polling every 5 s for up to 63 checks.
 */
export function TerminalStatus({
  ownerId,
  storeId,
  orderId,
  online,
  transaction,
  onSettled,
}: TerminalStatusProps) {
  const [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmCancel, setConfirmCancel] = useState(false);
  const attempts = useRef(0),
    lock = useRef(false),
    done = useRef(false),
    settled = useRef(onSettled);
  settled.current = onSettled;
  const finish = (result: PaymentResult | null, notice: string) => {
    if (done.current) return;
    done.current = true;
    settled.current(result, notice);
  };
  const check = useCallback(async () => {
    if (lock.current || done.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await checkTerminalStatus(
        storeId,
        orderId,
        ownerId,
        transaction.transactionId,
      );
      if (result.status === 'paid') finish(result, 'Transaction Completed Successfully');
      else if (result.status === 'failed') finish(result, result.message);
      else setStatus(result.message);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) finish(null, error.message);
      else setStatus(error instanceof Error ? error.message : 'Status :Failed, Check Status Again');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, [storeId, orderId, ownerId, transaction.transactionId]);
  useEffect(() => {
    if (transaction.provider !== 'pine' || !online) return;
    const timer = setInterval(() => {
      if (done.current) return clearInterval(timer);
      if (attempts.current >= PINE_POLL_MAX_ATTEMPTS) {
        clearInterval(timer);
        setStatus(PINE_POLL_TIMEOUT_MESSAGE);
        return;
      }
      attempts.current += 1;
      void check();
    }, PINE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [transaction.provider, online, check]);
  async function cancel() {
    if (lock.current || done.current) return;
    lock.current = true;
    setBusy(true);
    setConfirmCancel(false);
    try {
      const result = await cancelTerminalTransaction(
        storeId,
        orderId,
        ownerId,
        transaction.transactionId,
      );
      finish(result, result.message);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) finish(null, error.message);
      else setStatus(error instanceof Error ? error.message : 'Status :Failed, Check Status Again');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="terminal-status">
      <label>
        Transaction ID:
        <input value={transaction.transactionId} disabled readOnly />
      </label>
      {transaction.provider === 'pine' && transaction.reference && (
        <label>
          Plutus ID:
          <input value={transaction.reference} disabled readOnly />
        </label>
      )}
      <p role="status" aria-live="polite">
        {status ? <b>{status}</b> : null}
      </p>
      <p style={{ fontWeight: 600 }}>Payment processing, Please check status...</p>
      <button
        type="button"
        className="button primary"
        disabled={busy || !online}
        onClick={() => void check()}
      >
        {busy ? 'Checking…' : 'Status check'}
      </button>
      {confirmCancel ? (
        <div role="alertdialog" aria-label="Confirmation!">
          <p>{PAYTM_CANCEL_CONFIRMATION}</p>
          <button type="button" className="button danger" onClick={() => void cancel()}>
            Yes, sure!
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => setConfirmCancel(false)}
          >
            cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button secondary"
          disabled={busy || !online}
          onClick={() =>
            transaction.provider === 'paytm' ? setConfirmCancel(true) : void cancel()
          }
        >
          Cancel txn
        </button>
      )}
    </div>
  );
}
