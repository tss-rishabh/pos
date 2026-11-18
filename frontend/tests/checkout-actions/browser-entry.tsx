import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CartQuoteSummary } from '../../src/pages/checkout/CartQuoteSummary';
import { CheckoutCartLines } from '../../src/pages/checkout/CheckoutCartLines';
import { quotedCheckout } from './quote-fixture';
import { db } from '../../src/offline/database';
import { setRequestOperator } from '../../src/api/client';
const mode = new URLSearchParams(location.search).get('mode');
setRequestOperator('1');
await db.sessions.put({
  id: 'current',
  user: { id: '1', role: 1, userType: 1, name: 'Fixture operator', email: '', storeIds: ['2'] },
  expiresAt: Date.now() + 600000,
});
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture() {
  const [checkout, setCheckout] = useState(() => {
    const value = quotedCheckout();
    if (mode === 'cashback' || mode === 'ineligible' || mode === 'wrong-customer')
      value.customerId = '11';
    if (mode === 'missing') {
      delete value.quoteDisplay;
      value.quote = { meta: { items: [{ name: 'calculations', total: '868.00' }] } };
    }
    return value;
  });
  const [commands, setCommands] = useState<
    Array<{ path: string; method: string; body: Record<string, unknown> }>
  >([]);
  return (
    <>
      <CartQuoteSummary
        checkout={checkout}
        operatorId="1"
        current={mode !== 'stale' && checkout.phase === 'quoted'}
      />
      <CheckoutCartLines
        checkout={checkout}
        disabled={mode === 'stale' || checkout.phase !== 'quoted'}
        act={(task) => task()}
        mutate={async (path, method, body = {}) => {
          setCommands((previous) => [...previous, { path, method, body }]);
          const state = { ...checkout, phase: 'open' as const, quote: null };
          setCheckout(state);
          return { status: 'succeeded', state };
        }}
      />
      <output aria-label="Recorded commands">{JSON.stringify(commands)}</output>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Fixture />
  </QueryClientProvider>,
);
