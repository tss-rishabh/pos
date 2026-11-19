import { useEffect, useRef } from 'react';
import { ErrorState } from '../../../components/common';

/** Legacy `$.confirm` dialogs (gift_card/index.html:160-235): "Block", "Activate", "Mark As Printed". */
export type BatchConfirmation = { batchId: string; action: 'print' | 'block' | 'active' };
export function BatchConfirmationDialog({
  command,
  busy,
  online,
  error,
  onClose,
  onConfirm,
}: {
  command: BatchConfirmation;
  busy: boolean;
  online: boolean;
  error: unknown;
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
      ? 'Mark As Printed'
      : command.action === 'block'
        ? 'Block'
        : 'Activate';
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
      <p>Collection {command.batchId}</p>
      {error !== undefined && <ErrorState error={error} />}
      <div className="administration-actions">
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={!online || busy} onClick={onConfirm}>
          {busy ? 'Working…' : 'Confirm'}
        </button>
      </div>
    </dialog>
  );
}
