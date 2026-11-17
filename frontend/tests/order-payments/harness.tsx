import { useState } from 'react';
import type { Principal } from '../../src/api/types';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { OrdersPage } from '../../src/pages/operations';
import { db, type LocalDraft } from '../../src/offline/database';
import { setRequestOperator } from '../../src/api/client';
import '../../src/styles.css';
const draft: LocalDraft = {
  id: '22222222-2222-4222-8222-222222222222',
  ownerId: '44',
  storeId: '1',
  counterId: '3',
  customerId: null,
  version: 7,
  updatedAt: 1000,
  createdAt: 1000,
  lines: [
    {
      productId: '10',
      name: 'Unpurchased later sale',
      barcode: null,
      unitPrice: '99.95',
      quantity: 8,
    },
  ],
};
if (!(await db.drafts.get(['44', draft.id]))) await db.drafts.put(draft);
const manager = new URLSearchParams(location.search).has('manager'),
  initialActor = new URLSearchParams(location.search).get('operator') === '55' ? '55' : '44';
const fixtureUser = (actorId: string): Principal => ({
  id: actorId,
  name: 'Synthetic operator ' + actorId,
  email: 'synthetic' + actorId + '@example.test',
  role: manager ? 2 : 4,
  userType: 1,
  storeIds: manager ? ['1', '2'] : ['1'],
});
async function adoptActor(actorId: string) {
  await db.sessions.put({
    id: 'current',
    user: fixtureUser(actorId),
    expiresAt: Date.now() + 300000,
  });
  setRequestOperator(actorId);
}
await adoptActor(initialActor);
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
function Harness() {
  const [actor, setActor] = useState(initialActor),
    [storeId, setStore] = useState('1'),
    [online, setOnline] = useState(true);
  return (
    <>
      {manager && (
        <>
          <output aria-label="Fixture operator">{actor}</output>
          <button
            onClick={() => {
              const next = actor === '44' ? '55' : '44';
              void adoptActor(next).then(() => setActor(next));
            }}
          >
            Switch fixture manager
          </button>
          <button onClick={() => setStore((value) => (value === '1' ? '2' : '1'))}>
            Switch fixture store
          </button>
          <button
            onClick={() => {
              const next = !online;
              Object.defineProperty(navigator, 'onLine', { value: next, configurable: true });
              window.dispatchEvent(new Event(next ? 'online' : 'offline'));
              setOnline(next);
            }}
          >
            Toggle fixture network
          </button>
        </>
      )}
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/orders?orderId=9007199254740993']}>
          <OrdersPage user={fixtureUser(actor)} storeId={storeId} />
        </MemoryRouter>
      </QueryClientProvider>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
