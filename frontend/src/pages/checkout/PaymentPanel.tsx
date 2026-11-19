import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { currency } from '../../lib/format';
import type { ConfirmedPayment } from './receipts';
import {
  clearPaymentRecovery,
  paymentStorageKey,
  readPaymentRecovery,
  savePaymentRecovery,
  type PaymentRecovery,
  type RecordedPaymentInput,
} from './payment-recovery';
import {
  readPaymentAttempt,
  readPaymentContext,
  readPaymentOptions,
  settlementReceiptId,
  startPayment,
  type PaymentContext,
  type PaymentOptions,
  type PaymentResult,
} from './payments/client';
import {
  changeCash,
  changeOnline,
  changeReceived,
  initialPaymentForm,
  money,
  paymentFormProblem,
  paymentMessage,
  type PaymentFormValues,
} from './payments/form';
import { TerminalStatus } from './payments/TerminalStatus';
export type { ConfirmedPayment } from './receipts';
export { paymentResultSchema as paymentSchema } from './payments/client';

interface PaymentPanelProps {
  ownerId: string;
  draftId: string;
  storeId: string;
  orderId: string;
  online: boolean;
  onConfirmed?: (receipt: ConfirmedPayment, origin: 'read' | 'action') => void;
  allowNewPayments?: boolean;
}
type Phase = 'form' | 'confirm';
/**
 * Counter payment (legacy create_order.html payment form + order show.html status modal).
 * The order is paid when the server says so; a terminal upload only waits on the terminal.
 */
