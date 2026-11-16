import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ProductFeedbackWorkspace } from '../../src/pages/product-feedback';
import { db } from '../../src/offline/database';
import { setRequestOperator } from '../../src/api/client';
import '../../src/styles.css';

const user = {
  id: '7',
  role: 4 as const,
  userType: 1 as const,
  name: 'Fixture operator',
  email: 'operator@example.test',
  storeIds: ['1'],
};
setRequestOperator(user.id);
await db.sessions.put({ id: 'current', user, expiresAt: Date.now() + 300000 });
declare global {
  interface Window {
    productFeedbackFixture: {
      online: (value: boolean) => void;
      changeOperator: () => void;
      stored: () => Promise<string>;
    };
  }
}
function Fixture() {
  const [online, setOnline] = useState(new URLSearchParams(location.search).get('offline') !== '1');
  window.productFeedbackFixture = {
    online: setOnline,
    changeOperator: () => setRequestOperator('8'),
    stored: async () =>
      JSON.stringify(await Promise.all(db.tables.map((table) => table.toArray()))),
  };
  return (
    <ProductFeedbackWorkspace
      scope={{
        operatorId: '7',
        storeId: '1',
        checkoutId: 'a53b9ec4-76ce-4641-95d5-7d3f4f073ab4',
        customerId: '777',
        orderId: '9007199254740993',
      }}
      online={online}
    />
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <Fixture />
    </MemoryRouter>
  </QueryClientProvider>,
);
