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
import { ModelAccessAdministration } from './access';
import { AdministrationAuthenticationContext } from './access-authentication';
import './styles.css';

export { OperatorCheckIn } from './check-in';
export { DocumentationPage } from './support';

const tabs = [
  { id: 'stores', label: 'Stores' },
  { id: 'operators', label: 'Operators' },
  { id: 'salespeople', label: 'Salespeople' },
  { id: 'resources', label: 'Counters & storage' },
  { id: 'settings', label: 'Settings & timings' },
  { id: 'imports', label: 'Inventory imports' },
  { id: 'access', label: 'Model access' },
] as const;
type Tab = (typeof tabs)[number]['id'];

export function AdministrationPage({
  user,
  storeId,
  onAuthenticationRevoked,
}: {
  user: Principal;
  storeId: string;
  onAuthenticationRevoked?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('stores');
  if (![1, 2, 3].includes(user.role)) return <Empty title="Administration access is required" />;
  return (
    <AdministrationAuthenticationContext.Provider value={onAuthenticationRevoked || null}>
      <PageTitle eyebrow="STORE CONTROL" title="Administration" />
      <div className="administration-actions">
        <Link className="button secondary" to="/application-links">
          Application QR and downloads
        </Link>
      </div>
      {user.userType === 1 && (
        <div className="administration-actions">
          <Link className="button secondary" to="/administration/permission-history">
            View permission activity
          </Link>
        </div>
      )}
      {user.userType === 1 && user.role === 1 && (
        <div className="administration-actions">
          <Link className="button secondary" to="/administration/model-history">
            View model history
          </Link>
        </div>
      )}
      {user.userType === 1 && [1, 2].includes(user.role) && (
        <div className="administration-actions">
          <Link className="button secondary" to="/administration/gift-card-batches">
            Gift card batches
          </Link>
        </div>
      )}
      <div role="tablist" aria-label="Administration sections" className="administration-tabs">
        {tabs
          .filter((item) => item.id !== 'access' || user.role === 1)
          .map((item) => (
            <button
              key={item.id}
              id={`administration-tab-${item.id}`}
              role="tab"
              aria-selected={item.id === tab}
              aria-controls={`administration-panel-${item.id}`}
              onClick={() => setTab(item.id)}
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
        {tab === 'stores' && <StoreAdministration user={user} />}{' '}
        {tab === 'operators' && <OperatorAdministration user={user} />}{' '}
        {tab === 'salespeople' && <SalespersonAdministration user={user} />}{' '}
        {tab === 'resources' && (
          <StoreResourceAdministration key={storeId} user={user} storeId={storeId} />
        )}{' '}
        {tab === 'settings' && (
          <StoreSettingsAdministration key={storeId} user={user} storeId={storeId} />
        )}
        {tab === 'imports' && <InventoryImportAdministration user={user} />}
        {tab === 'access' && user.role === 1 && <ModelAccessAdministration user={user} />}
      </div>
    </AdministrationAuthenticationContext.Provider>
  );
}
