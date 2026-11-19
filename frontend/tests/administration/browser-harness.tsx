import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request, setRequestOperator } from '../../src/api/client';
import { ProfileImages } from '../../src/pages/profile/images';
import { AdministrationPage, DocumentationPage } from '../../src/pages/administration';
import { SpecialPermissionHistoryPage } from '../../src/pages/administration/permission-history';
import { AdministrationHistoryPage } from '../../src/pages/administration/history';
import { GiftCardBatchesPage } from '../../src/pages/administration/gift-card-batches';
import {
  ApplicationLinksPage,
  ApplicationLinkLandingPage,
} from '../../src/pages/administration/application-links';
import type { Principal } from '../../src/api/types';

const user: Principal = {
  id: '1',
  name: 'Fixture administrator',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1'],
};
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
function ProfileImageFixture() {
  const view = useQuery({
    queryKey: ['profile-image-fixture'],
    queryFn: () =>
      request(
        '/api/v1/operators/current/profile',
        {},
        z.object({
          profile: z.object({
            revision: z.string(),
            imagesAvailable: z.boolean(),
            hasProfileImage: z.boolean(),
            hasCoverImage: z.boolean(),
          }),
        }),
      ),
  });
  return (
    view.data && (
      <ProfileImages
        operatorId={user.id}
        revision={view.data.profile.revision}
        available={view.data.profile.imagesAvailable}
        hasImage={view.data.profile.hasProfileImage}
        hasCover={view.data.profile.hasCoverImage}
        online
        onAttached={async () => {
          await view.refetch({ throwOnError: true });
        }}
      />
    )
  );
}
setRequestOperator(user.id);
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <QueryClientProvider client={client}>
      {window.location.pathname === '/application-links/staff' ? (
        <StrictMode>
          <ApplicationLinkLandingPage kind="staff" />
        </StrictMode>
      ) : window.location.pathname === '/application-links/customer' ? (
        <StrictMode>
          <ApplicationLinkLandingPage kind="customer" />
        </StrictMode>
      ) : new URLSearchParams(window.location.search).get('screen') === 'application-links' ? (
        <StrictMode>
          <ApplicationLinksPage user={user} />
        </StrictMode>
      ) : new URLSearchParams(window.location.search).get('screen') === 'gift-card-batches' ? (
        <GiftCardBatchesPage user={user} />
      ) : new URLSearchParams(window.location.search).get('screen') === 'model-history' ? (
        <AdministrationHistoryPage user={user} />
      ) : new URLSearchParams(window.location.search).get('screen') === 'permission-history' ? (
        <SpecialPermissionHistoryPage user={user} />
      ) : new URLSearchParams(window.location.search).get('screen') === 'profile-images' ? (
        <ProfileImageFixture />
      ) : new URLSearchParams(window.location.search).get('screen') === 'documentation' ? (
        <DocumentationPage user={user} />
      ) : (
        <AdministrationPage user={user} storeId="1" />
      )}
    </QueryClientProvider>
  </BrowserRouter>,
);
