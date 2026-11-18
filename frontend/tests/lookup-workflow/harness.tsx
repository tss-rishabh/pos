import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { request, setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import SecondaryCountrySearchPage from '../../src/pages/administration/secondary-countries';
import { StoreAdministration } from '../../src/pages/administration/stores';
import '../../src/styles.css';

const session = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    userType: z.union([z.literal(1), z.literal(2)]),
    storeIds: z.array(z.string()),
  }),
});
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Harness() {
  const [user, setUser] = useState<Principal | null>(null),
    [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    void request('/api/v1/auth/sessions/current', {}, session)
      .then((result) => {
        if (!current) return;
        setRequestOperator(result.user.id);
        setUser(result.user);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
      setRequestOperator(null);
    };
  }, []);
  if (error) return <p role="alert">The real authenticated session is unavailable.</p>;
  if (!user) return <p role="status">Loading authenticated session.</p>;
  return new URLSearchParams(location.search).get('view') === 'postal' ? (
    <StoreAdministration user={user} />
  ) : (
    <SecondaryCountrySearchPage user={user} />
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Harness />
  </QueryClientProvider>,
);
