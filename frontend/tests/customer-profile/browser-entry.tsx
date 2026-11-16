import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CustomerProfileCard } from '../../src/pages/customer-insights/profile';
import { CustomerInsights } from '../../src/pages/customer-insights/insights';
import { CustomerBenefitsCard } from '../../src/pages/customer-insights/benefits';
import { CustomerHistoryCard } from '../../src/pages/customer-insights/history';
import { db } from '../../src/offline/database';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import '../../src/styles.css';

const user: Principal = {
  id: '7',
  role: 4,
  userType: 1,
  name: 'Fixture operator',
  email: 'operator@example.test',
  storeIds: ['1'],
};
setRequestOperator(user.id);
await db.sessions.put({ id: 'current', user, expiresAt: Date.now() + 300_000 });
declare global {
  interface Window {
    customerProfileFixture: {
      expire: () => Promise<void>;
      changeOperator: () => void;
      online: (value: boolean) => void;
      refreshFailure: (value: boolean) => void;
      pending: boolean;
      storedData: () => Promise<string>;
    };
  }
}
function Fixture() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState(false);
  const [version, setVersion] = useState(1);
  window.customerProfileFixture = {
    expire: async () => {
      await db.sessions.update('current', { expiresAt: Date.now() - 1 });
    },
    changeOperator: () => setRequestOperator('8'),
    online: setOnline,
    refreshFailure: setRefreshFailure,
    pending,
    storedData: async () =>
      JSON.stringify(await Promise.all(db.tables.map((table) => table.toArray()))),
  };
  return (
    <>
      <CustomerProfileCard
        operatorId="7"
        storeId="1"
        checkoutId="a53b9ec4-76ce-4641-95d5-7d3f4f073ab4"
        customerId="777"
        checkoutVersion={version}
        online={online}
        actions={{
          act: async (task) => task(),
          onPending: setPending,
          onSaved: async () => {
            if (refreshFailure) throw new Error('Fixture refresh unavailable');
            setVersion(2);
            setPending(false);
          },
        }}
      />
      <CustomerInsights
        scope={{
          operatorId: '7',
          storeId: '1',
          checkoutId: 'a53b9ec4-76ce-4641-95d5-7d3f4f073ab4',
          customerId: '777',
        }}
        checkoutVersion={version}
        online={online}
        disabled={pending}
      />
      <CustomerBenefitsCard
        scope={{
          operatorId: '7',
          storeId: '1',
          checkoutId: 'a53b9ec4-76ce-4641-95d5-7d3f4f073ab4',
          customerId: '777',
        }}
        checkoutVersion={version}
        online={online}
        disabled={pending}
      />
      <CustomerHistoryCard
        scope={{
          operatorId: '7',
          storeId: '1',
          checkoutId: 'a53b9ec4-76ce-4641-95d5-7d3f4f073ab4',
          customerId: '777',
        }}
        checkoutVersion={version}
        online={online}
        disabled={pending}
        orderDetailsPath={(id) => '/orders?orderId=' + encodeURIComponent(id)}
        feedbackPath={(id) =>
          '/stores/1/checkout-sessions/a53b9ec4-76ce-4641-95d5-7d3f4f073ab4/customers/777/orders/' +
          encodeURIComponent(id) +
          '/feedback'
        }
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
);
