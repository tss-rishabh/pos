import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setRequestOperator } from '../../src/api/client';
import { OrderCopyPanel, orderCopyRequiresOnlineReview } from '../../src/pages/order-copy';

setRequestOperator('44');
function Harness() {
  const [pending, setPending] = useState(false),
    [saved, setSaved] = useState(0),
    [actor, setActor] = useState('44');
  const online = new URLSearchParams(location.search).get('offline') !== 'true';
  return (
    <main>
      <button
        onClick={() => {
          setRequestOperator('99');
          setActor('99');
        }}
      >
        Switch operator
      </button>
      <output data-testid="pending">{String(pending)}</output>
      <output data-testid="saved">{saved}</output>
      <output data-testid="requires-online">
        {String(orderCopyRequiresOnlineReview('44', '1', '11111111-1111-4111-8111-111111111111'))}
      </output>
      {actor === '44' ? (
        <OrderCopyPanel
          scope={{
            operatorId: '44',
            storeId: '1',
            checkoutId: '11111111-1111-4111-8111-111111111111',
            customerId: '1001',
          }}
          checkoutVersion={2}
          online={online}
          onPending={setPending}
          onSaved={async () => {
            setSaved((value) => value + 1);
          }}
        />
      ) : (
        <p>Other operator workspace</p>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
