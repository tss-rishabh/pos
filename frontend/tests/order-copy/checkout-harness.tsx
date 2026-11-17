import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import { db, type LocalDraft } from '../../src/offline/database';
import { prepareReview } from '../../src/offline/review-snapshot';
import { recoveryFor, saveRecovery } from '../../src/pages/checkout/client';
import { CounterPage } from '../../src/pages/counter';
import { useWorkspace } from '../../src/state/workspace';
import '../../src/styles.css';

const user = {
  id: '44',
  name: 'Fixture operator',
  email: 'operator@example.test',
  role: 1 as const,
  userType: 1 as const,
  storeIds: ['1'],
};
const draft: LocalDraft = {
  id: '22222222-2222-4222-8222-222222222222',
  ownerId: user.id,
  storeId: '1',
  counterId: '2',
  customerId: '1001',
  lines: [
    {
      productId: '10',
      name: 'Original shirt',
      barcode: 'FIXTURE',
      unitPrice: '100.00',
      quantity: 1,
    },
  ],
  version: 0,
  createdAt: 1000,
  updatedAt: 1000,
};
setRequestOperator(user.id);
useWorkspace.setState({ storeId: '1', counterId: '2' });
await db.sessions.put({ id: 'current', user, expiresAt: Date.now() + 3600000 });
if (!(await db.drafts.get([user.id, draft.id]))) await db.drafts.put(draft);
if (!(await db.clearedDrafts.get([user.id, draft.id]))) {
  await prepareReview(draft);
  if (!recoveryFor(user.id, draft.id))
    saveRecovery(user.id, draft.id, {
      checkoutId: '11111111-1111-4111-8111-111111111111',
      pendingOperationId: null,
      draftVersion: draft.updatedAt,
    });
}
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
function Harness() {
  const [originalQuantity, setOriginalQuantity] = useState<number | null>(null);
  return (
    <>
      <aside style={{ position: 'fixed', top: 0, right: 0, zIndex: 2000, background: 'white' }}>
        <button
          onClick={async () => {
            const original = await db.reviewSnapshots.get([user.id, draft.id]);
            setOriginalQuantity(original?.snapshot.lines[0]?.quantity ?? null);
          }}
        >
          Inspect original snapshot
        </button>
        <output data-testid="original-quantity">{originalQuantity}</output>
      </aside>
      <CounterPage user={user} operations={[]} online sync={async () => undefined} />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queries}>
    <Harness />
  </QueryClientProvider>,
);
