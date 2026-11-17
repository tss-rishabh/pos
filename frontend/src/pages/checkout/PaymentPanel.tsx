import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, post, request } from '../../api/client';
import { currency } from '../../lib/format';
import type { ConfirmedPayment } from './receipts';
import {
  paymentStorageKey,
  readPaymentRecovery,
  savePaymentRecovery,
  savePaymentReference,
  type PaymentRecovery,
} from './payment-recovery';
export type { ConfirmedPayment } from './receipts';

const channelSchema = z.enum([
  'cash',
  'other',
  'district',
  'pincode',
  'pine-card',
  'pine-upi',
  'paytm-card',
  'paytm-qr',
]);
const optionsSchema = z.object({
  payable: z.string(),
  options: z.array(
    z.object({ channel: channelSchema, label: z.string(), machineId: z.string().nullable() }),
  ),
});
export const paymentSchema = z
  .object({
    id: z.uuid(),
    orderId: z.string(),
    transactionId: z.string(),
    channel: channelSchema,
    cashAmount: z.string(),
    onlineAmount: z.string(),
    status: z.enum([
      'dispatching',
      'pending',
      'uncertain',
      'cancelling',
      'paid',
      'failed',
      'cancelled',
      'reversed',
    ]),
    errorCode: z.string().nullable(),
  })
  .passthrough();
