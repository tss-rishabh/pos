import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { setRequestOperator } from '../../src/api/client';
import GlobalVouchersPage from '../../src/pages/global-vouchers';
import { GlobalVoucherConversion } from '../../src/pages/global-vouchers/conversion';
import { readCheckout } from '../../src/pages/checkout/client';
import { fixtureCheckout } from './fixtures';
import '../../src/styles.css';

setRequestOperator('1');
function Harness() {
  const [owner, setOwner] = useState('1'),
    [online, setOnline] = useState(true),
    [pending, setPending] = useState(false),
    [checkout, setCheckout] = useState(() => fixtureCheckout('1'));
  const user = {
    id: owner,
    role: 1 as const,
    userType: 1 as const,
    name: 'Synthetic operator',
    email: 'operator@example.test',
    storeIds: ['1'],
  };
  return (
    <>
      <aside>
        <p>Current operator {owner}</p>
        <button onClick={() => setOnline(!online)}>Toggle fixture connection</button>
        <button
          onClick={() => {
            setRequestOperator('2');
            setOwner('2');
            setCheckout(fixtureCheckout('2'));
          }}
        >
          Switch fixture operator
        </button>
        <button disabled={pending}>Fixture payment</button>
        <p>Checkout version {checkout.version}</p>
      </aside>
      {location.pathname.endsWith('/conversion') ? (
        <GlobalVoucherConversion
          user={user}
          state={checkout}
          online={online}
          onPending={setPending}
          onSaved={async () => {
            const value = await readCheckout('1', checkout.id, owner);
            setCheckout(value);
          }}
        />
      ) : (
        <GlobalVouchersPage user={user} online={online} />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
