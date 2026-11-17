import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setRequestOperator } from '../../src/api/client';
import { OrderCopyPanel, orderCopyRequiresOnlineReview } from '../../src/pages/order-copy';

setRequestOperator('44');
function Harness() {
  const [pending, setPending] = useState(false),
    [saved, setSaved] = useState(0),
    [cancelled, setCancelled] = useState(0),
    [blocked, setBlocked] = useState(false),
    [preflights, setPreflights] = useState(0),
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
      <button onClick={() => setBlocked(true)}>Block source changes</button>
      <output data-testid="cancelled">{cancelled}</output>
      <output data-testid="preflights">{preflights}</output>
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
          disabled={blocked}
          beforeDispatch={async () => {
            setPreflights((value) => value + 1);
            if (blocked) throw new Error('Source change is blocked');
          }}
          onUnsentCancelled={async () => {
            setCancelled((value) => value + 1);
            if (new URLSearchParams(location.search).get('failCancelAdopt') === 'true')
              throw new Error('Late cash must be reconciled');
          }}
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
