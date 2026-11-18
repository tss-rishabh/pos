import { AdministrationCollectionTable, useAdministrationView } from './collection-table';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { Empty, ErrorState, Loading } from '../../components/common';
import { AdministrationEditor, type AdministrationField } from './editor';
import { TerminalAdministration } from './terminals';
import {
  counterSchema,
  storageSchema,
  commonStoreSchema,
  mutateAdministration,
  useAdministrationCollection,
} from './api';

export function StoreResourceAdministration({
  user,
  storeId,
}: {
  user: Principal;
  storeId: string;
}) {
  const client = useQueryClient();
  const [kind, setKind] = useState<'counters' | 'storages'>('counters');
  const view = useAdministrationView(kind === 'counters' ? 'counters' : 'storage', user.id);
  const [status, setStatus] = useState('true');
  const [creating, setCreating] = useState(false);
  const [editingStorage, setEditingStorage] = useState<z.infer<typeof storageSchema> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const path = `/api/v1/admin/stores/${storeId}`;
  const counters = useAdministrationCollection(
    user.id,
    storeId && `${path}/counters`,
    counterSchema,
    '',
    status,
    undefined,
    view.options,
  );
  const storages = useAdministrationCollection(
    user.id,
    storeId && `${path}/storages`,
    storageSchema,
    '',
    status,
    undefined,
    view.options,
  );
  const stores = useQuery({
    queryKey: [user.id, 'administration', 'assignable-stores'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/stores',
        { operatorId: user.id, signal },
        z.object({ data: z.array(commonStoreSchema) }),
      ),
  });
  const collection = kind === 'counters' ? counters : storages;
  const fields: AdministrationField[] = [
    ...(kind === 'storages'
      ? [
          {
            name: 'name',
            label: 'Storage name',
            required: true,
            maxLength: editingStorage ? 100 : 80,
          },
        ]
      : []),
    {
      name: 'description',
      label: 'Description',
      kind: 'textarea',
      required: kind === 'storages',
      maxLength: 255,
    },
    ...(editingStorage
      ? [
          {
            name: 'destinationStoreId',
            label: 'Store',
            kind: 'select' as const,
            required: true,
            options: (stores.data?.data || []).map((store) => ({
              value: store.id,
              label: store.name,
            })),
          },
        ]
      : []),
  ];
  const changed = () => client.invalidateQueries({ queryKey: [user.id] });
  async function toggle(id: string, active: boolean) {
    try {
      await mutateAdministration(
        `${path}/${kind}/${id}/status`,
        'PATCH',
        { active: !active },
        user.id,
      );
      setError(null);
      setMessage(active ? 'Resource archived.' : 'Resource activated.');
      await changed();
    } catch (failure) {
      setError(failure);
    }
  }
  if (!storeId) return <Empty title="Choose a store to manage counters and storage" />;
  return (
    <>
      <div className="administration-heading">
        <h2>Counters and storage</h2>
        <div className="administration-filters">
          <select
            aria-label="Resource type"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value === 'storages' ? 'storages' : 'counters')
            }
          >
            <option value="counters">Counters</option>
            <option value="storages">Storage</option>
          </select>
          <select
            aria-label="Resource status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="true">Active</option>
            <option value="false">Archived</option>
            <option value="all">All</option>
          </select>
          {(kind === 'storages' || user.role === 1) && (
            <button className="button primary" onClick={() => setCreating(true)}>
              <Plus size={16} />
              Create {kind === 'counters' ? 'counter' : 'storage'}
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
          <Loading />
        ) : collection.isError ? (
          <ErrorState error={collection.error} />
        ) : (
          <AdministrationCollectionTable
            key={`${kind}:${storeId}`}
            ownerId={user.id}
            view={view}
            collection={collection}
            search=""
            active={status}
            storeId={storeId}
            columns={[
              {
                key: 'id',
                label: 'ID',
                sort: 'id',
                value: (row: z.infer<typeof storageSchema>) => row.id,
              },
              { key: 'storeId', label: 'Store ID', value: (row) => row.storeId },
              { key: 'name', label: 'Name', sort: 'name', value: (row) => row.name },
              { key: 'type', label: 'Type', sort: 'type', value: (row) => row.type },
              {
                key: 'description',
                label: 'Description',
                sort: 'description',
                value: (row) => row.description,
              },
              {
                key: 'active',
                label: 'Status',
                sort: 'active',
                value: (row) => (row.active ? 'Active' : 'Archived'),
              },
            ]}
            actions={(row) => (
              <>
                {kind === 'storages' && row.active && (
                  <button className="button secondary" onClick={() => setEditingStorage(row)}>
                    Edit
                  </button>
                )}
                <button
                  className="button secondary"
                  onClick={() => void toggle(row.id, row.active)}
                >
                  {row.active ? 'Archive' : 'Activate'}
                </button>
              </>
            )}
          />
        )}
      </section>
      <TerminalAdministration user={user} storeId={storeId} />
      {(creating || editingStorage) && (
        <AdministrationEditor
          key={kind}
          title={
            editingStorage
              ? 'Edit storage'
              : `Create ${kind === 'counters' ? 'a counter' : 'storage'}`
          }
          fields={fields}
          initialValues={{
            name: editingStorage?.name || '',
            description: editingStorage?.description || '',
            destinationStoreId: editingStorage?.storeId || storeId,
          }}
          onClose={() => {
            setCreating(false);
            setEditingStorage(null);
          }}
          onSave={async (values) => {
            await mutateAdministration(
              editingStorage ? `${path}/storages/${editingStorage.id}` : `${path}/${kind}`,
              editingStorage ? 'PUT' : 'POST',
              kind === 'counters'
                ? { description: values.description }
                : {
                    name: values.name,
                    description: values.description,
                    type: 'STORAGE',
                    ...(editingStorage ? { destinationStoreId: values.destinationStoreId } : {}),
                  },
              user.id,
            );
            setMessage(
              editingStorage
                ? 'Storage updated.'
                : kind === 'counters'
                  ? 'Counter created.'
                  : 'Storage created.',
            );
            await changed();
          }}
        />
      )}
    </>
  );
}
