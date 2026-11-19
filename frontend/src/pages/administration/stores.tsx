import { AdministrationCollectionTable, useAdministrationView } from './collection-table';
import { StoreDetailDialog } from './store-detail';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { ErrorState } from '../../components/common';
import { SkeletonTable } from '../../components/loader';
import { StoreForm } from './store-form';
import {
  mutateAdministration,
  storeSchema,
  useAdministrationCollection,
  type AdministrationStore,
} from './api';

export function StoreAdministration({ user }: { user: Principal }) {
  const view = useAdministrationView('stores', user.id),
    [viewing, setViewing] = useState<string | null>(null);
  const client = useQueryClient(),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('true'),
    [editing, setEditing] = useState<AdministrationStore | 'new' | null>(null),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const collection = useAdministrationCollection(
    user.id,
    '/api/v1/admin/stores',
    storeSchema,
    search,
    status,
    undefined,
    view.options,
  );
  const changed = async () => {
    await client.invalidateQueries({ queryKey: [user.id] });
  };
  async function edit(id: string) {
    try {
      setEditing(await request(`/api/v1/admin/stores/${id}`, { operatorId: user.id }, storeSchema));
      setError(null);
    } catch (failure) {
      setError(failure);
    }
  }
  async function toggle(store: AdministrationStore) {
    try {
      await mutateAdministration(
        `/api/v1/admin/stores/${store.id}/status`,
        'PATCH',
        {
          active: !store.active,
        },
        user.id,
      );
      setMessage(store.active ? 'The Store has been deleted' : 'The Store has been activated');
      await changed();
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <>
      <div className="administration-heading">
        <h2>Store management</h2>
        <div className="administration-filters">
          <input
            aria-label="Find store"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a store"
          />
          <select
            aria-label="Store status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="true">Stores</option>
            <option value="false">Archived Stores</option>
          </select>
          {[1, 3].includes(user.role) && (
            <button className="button primary" onClick={() => setEditing('new')}>
              <Plus size={16} />
              Create store
            </button>
          )}
        </div>
      </div>
      {message && (
        <div role="status" className="administration-status">
          {message}
        </div>
      )}
      {error !== null && <ErrorState error={error} />}
      <section className="surface">
        {collection.isPending ? (
          <SkeletonTable />
        ) : collection.isError ? (
          <ErrorState error={collection.error} />
        ) : (
          <AdministrationCollectionTable
            ownerId={user.id}
            view={view}
            collection={collection}
            search={search}
            active={status}
            columns={[
              {
                key: 'id',
                label: 'Store ID',
                sort: 'id',
                value: (row: AdministrationStore) => row.id,
              },
              {
                key: 'locationCode',
                label: 'Location Code',
                sort: 'locationCode',
                value: (row) => row.locationCode,
              },
              { key: 'name', label: 'Store Name', sort: 'name', value: (row) => row.name },
              { key: 'address', label: 'Address', sort: 'address', value: (row) => row.address },
              { key: 'pincode', label: 'Pincode', sort: 'pincode', value: (row) => row.pincode },
              { key: 'city', label: 'City', sort: 'city', value: (row) => row.city },
              { key: 'phone', label: 'Phone', sort: 'phone', value: (row) => row.phone },
              { key: 'type', label: 'Type', sort: 'type', value: (row) => row.type },
              { key: 'email', label: 'Email', sort: 'email', value: (row) => row.email },
              {
                key: 'latitude',
                label: 'Latitude',
                sort: 'latitude',
                value: (row) => row.latitude,
              },
              {
                key: 'longitude',
                label: 'Longitude',
                sort: 'longitude',
                value: (row) => row.longitude,
              },
              {
                key: 'createdAt',
                label: 'Created At',
                sort: 'createdAt',
                value: (row) => row.createdAt,
              },
            ]}
            actions={(store) => (
              <>
                {store.active && (
                  <button className="button secondary" onClick={() => setViewing(store.id)}>
                    View
                  </button>
                )}
                {store.active && [1, 3].includes(user.role) && (
                  <button className="button secondary" onClick={() => void edit(store.id)}>
                    Edit
                  </button>
                )}
                {user.role === 1 && (
                  <button className="button secondary" onClick={() => void toggle(store)}>
                    {store.active ? 'Delete' : 'Activate'}
                  </button>
                )}
              </>
            )}
          />
        )}
      </section>
      {viewing && (
        <StoreDetailDialog
          key={`${user.id}:${viewing}`}
          operatorId={user.id}
          storeId={viewing}
          onClose={() => setViewing(null)}
        />
      )}
      {editing && (
        <StoreForm
          key={editing === 'new' ? 'new' : editing.id}
          user={user}
          store={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={async (text) => {
            setMessage(text);
            await changed();
          }}
        />
      )}
    </>
  );
}
