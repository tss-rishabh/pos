import { useRef, useState } from 'react';
import { RequestReference, useProblem } from '../../components/common';
import { updatePaymentStatus, type CorrectionReceipt, type PaymentStatusInput } from './client';

export type { CorrectionReceipt } from './client';
interface Props {
  user: { id: string };
  storeId: string;
  orderId: string;
  online: boolean;
  deferUntilOpened?: boolean;
  /** Refresh order/payment/invoice detail only. This is never a cart completion. */
  onCorrected?: (receipt: CorrectionReceipt) => Promise<void>;
}
/**
 * Manager form for the legacy manual payment status endpoint (`ajax-payment-status/`,
 * order/views.py:685-775): mark an order paid at the counter, or revert it to PLACED.
 */
export function PaymentReversalPanel(props: Props) {
  const [open, setOpen] = useState(!props.deferUntilOpened);
  if (!props.deferUntilOpened) return <PaymentStatusForm {...props} />;
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Payment status</summary>
      {open && <PaymentStatusForm {...props} />}
    </details>
  );
}
function PaymentStatusForm({ user, storeId, orderId, online, onCorrected }: Props) {
  const [payType, setPayType] = useState<0 | 1>(0),
    [transactionId, setTransactionId] = useState(''),
    [cash, setCash] = useState('0'),
    [card, setCard] = useState('0'),
    [message, setMessage] = useState(''),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [problem, setProblem, problemCause, reportProblem] = useProblem();
  const lock = useRef(false);
  function validate(): string | null {
    if (!payType) return null;
    if (!/^\d+(?:\.\d{1,2})?$/.test(cash.trim())) return 'Enter Valid Value in Cash';
    if (!/^\d+(?:\.\d{1,2})?$/.test(card.trim())) return 'Enter Valid Value in UPI/Card';
    if (!transactionId.trim()) return 'Provide a valid Transaction ID';
    if (!message.trim()) return 'Provide a valid Message';
    return null;
  }
  async function submit() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      const input: PaymentStatusInput = payType
        ? {
            payType: 1,
            transactionId: transactionId.trim(),
            paymentStatus: 4,
            orderStatus: 3,
            message: message.trim(),
            offlinePayment: cash.trim(),
            onlinePayment: card.trim(),
          }
        : {
            payType: 0,
            paymentStatus: 1,
            orderStatus: 0,
            message: '',
            offlinePayment: '0',
            onlinePayment: '0',
          };
      const receipt = await updatePaymentStatus({ ownerId: user.id, storeId, orderId }, input);
      setNotice(receipt.message);
      setConfirming(false);
      await onCorrected?.(receipt);
    } catch (error) {
      reportProblem(error, 'Failed');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-label="Payment status">
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {problem && <RequestReference error={problemCause} />}
      {notice && <p role="status">{notice}</p>}
      <label>
        Action
        <select
          value={payType}
          disabled={busy}
          onChange={(event) => {
            setPayType(event.target.value === '1' ? 1 : 0);
            setConfirming(false);
          }}
        >
          <option value={0}>Revert payment to PLACED</option>
          <option value={1}>Mark paid at counter</option>
        </select>
      </label>
      {payType ? (
        <>
          <label>
            Transaction ID:
            <input
              value={transactionId}
              maxLength={255}
              disabled={busy}
              onChange={(event) => setTransactionId(event.target.value)}
            />
          </label>
          <label>
            Cash:
            <input
              inputMode="decimal"
              value={cash}
              disabled={busy}
              onChange={(event) => setCash(event.target.value)}
            />
          </label>
          <label>
            Card/UPI:
            <input
              inputMode="decimal"
              value={card}
              disabled={busy}
              onChange={(event) => setCard(event.target.value)}
            />
          </label>
          <label>
            Message:
            <textarea
              rows={3}
              maxLength={255}
              placeholder="Enter Message"
              value={message}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
        </>
      ) : (
        <p>
          <b>Do you want to revert the payment ? </b>
          <br />
          Click proceed or cancel.
        </p>
      )}
      {confirming ? (
        <div role="alertdialog" aria-label="Confirmation !">
          <p>Are you sure ?</p>
          <button
            type="button"
            className="button primary"
            disabled={busy || !online}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : 'Yes, sure!'}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button secondary"
          disabled={busy || !online}
          onClick={() => {
            const failure = validate();
            if (failure) setProblem(failure);
            else {
              setProblem('');
              setConfirming(true);
            }
          }}
        >
          {payType ? 'Submit' : 'Proceed'}
        </button>
      )}
    </section>
  );
}
