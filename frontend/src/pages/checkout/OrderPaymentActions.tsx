import { useState } from 'react';
import { useOnline } from '../../hooks/use-pos';
import type { ConfirmedPayment } from './receipts';
import { PaymentPanel } from './PaymentPanel';
export { paymentContextSchema as orderPaymentContextSchema } from './payments/client';

interface OrderPaymentActionsProps {
  ownerId: string;
  storeId: string;
  orderId: string;
  onPaid: (receipt: ConfirmedPayment, origin: 'read' | 'action') => void;
}
/**
 * Existing-order payment (legacy order show/index pages): the same payment form, the
 * uploaded-terminal status/cancel modal with Pine auto polling. The manager-only manual
 * payment status form is `PaymentReversalPanel` (pages/payment-reversals).
 */
export function OrderPaymentActions({
  ownerId,
  storeId,
  orderId,
  onPaid,
}: OrderPaymentActionsProps) {
  const online = useOnline(),
    [revision, setRevision] = useState(0);
  return (
    <section aria-label="Order payment actions">
      {!online && <p>Reconnect to review or record an existing order payment.</p>}
      {online && (
        <button
          type="button"
          className="button secondary"
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh payment state
        </button>
      )}
      <PaymentPanel
        key={revision}
        ownerId={ownerId}
        draftId="order-details"
        storeId={storeId}
        orderId={orderId}
        online={online}
        onConfirmed={onPaid}
      />
    </section>
  );
}
