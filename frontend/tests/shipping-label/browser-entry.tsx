import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import { db } from '../../src/offline/database';
import { ShippingLabelDialog } from '../../src/pages/fulfillment/shipping-label';
import '../../src/styles.css';
const user: Principal = {
  id: '1',
  name: 'Fixture operator',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
setRequestOperator(user.id);
await db.sessions.put({ id: 'current', user, expiresAt: Date.now() + 600_000 });
declare global {
  interface Window {
    shippingFixture: {
      expire: () => Promise<void>;
      changeOperator: () => void;
      printCount: number;
    };
  }
}
window.shippingFixture = {
  expire: async () => {
    await db.sessions.update('current', { expiresAt: Date.now() - 1 });
  },
  changeOperator: () => setRequestOperator('9'),
  printCount: 0,
};
window.addEventListener('message', (event) => {
  if (
    event.origin === location.origin &&
    event.data?.type === 'shipping-fixture-printed' &&
    event.data.scope === '1:1001'
  )
    window.shippingFixture.printCount++;
});
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
        })
      }
    >
      <ShippingLabelDialog
        user={user}
        storeId="1"
        orderId="1001"
        online={new URL(location.href).searchParams.get('offline') !== '1'}
        onClose={() => {
          document.getElementById('root')!.textContent = 'Closed shipping label';
        }}
      />
    </QueryClientProvider>
  </StrictMode>,
);
