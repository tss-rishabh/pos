import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Principal } from '../../src/api/types';
import { setRequestOperator } from '../../src/api/client';
import { db } from '../../src/offline/database';
import { OrderInvoiceActions } from '../../src/pages/invoice-documents';
import '../../src/styles.css';
const initial: Principal = {
  id: '44',
  role: 4,
  userType: 1,
  storeIds: ['1'],
  name: 'Fixture operator',
  email: 'fixture@example.test',
};
setRequestOperator(initial.id);
await db.sessions.put({ id: 'current', user: initial, expiresAt: Date.now() + 300000 });
function Harness() {
  const [user, setUser] = useState(initial),
    [storeId, setStore] = useState('1'),
    [orderId, setOrder] = useState('12345'),
    [online, setOnline] = useState(true),
    [access, setAccess] = useState<'global-online' | undefined>(
      new URLSearchParams(location.search).has('global') ? 'global-online' : undefined,
    );
  async function actor() {
    const next = { ...initial, id: '55' };
    setRequestOperator(next.id);
    await db.sessions.put({ id: 'current', user: next, expiresAt: Date.now() + 300000 });
    setUser(next);
  }
  return (
    <main>
      <h1>Invoice options fixture</h1>
      <button onClick={() => setOnline((value) => !value)}>Toggle connection</button>
      <button onClick={() => setStore('2')}>Change store</button>
      <button onClick={() => setOrder('12346')}>Change order</button>
      <button onClick={() => void actor()}>Change operator</button>
      <button onClick={() => setAccess((value) => (value ? undefined : 'global-online'))}>
        Change invoice access
      </button>
      <p>Current operator {user.id}</p>
      <OrderInvoiceActions
        access={access}
        user={user}
        storeId={storeId}
        orderId={orderId}
        online={online}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
