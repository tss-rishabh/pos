import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { request, setRequestOperator } from '../../src/api/client';
import { db } from '../../src/offline/database';
import { CustomerContactPanel } from '../../src/pages/customer-contacts';
import '../../src/styles.css';

const user = (id: string) => ({
  id,
  name: 'Synthetic operator' + id,
  email: 'operator' + id + '@example.test',
  role: 1 as const,
  userType: 1 as const,
  storeIds: ['1'],
});
setRequestOperator('1');
await db.sessions.put({ id: 'current', user: user('1'), expiresAt: Date.now() + 3600000 });
function Harness() {
  const [owner, setOwner] = useState('1'),
    [version, setVersion] = useState(5),
    [disabled, setDisabled] = useState(false),
    [online, setOnline] = useState(true),
    [pending, setPending] = useState(false),
    [saved, setSaved] = useState(0);
  return (
    <main>
      <button onClick={() => setDisabled(!disabled)}>Toggle other sale action</button>
      <button onClick={() => setOnline(!online)}>Toggle connection</button>
      <button
        onClick={async () => {
          setRequestOperator('2');
          await db.sessions.put({
            id: 'current',
            user: user('2'),
            expiresAt: Date.now() + 3600000,
          });
          setOwner('2');
          setPending(false);
        }}
      >
        Switch operator
      </button>
      <p>Current operator {owner}</p>
      <p>Contact pending {pending ? 'yes' : 'no'}</p>
      <p>Saved refreshes {saved}</p>
      <CustomerContactPanel
        scope={{
          operatorId: owner,
          storeId: '1',
          checkoutId:
            owner === '1'
              ? '11111111-1111-4111-8111-111111111111'
              : '22222222-2222-4222-8222-222222222222',
          customerId: '7',
        }}
        checkoutVersion={version}
        online={online}
        disabled={disabled}
        actions={{
          act: async (task) => {
            await task();
          },
          onPending: setPending,
          onSaved: async () => {
            const next = await request(
              '/api/v1/contact-fixture-checkout',
              { operatorId: owner },
              z.object({ version: z.number() }),
            );
            setVersion(next.version);
            setSaved((value) => value + 1);
          },
        }}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
    }
  >
    <Harness />
  </QueryClientProvider>,
);
