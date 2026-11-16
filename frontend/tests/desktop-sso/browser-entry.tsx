import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Login } from '../../src/pages/login';
import { DesktopSsoApprovalPage } from '../../src/pages/desktop-sso';
import type { Principal } from '../../src/api/types';
import { setRequestOperator } from '../../src/api/client';
import '../../src/styles.css';

setRequestOperator(null);
declare global {
  interface Window {
    desktopSsoFixture: { opened: string[] };
  }
}
window.desktopSsoFixture = { opened: [] };
window.open = (url) => {
  window.desktopSsoFixture.opened.push(String(url));
  return null;
};
function Fixture() {
  const operator = useQuery<Principal | null>({
    queryKey: ['operator'],
    queryFn: async () => null,
    enabled: false,
  });
  return new URL(window.location.href).searchParams.get('approval') === 'true' ? (
    <DesktopSsoApprovalPage />
  ) : operator.data ? (
    <p role="status">Signed in as {operator.data.name}</p>
  ) : (
    <Login />
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
);
