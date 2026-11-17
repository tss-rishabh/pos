import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import OrderImportsPage from '../../src/pages/administration/order-imports';
import '../../src/styles.css';
const original: Principal = {
  id: '44',
  role: 1,
  userType: 1,
  storeIds: ['1'],
  name: 'Fixture manager',
  email: 'manager@example.test',
};
setRequestOperator(original.id);
function Harness() {
  const [user, setUser] = useState(original),
    [online, setOnline] = useState(true);
  return (
    <>
      <aside>
        <button onClick={() => setOnline((value) => !value)}>
          {online ? 'Go offline' : 'Reconnect'}
        </button>
        <button
          onClick={() => {
            const next = { ...original, id: '45' };
            setRequestOperator(next.id);
            setUser(next);
          }}
        >
          Switch operator
        </button>
        <output data-testid="operator">{user.id}</output>
      </aside>
      <OrderImportsPage user={user} online={online} />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
