import { useState } from 'react';
import { Link } from 'react-router-dom';
export { OperatorMfaButton } from './mfa';
import type { Principal } from '../../api/types';
import { Empty, PageTitle } from '../../components/common';
import { StoreAdministration } from './stores';
import { OperatorAdministration, SalespersonAdministration } from './people';
import { StoreResourceAdministration } from './store-resources';
import { StoreSettingsAdministration } from './support';
import { InventoryImportAdministration } from './imports';
import './styles.css';

export { DocumentationPage } from './support';

const tabs = [
  { id: 'stores', label: 'Stores' },
  { id: 'operators', label: 'Operators' },
  { id: 'salespeople', label: 'Salespeople' },
  { id: 'resources', label: 'Counters & storage' },
  { id: 'settings', label: 'Settings & timings' },
  { id: 'imports', label: 'Inventory imports' },
] as const;
type Tab = (typeof tabs)[number]['id'];

export function AdministrationPage({
  user,
  storeId,
}: {
  user: Principal;
  storeId: string;
  /** Kept for the router; the deleted model-access page was its only consumer. */
  onAuthenticationRevoked?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('stores');
  if (![1, 2, 3].includes(user.role)) return <Empty title="Administration access is required" />;
  return (
    <>
      <PageTitle title="Administration">
        <nav className="toolbar administration-links" aria-label="Administration pages">
          <Link className="button secondary small" to="/application-links">
            Application QR and downloads
          </Link>
          {user.userType === 1 && (
            <Link className="button secondary small" to="/administration/permission-history">
              View permission activity
            </Link>
          )}
          {user.userType === 1 && user.role === 1 && (
            <Link className="button secondary small" to="/administration/model-history">
              View model history
            </Link>
          )}
          {user.userType === 1 && [1, 2].includes(user.role) && (
            <Link className="button secondary small" to="/administration/gift-card-batches">
              Gift card batches
            </Link>
          )}
        </nav>
      </PageTitle>
      <div
        role="tablist"
        aria-label="Administration sections"
        className="tab-group administration-tabs"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`administration-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={item.id === tab}
            aria-controls={`administration-panel-${item.id}`}
            tabIndex={item.id === tab ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const index = tabs.findIndex((value) => value.id === tab);
              const next =
                tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
              setTab(next.id);
              document.getElementById(`administration-tab-${next.id}`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`administration-panel-${tab}`}
        aria-labelledby={`administration-tab-${tab}`}
      >
        {tab === 'stores' && <StoreAdministration user={user} />}
        {tab === 'operators' && <OperatorAdministration user={user} />}
        {tab === 'salespeople' && <SalespersonAdministration user={user} />}
        {tab === 'resources' && (
          <StoreResourceAdministration key={storeId} user={user} storeId={storeId} />
        )}
        {tab === 'settings' && (
          <StoreSettingsAdministration key={storeId} user={user} storeId={storeId} />
        )}
        {tab === 'imports' && <InventoryImportAdministration user={user} />}
      </div>
    </>
  );
}
