import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setRequestOperator } from '../../src/api/client';
import { OrderCopyPanel, orderCopyRequiresOnlineReview } from '../../src/pages/order-copy';

setRequestOperator('44');
const checkoutId = '11111111-1111-4111-8111-111111111111';
function Harness() {
  const [pending, setPending] = useState(false),
    [saved, setSaved] = useState(0),
    [preflights, setPreflights] = useState(0),
    [marked, setMarked] = useState(false);
  const online = new URLSearchParams(location.search).get('offline') !== 'true';
  return (
    <main>
      <output data-testid="preflights">{preflights}</output>
      <output data-testid="pending">{String(pending)}</output>
      <output data-testid="saved">{saved}</output>
      <output data-testid="requires-online">{String(marked)}</output>
      <OrderCopyPanel
        scope={{ operatorId: '44', storeId: '1', checkoutId, customerId: '1001' }}
        checkoutVersion={2}
        online={online}
        beforeDispatch={async () => {
          setPreflights((value) => value + 1);
        }}
        onPending={setPending}
        onSaved={async () => {
          setSaved((value) => value + 1);
          setMarked(orderCopyRequiresOnlineReview('44', '1', checkoutId));
        }}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
