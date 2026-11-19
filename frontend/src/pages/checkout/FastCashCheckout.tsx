import { useState } from 'react';
import {
  authoritativeTotal,
  readDiscountApproval,
  type Checkout,
  type CheckoutReply,
} from './client';
import { startPayment } from './payments/client';
import type { ConfirmedPayment } from './receipts';
import './payments/payment-form.css';

/**
 * Legacy fast checkout (`order/urls.py:54` `ajax-fast-checkout`, `AjaxFastCheckoutView`
 * `order/views.py:3160-3364`, dialog `create_order.html:7242-7790`), rebuilt on the normal online
 * flow: validate + process (the final quote), `pos/order` with its confirmation (order
 * submission), then the cash completion (`Helpers.complete_order` with cash = payable, card 0).
 * A zero payable is a prepaid order and goes straight to order submission (`PayProceedButtonFast`).
 */
const paise = (value: string): bigint | null => {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
};
const money = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

export function FastCashCheckout({
  checkout,
  ownerId,
  available = true,
  disabled,
  mutate,
  act,
  onNotice,
  onOrderCreated,
  onPaid,
}: {
  checkout: Checkout;
  ownerId: string;
  /** The sale is open for review; the trigger shows only then, an open dialog stays. */
  available?: boolean;
  disabled: boolean;
  mutate: (
    path: string,
    method: 'POST' | 'PUT',
    body?: Record<string, unknown>,
  ) => Promise<CheckoutReply>;
  act: (task: () => Promise<void>) => Promise<void>;
  onNotice: (message: string) => void;
  onOrderCreated?: (orderId: string) => void;
  onPaid: (receipt: ConfirmedPayment) => Promise<void> | void;
}) {
  const [dialog, setDialog] = useState<{ payable: string } | null>(null),
    [received, setReceived] = useState(''),
    [message, setMessage] = useState(''),
    [problem, setProblem] = useState(''),
    [submitting, setSubmitting] = useState(false);
  const hasLines =
    (checkout.cart?.products.items.length ?? 0) > 0 ||
    (checkout.cart?.giftvouchers?.items.length ?? 0) > 0;
  const payableCents = dialog ? (paise(dialog.payable) ?? 0n) : 0n,
    receivedCents = paise(received) ?? 0n,
    change = receivedCents > payableCents ? receivedCents - payableCents : 0n;

  async function open() {
    let state = checkout;
    if (state.phase !== 'quoted') {
      const quoted = await mutate('quotes', 'POST');
      if (!quoted.state) throw new Error('The final quote could not be confirmed.');
      state = quoted.state;
    }
    const approval = await readDiscountApproval(state);
    if (!['not-required', 'approved'].includes(approval.status))
      throw new Error('Approve the store discount with the manager OTP before fast cash.');
    const payable = authoritativeTotal(state);
    if (payable === null) throw new Error('The final quote could not be confirmed.');
    if ((paise(payable) ?? 0n) <= 0n) {
      onNotice('Look like prepaid order. Sit back, we are processing the order');
      const created = await mutate('order-submissions', 'POST');
      if (created.state?.orderId) onOrderCreated?.(created.state.orderId);
      return;
    }
    setReceived(payable);
    setMessage('');
    setProblem('');
    setDialog({ payable });
  }

  async function submit() {
    if (!dialog) return;
    if (!message.trim()) {
      setProblem('Provide a valid message');
      return;
    }
    // Legacy raises Cash Recieved to the payable when it is lower (`complete_transaction`
    // uses the payable when nothing was received).
    const cashReceived = receivedCents < payableCents ? payableCents : receivedCents;
    const created = await mutate('order-submissions', 'POST');
    const orderId = created.state?.orderId;
    if (!orderId) throw new Error('Order Creation Failed, Please Retry');
    onOrderCreated?.(orderId);
    const result = await startPayment(checkout.storeId, orderId, ownerId, {
      operationId: crypto.randomUUID(),
      channel: 'cash',
      cashAmount: money(payableCents),
      onlineAmount: '0.00',
      cashReceived: money(cashReceived),
      message: message.trim(),
    });
    setDialog(null);
    if (result.status !== 'paid' || !result.attemptId)
      throw new Error(result.message || 'Something went wrong');
    onNotice('Cash Delivered');
    await onPaid({
      status: 'paid',
      source: 'counter',
      orderId,
      receiptId: result.attemptId,
      paymentAttemptId: result.attemptId,
      transactionId: result.transactionId,
      cashAmount: result.cashAmount,
      onlineAmount: result.onlineAmount,
    });
  }

  return (
    <>
      {(available || dialog !== null) && (
        <button
          type="button"
          className="button secondary"
          disabled={disabled || !hasLines || dialog !== null}
          onClick={() => void act(open)}
        >
          Fast Cash
        </button>
      )}
      {dialog && (
        <div
          className="fast-cash-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fast-cash-title"
        >
          <h3 id="fast-cash-title">
            Fast Checkout (Cash Only)! Cash To Be Accepted : {dialog.payable}
          </h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                setSubmitting(true);
                try {
                  await submit();
                } finally {
                  setSubmitting(false);
                }
              });
            }}
          >
            <div className="form-grid">
              <label>
                Cash Received
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={received}
                  onChange={(event) => setReceived(event.target.value)}
                  placeholder="Collected Cash"
                />
              </label>
              <p className="checkout-change">
                <span>Cash To Be Return</span> <strong>{money(change)}</strong>
              </p>
            </div>
            <label className="checkout-message">
              Order Message
              <textarea
                rows={3}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Enter the message for the order"
                maxLength={255}
                required
                autoFocus
              />
            </label>
            {problem && (
              <p role="alert" className="inline-error">
                {problem}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                disabled={disabled}
                onClick={() => setDialog(null)}
              >
                cancel
              </button>
              <button className="button primary" disabled={disabled} aria-busy={submitting}>
                Submit
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
