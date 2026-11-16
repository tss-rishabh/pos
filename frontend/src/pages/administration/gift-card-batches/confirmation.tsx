import { useEffect, useRef } from 'react';
import { ErrorState } from '../../../components/common';

export type BatchConfirmation = {
  operationId: string;
  batchId: string;
  expectedVersion: string;
  action: 'print' | 'block' | 'unblock' | 'retry';
  requiresResend: boolean;
};
export function BatchConfirmationDialog({
  command,
  busy,
  online,
  resend,
  error,
  onResend,
  onClose,
  onConfirm,
}: {
  command: BatchConfirmation;
  busy: boolean;
  online: boolean;
  resend: boolean;
  error: unknown;
  onResend: (value: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const title =
    command.action === 'print'
      ? 'Mark this batch as printed?'
      : command.action === 'retry'
        ? 'Retry delivery of this batch?'
        : command.action === 'block'
          ? 'Block this batch?'
          : 'Unblock this batch?';
  return (
    <dialog
      ref={ref}
      className="administration-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>{title}</h2>
      <p>Batch {command.batchId}</p>
      {command.action === 'print' && (
        <p>This records that you printed or distributed the existing cards.</p>
      )}
      {command.requiresResend && (
        <label>
          <input
            type="checkbox"
            checked={resend}
            disabled={busy}
            onChange={(event) => onResend(event.target.checked)}
          />
          I checked the inbox and want to send the same encrypted file again.
        </label>
      )}
      {error !== undefined && <ErrorState error={error} />}
      <div className="administration-actions">
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={!online || busy || (command.requiresResend && !resend)}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : 'Confirm batch change'}
        </button>
      </div>
    </dialog>
  );
}