export function PaymentPanel({
  ownerId,
  draftId,
  storeId,
  orderId,
  online,
  onConfirmed,
  allowNewPayments = true,
}: PaymentPanelProps) {
  const [context, setContext] = useState<PaymentContext | null>(null),
    [options, setOptions] = useState<PaymentOptions | null>(null),
    [form, setForm] = useState<PaymentFormValues | null>(null),
    [message, setMessage] = useState(''),
    [selection, setSelection] = useState(''),
    [district, setDistrict] = useState(''),
    [creditPincode, setCreditPincode] = useState(''),
    [phase, setPhase] = useState<Phase>('form'),
    [recovery, setRecovery] = useState<PaymentRecovery | null>(null),
    [notice, setNotice] = useState(''),
    [problem, setProblem] = useState(''),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    notified = useRef<string | null>(null),
    callback = useRef(onConfirmed);
  callback.current = onConfirmed;
  const storageKey = paymentStorageKey(ownerId, draftId, orderId);

  const confirm = useCallback(
    (
      settled: { transactionId: string; cashAmount: string; onlineAmount: string },
      origin: 'read' | 'action',
    ) => {
      // One stable identity per settlement, whichever path observed it first.
      const receiptId = settlementReceiptId(orderId, settled.transactionId);
      if (notified.current === receiptId) return;
      notified.current = receiptId;
      callback.current?.(
        {
          status: 'paid',
          source: 'counter',
          receiptId,
          paymentAttemptId: receiptId,
          orderId,
          transactionId: settled.transactionId,
          cashAmount: settled.cashAmount,
          onlineAmount: settled.onlineAmount,
        },
        origin,
      );
    },
    [orderId],
  );
  const reload = useCallback(async () => {
    const value = await readPaymentContext(storeId, orderId, ownerId);
    if (value.orderId !== orderId || value.storeId !== storeId)
      throw new Error('The payment response belongs to another order.');
    setContext(value);
    if (value.paid && value.settlement) confirm(value.settlement, 'read');
    return value;
  }, [storeId, orderId, ownerId, confirm]);

  useEffect(() => {
    if (!online) return;
    let active = true;
    let saved: PaymentRecovery | null = null;
    try {
      saved = readPaymentRecovery(storageKey);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Payment recovery is unavailable.');
    }
    setRecovery(saved);
    void (async () => {
      try {
        const [value, modes] = await Promise.all([
          readPaymentContext(storeId, orderId, ownerId),
          readPaymentOptions(storeId, orderId, ownerId),
        ]);
        if (!active) return;
        if (value.orderId !== orderId || value.storeId !== storeId)
          throw new Error('The payment response belongs to another order.');
        setContext(value);
        setOptions(modes);
        const initial = initialPaymentForm(value.payable);
        setForm(initial);
        setMessage(paymentMessage(initial));
        if (value.paid && value.settlement) confirm(value.settlement, 'read');
        if (saved?.intent && !value.paid && !value.activeTransaction) {
          // A request whose response was lost: read its recorded outcome, never resend it.
          try {
            const result = await readPaymentAttempt(storeId, orderId, ownerId, saved.attemptId);
            if (active) setNotice(result.message);
            clearPaymentRecovery(storageKey);
            if (active) setRecovery(null);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
        } else if (saved && (value.paid || value.activeTransaction)) {
          clearPaymentRecovery(storageKey);
          setRecovery(null);
        }
      } catch (error) {
        if (active)
          setProblem(error instanceof Error ? error.message : 'Payment status is unavailable.');
      }
    })();
    return () => {
      active = false;
    };
  }, [storeId, orderId, ownerId, storageKey, online, confirm]);

  const act = async (task: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Failed');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const option = options?.options.find((item) => item.value === selection) ?? null;
  const onlineValue = form ? Number(form.online) : 0;
  function update(next: PaymentFormValues) {
    setForm(next);
    setMessage(paymentMessage(next));
  }
  function request(): RecordedPaymentInput {
    if (!form || !context) throw new Error('Failed');
    const cashAmount = money(form.cash),
      onlineAmount = money(form.online),
      useOnline = onlineValue > 0 && option !== null;
    return {
      operationId: crypto.randomUUID(),
      channel: useOnline ? option.channel : 'cash',
      ...(useOnline && option.channel === 'pine' ? { paymentMode: option.paymentMode } : {}),
      cashAmount,
      onlineAmount,
      cashReceived: money(form.received),
      ...(useOnline && option.machineId ? { machineId: option.machineId } : {}),
      ...(useOnline && option.paymentMode === 1005 && district.trim()
        ? { externalReference: district.trim() }
        : {}),
      ...(useOnline && option.paymentMode === 1006 && creditPincode.trim()
        ? { externalReference: creditPincode.trim() }
        : {}),
      message: message.trim(),
    };
  }
  async function submit(body: RecordedPaymentInput) {
    setRecovery(savePaymentRecovery(storageKey, { version: 2, kind: 'payment', input: body }));
    let result: PaymentResult;
    try {
      result = await startPayment(storeId, orderId, ownerId, body);
    } catch (error) {
      // A response (accepted, rejected or uncertain) settles the request; only a lost
      // response keeps the saved request for recovery.
      if (error instanceof ApiError) {
        clearPaymentRecovery(storageKey);
        setRecovery(null);
        if (error.status === 502) await reload().catch(() => undefined);
      }
      throw error;
    }
    clearPaymentRecovery(storageKey);
    setRecovery(null);
    setNotice(result.message);
    setPhase('form');
    if (result.status === 'paid') confirm(result, 'action');
    await reload();
  }
  function validateAndConfirm() {
    if (!form || !context) return;
    const failure = paymentFormProblem({
      form,
      payable: context.payable,
      transactionId: context.transactionId,
      message,
      mode: onlineValue > 0 && option ? option.paymentMode : null,
      districtTransactionId: district,
      creditPincodeId: creditPincode,
    });
    if (failure) {
      setProblem(failure);
      return;
    }
    setProblem('');
    setPhase('confirm');
  }

  const showForm =
    context &&
    !context.paid &&
    !context.activeTransaction &&
    context.canRecordPayment &&
    allowNewPayments &&
    form &&
    options;
  return (
    <section aria-labelledby="payment-title">
      <h3 id="payment-title">Proceed with the payment.</h3>
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!online && <p>Reconnect to confirm payment. Products remain pending delivery.</p>}
      {online && !context && !problem && <p role="status">Loading the payment state…</p>}
      {context?.paid ? (
        <p role="status">
          Payment has been Completed for order ID : {orderId}
          {context.settlement ? ` · ${context.settlement.transactionId}` : ''}
        </p>
      ) : context?.activeTransaction ? (
        <TerminalStatus
          key={context.activeTransaction.transactionId}
          ownerId={ownerId}
          storeId={storeId}
          orderId={orderId}
          online={online}
          transaction={context.activeTransaction}
          onSettled={(result, text) => {
            setNotice(text);
            if (result?.status === 'paid') confirm(result, 'action');
            void reload().catch((error) =>
              setProblem(error instanceof Error ? error.message : 'Payment status is unavailable.'),
            );
          }}
        />
      ) : recovery?.intent ? (
        <>
          <p role="status">
            The last payment request did not get a reply. Check its status before sending another
            payment.
          </p>
          <button
            type="button"
            className="button primary full"
            disabled={busy || !online}
            onClick={() =>
              void act(async () => {
                try {
                  const result = await readPaymentAttempt(
                    storeId,
                    orderId,
                    ownerId,
                    recovery.attemptId,
                  );
                  setNotice(result.message);
                  clearPaymentRecovery(storageKey);
                  setRecovery(null);
                  if (result.status === 'paid') confirm(result, 'action');
                  await reload();
                } catch (error) {
                  if (error instanceof ApiError && error.status === 404)
                    await submit(recovery.intent!.input);
                  else throw error;
                }
              })
            }
          >
            {busy ? 'Checking…' : 'Check payment status'}
          </button>
          <button
            type="button"
            className="button secondary full"
            disabled={busy}
            onClick={() => {
              clearPaymentRecovery(storageKey);
              setRecovery(null);
            }}
          >
            Discard the saved request
          </button>
        </>
      ) : showForm ? (
        <form
          id="paymentform"
          onSubmit={(event) => {
            event.preventDefault();
            validateAndConfirm();
          }}
        >
          <label>
            Transaction ID:
            <input value={context.transactionId} disabled readOnly />
          </label>
          <div className="grand-total">
            <span>Amount due</span>
            <strong>{currency(context.payable)}</strong>
          </div>
          <label>
            Cash To Be Accepted:
            <input
              type="number"
              min="0"
              max={context.payable}
              step="0.01"
              value={form.cash}
              disabled={busy}
              onChange={(event) => update({ ...form, cash: event.target.value })}
              onBlur={(event) => update(changeCash(form, event.target.value, context.payable))}
            />
          </label>
          <label>
            Cash Recieved:
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.received}
              disabled={busy}
              onChange={(event) => update({ ...form, received: event.target.value })}
              onBlur={(event) => update(changeReceived(form, event.target.value))}
            />
          </label>
          <div>
            <span>Cash To Be Return:</span> <strong className="change_return">{form.change}</strong>
          </div>
          <label>
            Card/UPI:
            <input
              type="number"
              min="0"
              max={context.payable}
              step="0.01"
              value={form.online}
              disabled={busy || !options.options.length}
              onChange={(event) => update({ ...form, online: event.target.value })}
              onBlur={(event) => update(changeOnline(form, event.target.value, context.payable))}
            />
          </label>
          <label>
            Payment Mode:{' '}
            {!options.options.length && (
              <small className="inline-error"> No payment option available</small>
            )}
            <select
              value={selection}
              disabled={busy || !(onlineValue > 0)}
              onChange={(event) => setSelection(event.target.value)}
            >
              <option value="">Select Payment Mode</option>
              {options.options.map((item) => (
                <option key={item.value + item.label} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {onlineValue > 0 && option?.paymentMode === 1005 && (
            <label>
              District Transaction ID:
              <input
                value={district}
                maxLength={100}
                disabled={busy}
                onChange={(event) => setDistrict(event.target.value)}
              />
            </label>
          )}
          {onlineValue > 0 && option?.paymentMode === 1006 && (
            <label>
              Credit-Pincode Transaction ID:
              <input
                value={creditPincode}
                maxLength={100}
                disabled={busy}
                onChange={(event) => setCreditPincode(event.target.value)}
              />
            </label>
          )}
          <label>
            Message:
            <textarea
              rows={4}
              maxLength={255}
              placeholder="Enter Message"
              value={message}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          {phase === 'confirm' ? (
            <div role="alertdialog" aria-label="Confirmation !">
              <p>Are you sure ?</p>
              <button
                type="button"
                className="button primary"
                disabled={busy || !online}
                onClick={() =>
                  void act(async () => {
                    setPhase('form');
                    await submit(request());
                  })
                }
              >
                {busy ? 'Confirming…' : 'Yes, sure!'}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setPhase('form')}
              >
                cancel
              </button>
            </div>
          ) : (
            <button className="button primary full" disabled={busy || !online}>
              Submit
            </button>
          )}
        </form>
      ) : (
        context &&
        context.blocker && (
          <p role="status">
            This order needs review before another payment can be taken. Reference:{' '}
            {context.blocker}
          </p>
        )
      )}
    </section>
  );
}
