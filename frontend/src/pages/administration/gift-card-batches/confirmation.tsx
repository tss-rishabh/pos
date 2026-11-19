import { ErrorState } from '../../../components/common';
import { Modal } from '../../../components/modal';

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
  const title =
    command.action === 'print'
      ? 'Mark As Printed'
      : command.action === 'block'
        ? 'Block'
        : 'Activate';
  return (
    <Modal
      title={title}
      size="sm"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <button className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!online || busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : 'Confirm'}
          </button>
        </>
      }
    >
      <p>Collection {command.batchId}</p>
      {error !== undefined && <ErrorState error={error} />}
    </Modal>
  );
}
