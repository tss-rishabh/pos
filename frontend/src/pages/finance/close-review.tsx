import { useEffect, useRef } from 'react';
import { decimal, type Entries } from './model';
import './close-review.css';

/** A private, in-memory snapshot: confirmation submits exactly the reviewed version and entries. */
export interface ReviewedClose {
  date: string;
  expectedVersion: number;
  revising: boolean;
  entries: Entries;
  cashSystem: string;
  onlineSystem: string;
  cashDifference: bigint;
  onlineDifference: bigint;
  tolerance: bigint;
}
export function CloseReview({
  reviewed,
  submitting,
  onCancel,
  onConfirm,
}: {
  reviewed: ReviewedClose;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const confirming = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      const anotherDialog = Array.from(
        document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'),
      ).some(
        (other) =>
          other !== element &&
          other.getClientRects().length > 0 &&
          getComputedStyle(other).visibility !== 'hidden',
      );
      if (anotherDialog) timer = setTimeout(show, 150);
      else if (!element.open) element.showModal();
    };
    show();
    return () => {
      clearTimeout(timer);
      element.close();
    };
  }, []);
  const result = (value: bigint) => {
    const magnitude = value < 0n ? -value : value;
    return magnitude <= reviewed.tolerance
      ? 'Tallied'
      : `${value > 0n ? 'Short' : 'Excess'} ₹${decimal(magnitude)}`;
  };
  return (
    <dialog
      ref={dialog}
      className="finance-close-review"
      aria-labelledby="close-review-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) onCancel();
      }}
    >
      <h2 id="close-review-title">
        {reviewed.revising ? 'Revise this close?' : 'File this close?'}
      </h2>
      <p>Business date {reviewed.date}. Review these figures before signing.</p>
      <table>
        <thead>
          <tr>
            <th>Collection</th>
            <th>System</th>
            <th>Actual</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Cash</th>
            <td>₹{reviewed.cashSystem}</td>
            <td>₹{reviewed.entries.cash_actual}</td>
            <td>{result(reviewed.cashDifference)}</td>
          </tr>
          <tr>
            <th>Total online</th>
            <td>₹{reviewed.onlineSystem}</td>
            <td>₹{reviewed.entries.card_actual}</td>
            <td>{result(reviewed.onlineDifference)}</td>
          </tr>
          <tr>
            <th>Banking</th>
            <td>—</td>
            <td>₹{reviewed.entries.banking_amount}</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>
      {reviewed.revising && (
        <p>
          This day is already closed. Filing again records a new version alongside the existing one;
          the original is kept.
        </p>
      )}
      <div className="finance-close-review-actions">
        <button
          type="button"
          className="button secondary"
          autoFocus
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={submitting}
          onClick={() => {
            if (confirming.current) return;
            confirming.current = true;
            onConfirm();
          }}
        >
          {submitting ? 'Recording…' : reviewed.revising ? 'Yes, revise' : 'File close'}
        </button>
      </div>
    </dialog>
  );
}
