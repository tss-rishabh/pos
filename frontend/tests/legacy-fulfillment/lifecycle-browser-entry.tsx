import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import { DeliveryLifecyclePanel } from '../../src/pages/legacy-fulfillment/lifecycle';
import '../../src/styles.css';
import '../../src/pages/legacy-fulfillment/style.css';
const user: Principal = {
  id: '44',
  name: 'Fixture manager',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1', '2'],
};
setRequestOperator(user.id);
declare global {
  interface Window {
    deliveryFixture: { logout: () => void };
  }
}
function Fixture() {
  const [active, setActive] = useState(true);
  window.deliveryFixture = {
    logout: () => {
      setRequestOperator(null);
      setActive(false);
    },
  };
  return active ? (
    <DeliveryLifecyclePanel user={user} storeId="1" orderId="9007199254740993" />
  ) : (
    <p>Fixture signed out</p>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
        })
      }
    >
      <main style={{ maxWidth: '1400px', padding: '2rem', margin: 'auto' }}>
        <Fixture />
      </main>
    </QueryClientProvider>
  </StrictMode>,
);
