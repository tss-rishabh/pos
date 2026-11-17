import { useState } from 'react';
import { correctionIntent, type CorrectionReceipt } from './client';
import { returnJournal } from './intents-client';
import { CashReturnIntentPanel } from './intent-panel';
import { CashReturnPendingQueue } from './pending';
import { hasRetainedClaim, retainedOriginal, RetainedCashReturnPanel } from './retained-panel';
export { CashReturnPendingQueue } from './pending';
interface Props {
  user: { id: string };
  storeId: string;
  orderId: string;
  online: boolean;
  deferUntilOpened?: boolean;
  showPendingQueue?: boolean;
  onCorrected?: (receipt: CorrectionReceipt) => Promise<void>;
}
export function PaymentReversalPanel(props: Props) {
  return (
    <PaymentReversalEntry key={`${props.user.id}:${props.storeId}:${props.orderId}`} {...props} />
  );
}
function PaymentReversalEntry(props: Props) {
  const scope = { ownerId: props.user.id, storeId: props.storeId, orderId: props.orderId };
  const [original] = useState(() => {
    try {
      return correctionIntent(scope) ?? retainedOriginal(scope);
    } catch {
      return undefined;
    }
  });
  const [open, setOpen] = useState(() => {
    if (!props.deferUntilOpened) return true;
    try {
      return Boolean(correctionIntent(scope) || returnJournal(scope) || hasRetainedClaim(scope));
    } catch {
      return true;
    }
  });
  function content() {
    try {
      if (original === undefined) throw new Error('Original recovery storage unavailable.');
      return (
        <>
          {original ? (
            <RetainedCashReturnPanel {...props} original={original} />
          ) : (
            <CashReturnIntentPanel {...props} />
          )}
          {props.showPendingQueue !== false && (
            <CashReturnPendingQueue
              user={props.user}
              storeId={props.storeId}
              online={props.online}
            />
          )}
        </>
      );
    } catch {
      return (
        <>
          <p role="alert">
            Original cash-return recovery storage is unreadable. Preserve the original reference and
            ask a store manager to review the server cash-return queue. Do not return cash again.
          </p>
          {props.showPendingQueue !== false && (
            <CashReturnPendingQueue
              user={props.user}
              storeId={props.storeId}
              online={props.online}
            />
          )}
        </>
      );
    }
  }
  if (!props.deferUntilOpened) return content();
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Correct recorded cash payment</summary>
      {open && content()}
    </details>
  );
}
