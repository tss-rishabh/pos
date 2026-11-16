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
setRequestOperator('44');
await db.sessions.put({
  id: 'current',
  user: {
    id: '44',
    name: 'Synthetic cashier',
    email: 'synthetic@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1'],
  },
  expiresAt: Date.now() + 300000,
});
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/orders?orderId=9007199254740993']}>
      <OrdersPage
        user={{
          id: '44',
          name: 'Synthetic cashier',
          email: 'synthetic@example.test',
          role: 4,
          userType: 1,
          storeIds: ['1'],
        }}
        storeId="1"
      />
    </MemoryRouter>
  </QueryClientProvider>,
);
