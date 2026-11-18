import { useEffect, useRef, useState } from 'react';
import { ApiError, captureOperatorScope } from '../../api/client';
import {
  clearCorrectionIntent,
  correctionIntent,
  createCorrection,
  persistCorrectionIntent,
  readCorrection,
  readCorrectionContext,
  type CorrectionContext,
  type CorrectionInput,
  type CorrectionReceipt,
} from './client';

interface Props {
  user: { id: string };
  storeId: string;
  orderId: string;
  online: boolean;
  deferUntilOpened?: boolean;
  /** Refresh order/payment/invoice detail only. This is never a cart completion. */
  onCorrected?: (receipt: CorrectionReceipt) => Promise<void>;
}
export function PaymentReversalPanel(props: Props) {
  return (
    <PaymentReversalEntry key={`${props.user.id}:${props.storeId}:${props.orderId}`} {...props} />
  );
}
function PaymentReversalEntry(props: Props) {
  const [open, setOpen] = useState(() => {
    if (!props.deferUntilOpened) return true;
    try {
      return Boolean(
        correctionIntent({
          ownerId: props.user.id,
          storeId: props.storeId,
          orderId: props.orderId,
        }),
      );
    } catch {
      // Unreadable recovery must remain visible to the original operator.
      return true;
    }
  });
  if (!props.deferUntilOpened) return <ScopedPaymentReversalPanel {...props} />;
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Correct recorded cash payment</summary>
      {open && <ScopedPaymentReversalPanel {...props} />}
    </details>
  );
}
function ScopedPaymentReversalPanel({ user, storeId, orderId, online, onCorrected }: Props) {
  const [context, setContext] = useState<CorrectionContext | null>(null),
    [intent, setIntent] = useState<CorrectionInput | null>(null),
    [receipt, setReceipt] = useState<CorrectionReceipt | null>(null),
    [acknowledged, setAcknowledged] = useState(false),
    [noHandover, setNoHandover] = useState(false),
    [reason, setReason] = useState<CorrectionInput['reason']>('customer-payment-correction'),
    [busy, setBusy] = useState(false),
    [missing, setMissing] = useState(false),
    [problem, setProblem] = useState('');
  const lock = useRef(false),
    mounted = useRef(true),
    callback = useRef(onCorrected);
  callback.current = onCorrected;
  const ownerId = user.id;
  const scope = { ownerId, storeId, orderId };
  useEffect(() => {
    mounted.current = true;
    setContext(null);
    setReceipt(null);
    setIntent(null);
    setAcknowledged(false);
    setNoHandover(false);
    setMissing(false);
    setProblem('');
    let active = true;
    const signal = captureOperatorScope(ownerId);
    async function load() {
      try {
        const saved = correctionIntent({ ownerId, storeId, orderId });
        if (active) setIntent(saved);
        if (!online) return;
        if (saved) {
          try {
            const value = await readCorrection({ ownerId, storeId, orderId }, saved, signal);
            if (active && !signal.aborted) {
              setReceipt(value);
              clearCorrectionIntent({ ownerId, storeId, orderId });
            }
          } catch (error) {
            if (active && !signal.aborted) {
              if (
                error instanceof ApiError &&
                error.status === 404 &&
                error.code === 'PAYMENT_REVERSAL_NOT_FOUND'
              )
                setMissing(true);
              else throw error;
            }
          }
        }
        const value = await readCorrectionContext({ ownerId, storeId, orderId }, signal);
        if (value.storeId !== storeId || value.orderId !== orderId)
          throw new Error('The correction context belongs to another order.');
        if (active && !signal.aborted) setContext(value);
      } catch (error) {
        if (active && !signal.aborted)
          setProblem(
            error instanceof Error
              ? error.message
              : 'The original payment correction is unavailable.',
          );
      }
    }
    void load();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [ownerId, storeId, orderId, online]);
  async function act(task: (signal: AbortSignal) => Promise<void>) {
    if (lock.current || !online) return;
    const signal = captureOperatorScope(ownerId);
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task(signal);
    } catch (error) {
      if (mounted.current && !signal.aborted)
        setProblem(
          error instanceof Error
            ? error.message
            : 'Check the original correction before continuing.',
        );
    } finally {
      lock.current = false;
      if (mounted.current && !signal.aborted) setBusy(false);
    }
  }
  async function adopt(value: CorrectionReceipt, signal: AbortSignal) {
    if (signal.aborted || !mounted.current) return;
    setReceipt(value);
    setMissing(false);
    clearCorrectionIntent(scope);
    try {
      await callback.current?.(value);
    } catch {
      if (!signal.aborted && mounted.current)
        setProblem(
          'Cash correction is recorded. Refresh the order details; do not return cash again.',
        );
    }
  }
  return (
    <section aria-label="Recorded cash payment correction">
      <h3>Correct recorded cash payment</h3>
      <p>
        The original payment stays in the audit history. Record only cash actually returned at this
        counter. Stock and benefits remain attached to this order.
      </p>
      {!online && <p>Reconnect to review or record a cash correction.</p>}
      {problem && <p role="alert">{problem}</p>}
      {receipt ? (
        <>
          <p role="status">
            Cash correction recorded · {receipt.returnedCash} returned · {receipt.id}. No provider
            refund was performed.
          </p>
          <button
            disabled={busy || !online}
            onClick={() => void act((signal) => adopt(receipt, signal))}
          >
            Refresh corrected order
          </button>
        </>
      ) : intent ? (
        <>
          <p role="status">
            Check the original correction reference before another action: {intent.operationId}. Do
            not return cash again.
          </p>
          <button
            disabled={busy || !online}
            onClick={() =>
              void act(async (signal) => {
                try {
                  await adopt(await readCorrection(scope, intent, signal), signal);
                } catch (error) {
                  if (
                    error instanceof ApiError &&
                    error.status === 404 &&
                    error.code === 'PAYMENT_REVERSAL_NOT_FOUND'
                  )
                    setMissing(true);
                  throw error;
                }
              })
            }
          >
            Check original cash correction
          </button>
          {missing && (
            <button
              disabled={busy || !online}
              onClick={() =>
                void act(async (signal) => {
                  await adopt(await createCorrection(scope, intent), signal);
                })
              }
            >
              Register original cash correction again
            </button>
          )}
        </>
      ) : context?.eligible && context.returnedCash ? (
        <>
          <label>
            Correction reason
            <select
              value={reason}
              disabled={busy || !online}
              onChange={(event) =>
                setReason(
                  event.target.value === 'incorrect-payment-record'
                    ? 'incorrect-payment-record'
                    : 'customer-payment-correction',
                )
              }
            >
              <option value="customer-payment-correction">Customer payment correction</option>
              <option value="incorrect-payment-record">Incorrect payment record</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy || !online}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I returned exactly {context.returnedCash} in cash at counter {context.counterId}.
          </label>
          <label>
            <input
              type="checkbox"
              checked={noHandover}
              disabled={busy || !online}
              onChange={(event) => setNoHandover(event.target.checked)}
            />
            Goods have not been handed over and remain at this counter.
          </label>
          <button
            disabled={busy || !online || !acknowledged || !noHandover}
            onClick={() =>
              void act(async (signal) => {
                if (!context.snapshotHash || !context.originalPaymentId || !context.returnedCash)
                  return;
                const body: CorrectionInput = {
                  operationId: crypto.randomUUID(),
                  originalPaymentId: context.originalPaymentId,
                  counterId: context.counterId,
                  snapshotHash: context.snapshotHash,
                  cashReturnReceiptId: crypto.randomUUID(),
                  returnedCash: context.returnedCash,
                  confirmCashReturned: true,
                  confirmNoHandover: true,
                  reason,
                };
                persistCorrectionIntent(scope, body);
                if (signal.aborted) return;
                setIntent(body);
                setMissing(false);
                await adopt(await createCorrection(scope, body), signal);
              })
            }
          >
            Record returned cash and reopen payment
          </button>
        </>
      ) : (
        online && (
          <p>
            {context?.blocker
              ? `This payment requires reconciliation (${context.blocker}).`
              : 'Loading original payment evidence…'}
          </p>
        )
      )}
    </section>
  );
}