type Payment = z.infer<typeof paymentSchema>;
interface PaymentPanelProps {
  ownerId: string;
  draftId: string;
  storeId: string;
  orderId: string;
  online: boolean;
  onConfirmed?: (receipt: ConfirmedPayment, origin: 'read' | 'action') => void;
  allowNewPayments?: boolean;
}
const cents = (value: string) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error('Enter a non-negative amount with up to two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
};
const decimal = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
export function PaymentPanel({
  ownerId,
  draftId,
  storeId,
  orderId,
  online,
  onConfirmed,
  allowNewPayments = true,
}: PaymentPanelProps) {
  const [options, setOptions] = useState<z.infer<typeof optionsSchema> | null>(null),
    [selection, setSelection] = useState('0'),
    [cash, setCash] = useState('0.00'),
    [received, setReceived] = useState('0.00'),
    [reference, setReference] = useState(''),
    [payment, setPayment] = useState<Payment | null>(null),
    [pendingId, setPendingId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [missing, setMissing] = useState(false),
    [recovery, setRecovery] = useState<PaymentRecovery | null>(null),
    [problem, setProblem] = useState('');
  const lock = useRef(false),
    notified = useRef<string | null>(null),
    callback = useRef(onConfirmed);
  callback.current = onConfirmed;
  const base = `/api/v1/stores/${encodeURIComponent(storeId)}/orders/${encodeURIComponent(orderId)}`,
    storageKey = paymentStorageKey(ownerId, draftId, orderId);
  const adopt = (value: Payment, origin: 'read' | 'action' = 'read') => {
    if (value.orderId !== orderId)
      throw new Error(
        'This payment belongs to a different order. Review the saved payment reference before continuing.',
      );
    setPayment(value);
    if (value.status === 'paid' && notified.current !== value.id) {
      notified.current = value.id;
      callback.current?.(
        {
          status: 'paid',
          source: 'counter',
          receiptId: value.id,
          orderId: value.orderId,
          paymentAttemptId: value.id,
          transactionId: value.transactionId,
          cashAmount: value.cashAmount,
          onlineAmount: value.onlineAmount,
        },
        origin,
      );
    }
  };
  useEffect(() => {
    let active = true;
    if (!online) return;
    setLoading(true);
    setMissing(false);
    let previous: PaymentRecovery | null;
    try {
      previous = readPaymentRecovery(storageKey);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Payment recovery is unavailable.');
      return;
    }
    setRecovery(previous);
    void request(base + '/payment-options', { operatorId: ownerId }, optionsSchema)
      .then((value) => {
        if (active) {
          setOptions(value);
          setCash(value.payable);
          setReceived(value.payable);
        }
      })
      .catch((error) => {
        if (active)
          setProblem(error instanceof Error ? error.message : 'Could not load payment methods.');
      });
    if (previous) {
      setPendingId(previous.attemptId);
      void request(
        base + '/payment-attempts/' + previous.attemptId,
        { operatorId: ownerId },
        paymentSchema,
      )
        .then((value) => {
          if (active) {
            adopt(value);
            setLoading(false);
          }
        })
        .catch((error) => {
          if (active) {
            if (
              error instanceof ApiError &&
              error.status === 404 &&
              error.code === 'PAYMENT_ATTEMPT_NOT_FOUND'
            ) {
              setMissing(true);
              setLoading(false);
            }
            setProblem(error instanceof Error ? error.message : 'Payment status is unavailable.');
          }
        });
    } else {
      void request(
        base + '/payment-attempts',
        { operatorId: ownerId },
        z.object({ data: z.array(paymentSchema) }),
      )
        .then((value) => {
          const existing = value.data.find(
            (attempt) => !['failed', 'cancelled', 'reversed'].includes(attempt.status),
          );
          if (active && existing) {
            savePaymentReference(storageKey, existing.id);
            setPendingId(existing.id);
            adopt(existing);
          }
          if (active) setLoading(false);
        })
        .catch((error) => {
          if (active)
            setProblem(error instanceof Error ? error.message : 'Payment status is unavailable.');
        });
    }
    return () => {
      active = false;
    };
  }, [base, storageKey, online]);
  const act = async (task: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task();
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'Payment outcome is unconfirmed. Check its status before continuing.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const method = options?.options[Number(selection)],
    terminal = method?.channel.startsWith('pine-') || method?.channel.startsWith('paytm-');
  async function start() {
    if (!options || !method || !allowNewPayments || loading) return;
    const payable = cents(options.payable),
      cashPortion = method.channel === 'cash' ? payable : cents(cash);
    if (cashPortion > payable) throw new Error('Cash portion cannot exceed the order payable.');
    if (cents(received) < cashPortion)
      throw new Error('Cash received must cover the cash portion.');
    const id = crypto.randomUUID();
    const body = {
      operationId: id,
      channel: method.channel,
      cashAmount: decimal(cashPortion),
      onlineAmount: decimal(payable - cashPortion),
      cashReceived: received,
      ...(method.machineId ? { machineId: method.machineId } : {}),
      ...(['district', 'pincode'].includes(method.channel) ? { externalReference: reference } : {}),
    };
    setRecovery(savePaymentRecovery(storageKey, { version: 1, kind: 'payment', input: body }));
    setPendingId(id);
    try {
      const result = await post(base + '/payment-attempts', body, paymentSchema, ownerId);
      adopt(result, 'action');
    } catch (error) {
      if (
        error instanceof ApiError &&
        ([400, 401, 403, 404, 422].includes(error.status) ||
          error.code === 'PAYMENT_PROVIDER_UNAVAILABLE')
      ) {
        localStorage.removeItem(storageKey);
        setPendingId(null);
      }
      throw error;
    }
  }
  async function check() {
    if (pendingId) {
      if (!payment) {
        try {
          adopt(
            await request(
              base + '/payment-attempts/' + pendingId,
              { operatorId: ownerId },
              paymentSchema,
            ),
          );
          setMissing(false);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status === 404 &&
            error.code === 'PAYMENT_ATTEMPT_NOT_FOUND'
          )
            setMissing(true);
          throw error;
        }
      } else
        adopt(
          await post(
            base + '/payment-attempts/' + pendingId + '/reconciliations',
            {},
            paymentSchema,
            ownerId,
          ),
          'action',
        );
    }
  }
  return (
    <section aria-labelledby="payment-title">
      <h3 id="payment-title">Payment</h3>
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {!online && <p>Reconnect to confirm payment. Products remain pending delivery.</p>}
      {loading && online && <p role="status">Loading the original payment state…</p>}
      {payment?.status === 'paid' ? (
        <p role="status">
          Payment confirmed · {payment.transactionId}. This order is ready for handover.
        </p>
      ) : pendingId ? (
        <>
          <p role="status">
            {payment?.status === 'pending'
              ? 'Awaiting payment on the terminal.'
              : payment?.status === 'cancelled'
                ? 'The provider confirmed cancellation.'
                : payment?.status === 'failed'
                  ? 'The provider confirmed payment failed.'
                  : payment?.status === 'reversed'
                    ? 'This recorded cash payment was corrected. Its original audit receipt is retained.'
                    : 'The payment outcome needs confirmation.'}
          </p>
          <small>Payment reference: {pendingId}</small>
          {missing && recovery?.intent && (
            <button
              className="button secondary full"
              disabled={busy || !online}
              onClick={() =>
                void act(async () => {
                  const intent = recovery.intent!;
                  const value = await post(
                    base +
                      (intent.kind === 'legacy'
                        ? '/legacy-payment-recoveries'
                        : '/payment-attempts'),
                    intent.input,
                    paymentSchema,
                    ownerId,
                  );
                  setMissing(false);
                  adopt(value);
                })
              }
            >
              Retry original payment request
            </button>
          )}
          {['failed', 'cancelled', 'reversed'].includes(payment?.status || '') ? (
            <button
              className="button secondary full"
              disabled={busy || !online}
              onClick={() => {
                localStorage.removeItem(storageKey);
                setPendingId(null);
                setPayment(null);
                setRecovery(null);
                setMissing(false);
                setProblem('');
              }}
            >
              Choose another payment
            </button>
          ) : (
            <>
              <button
                className="button primary full"
                disabled={busy || !online}
                onClick={() => void act(check)}
              >
                {busy ? 'Checking…' : 'Check payment status'}
              </button>
              {payment?.channel.startsWith('pine-') && (
                <button
                  className="button secondary full"
                  disabled={busy || !online}
                  onClick={() =>
                    void act(async () => {
                      adopt(
                        await post(
                          base + '/payment-attempts/' + pendingId + '/cancellations',
                          {},
                          paymentSchema,
                          ownerId,
                        ),
                      );
                    })
                  }
                >
                  Cancel terminal payment
                </button>
              )}
              {payment?.channel.startsWith('paytm-') && (
                <p>
                  Use the payment terminal to check any cancellation, then reconcile this payment
                  before taking another payment.
                </p>
              )}
            </>
          )}
        </>
      ) : (
        options &&
        !loading &&
        allowNewPayments && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(start);
            }}
          >
            <div className="grand-total">
              <span>Amount due</span>
              <strong>{currency(options.payable)}</strong>
            </div>
            <label>
              Payment method
              <select
                value={selection}
                onChange={(event) => {
                  setSelection(event.target.value);
                  setCash(event.target.value === '0' ? options.payable : '0.00');
                  setReceived(event.target.value === '0' ? options.payable : '0.00');
                }}
                disabled={busy}
              >
                {options.options.map((option, index) => (
                  <option
                    key={`${option.channel}:${option.machineId || ''}:${index}`}
                    value={String(index)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {method?.channel !== 'cash' && (
              <label>
                Cash portion
                <input
                  value={cash}
                  onChange={(event) => setCash(event.target.value)}
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]{1,2})?"
                  required
                  disabled={busy}
                />
              </label>
            )}
            <label>
              Cash received
              <input
                value={received}
                onChange={(event) => setReceived(event.target.value)}
                inputMode="decimal"
                pattern="[0-9]+(\.[0-9]{1,2})?"
                required
                disabled={busy}
              />
            </label>
            {method && ['district', 'pincode'].includes(method.channel) && (
              <label>
                External transaction reference
                <input
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  maxLength={100}
                  pattern="[A-Za-z0-9][A-Za-z0-9._/-]*"
                  required
                  disabled={busy}
                />
              </label>
            )}
            <button className="button primary full" disabled={busy || !online || !method}>
              {busy
                ? 'Confirming…'
                : terminal
                  ? 'Send payment to terminal'
                  : 'Record received payment'}
            </button>
          </form>
        )
      )}
    </section>
  );
}
