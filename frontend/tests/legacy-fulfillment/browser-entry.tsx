import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import { db } from '../../src/offline/database';
import { LegacyFulfillmentPage } from '../../src/pages/legacy-fulfillment';
import '../../src/styles.css';
const user: Principal = {
  id: '44',
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
    legacyFixture: { logout: () => void };
  }
}
function Fixture() {
  const [active, setActive] = useState(true);
  window.legacyFixture = {
    logout: () => {
      setRequestOperator(null);
      setActive(false);
    },
  };
  return active ? <LegacyFulfillmentPage user={user} storeId="1" /> : <p>Fixture signed out</p>;
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
