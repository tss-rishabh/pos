import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { setRequestOperator } from '../../src/api/client';
import { PaymentReversalPanel } from '../../src/pages/payment-reversals';
import { PaymentPanel } from '../../src/pages/checkout/PaymentPanel';
import { paymentStorageKey, savePaymentReference } from '../../src/pages/checkout/payment-recovery';

function Harness() {
  const [ownerId, setOwner] = useState('44'),
    [storeId, setStore] = useState('1'),
    [online, setOnline] = useState(true),
    [saved, setSaved] = useState(0),
    [fail, setFail] = useState(false),
    [paid, setPaid] = useState('');
  setRequestOperator(ownerId);
  const payment = new URLSearchParams(location.search).has('payment');
  return (
    <>
      <button
        onClick={() => {
          setRequestOperator('45');
          setOwner('45');
        }}
      >
        Switch operator
      </button>
      <button onClick={() => setStore('2')}>Switch store</button>
      <button onClick={() => setOnline((value) => !value)}>Toggle network</button>
      <label>
        <input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} />
        Fail detail refresh
      </label>
      <output aria-label="Detail refresh count">{saved}</output>
      <output aria-label="Paid callback">{paid}</output>
      {payment ? (
        <PaymentPanel
          ownerId={ownerId}
          draftId="existing-91"
          storeId={storeId}
          orderId="91"
          online={online}
          onConfirmed={(receipt) =>
            setPaid(receipt.source === 'counter' ? receipt.paymentAttemptId : '')
          }
        />
      ) : (
        <PaymentReversalPanel
          user={{ id: ownerId }}
          storeId={storeId}
          orderId="91"
          online={online}
          onCorrected={async () => {
            setSaved((value) => value + 1);
            if (fail) throw new Error('Fixture refresh failed');
          }}
        />
      )}
    </>
  );
}
if (new URLSearchParams(location.search).has('payment'))
  savePaymentReference(
    paymentStorageKey('44', 'existing-91', '91'),
    '11111111-1111-4111-8111-111111111111',
  );
createRoot(document.getElementById('root')!).render(<Harness />);
