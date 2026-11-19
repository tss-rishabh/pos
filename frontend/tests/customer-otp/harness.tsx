import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import { db, type LocalDraft } from '../../src/offline/database';
import { prepareReview } from '../../src/offline/review-snapshot';
import { recoveryFor, saveRecovery } from '../../src/pages/checkout/client';
import { CheckoutReview } from '../../src/pages/checkout/CheckoutReview';
import '../../src/styles.css';

performance.mark('customer-otp-fixture-bootstrap-start');
const ids = {
  '1': {
    draft: '11111111-1111-4111-8111-111111111111',
    checkout: '33333333-3333-4333-8333-333333333333',
  },
  '2': {
    draft: '22222222-2222-4222-8222-222222222222',
    checkout: '44444444-4444-4444-8444-444444444444',
  },
} as const;
type Owner = keyof typeof ids;
const drafts = new Map<Owner, LocalDraft>();
const user = (id: Owner) => ({
  id,
  role: 1 as const,
  userType: 1 as const,
  name: 'Synthetic operator ' + id,
  email: 'operator' + id + '@example.test',
  storeIds: ['1'],
});
for (const owner of ['1', '2'] as const) {
  const draft: LocalDraft = {
    id: ids[owner].draft,
    ownerId: owner,
    storeId: '1',
    counterId: '1',
    customerId: owner === '1' ? '7' : null,
    version: 1,
    updatedAt: 1000,
    createdAt: 1000,
    lines: [
      {
        productId: '123',
        name: 'Synthetic shirt',
        barcode: 'synthetic-barcode',
        unitPrice: '100.00',
        quantity: 1,
      },
    ],
  };
  drafts.set(owner, draft);
  await db.drafts.put(draft);
  await prepareReview(draft);
  if (!recoveryFor(owner, draft.id))
    saveRecovery(owner, draft.id, {
      checkoutId: ids[owner].checkout,
      pendingOperationId: null,
      draftVersion: draft.updatedAt,
    });
}
performance.mark('customer-otp-fixture-drafts-ready');
setRequestOperator('1');
await db.sessions.put({ id: 'current', user: user('1'), expiresAt: Date.now() + 3600000 });
performance.mark('customer-otp-fixture-session-ready');
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
function Harness() {
  const [owner, setOwner] = useState<Owner>('1'),
    [online, setOnline] = useState(true);
  useEffect(() => {
    performance.mark('customer-otp-fixture-mounted');
  }, []);
  return (
    <>
      <aside style={{ position: 'fixed', top: 0, right: 0, zIndex: 2000, background: 'white' }}>
        <p>Current operator {owner}</p>
        <button onClick={() => setOnline(!online)}>Toggle fixture connection</button>
        <button
          onClick={async () => {
            setRequestOperator('2');
            queries.clear();
            await db.sessions.put({
              id: 'current',
              user: user('2'),
              expiresAt: Date.now() + 3600000,
            });
            setOwner('2');
          }}
        >
          Switch fixture operator
        </button>
      </aside>
      <CheckoutReview
        key={owner}
        user={user(owner)}
        draft={drafts.get(owner)!}
        online={online}
        onClose={() => undefined}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queries}>
    <Harness />
  </QueryClientProvider>,
);
