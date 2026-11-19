import { AdministrationCollectionTable, useAdministrationView } from './collection-table';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import { AdministrationEditor } from './editor';
import { TerminalAdministration } from './terminals';
import {
  AdministrationFormError,
  administrationIdentifier,
  counterSchema,
  storageSchema,
  mutateAdministration,
  submitAdministrationForm,
  useAdministrationCollection,
} from './api';

type Resource = z.infer<typeof storageSchema>;
/**
 * Legacy counters and storages pages (`stores/views.py:31-42`, `:350-537`): cross-store lists with
 * the store name, search on name/description, create for an active STORE-type store.
 */
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
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingStorage, setEditingStorage] = useState<Resource | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const counters = useAdministrationCollection(
    user.id,
    kind === 'counters' ? '/api/v1/admin/counters' : '',
    counterSchema,
    search,
    status,
    undefined,
    view.options,
  );
  const storages = useAdministrationCollection(
    user.id,
    kind === 'storages' ? '/api/v1/admin/storages' : '',
    storageSchema,
    search,
    status,
    undefined,
    view.options,
  );
  const stores = useQuery({
    queryKey: [user.id, 'administration', 'resource-stores'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/admin/resource-stores',
        { operatorId: user.id, signal },
        z.object({ data: z.array(z.object({ id: administrationIdentifier, name: z.string() })) }),
      ),
  });
  const collection = kind === 'counters' ? counters : storages;
  const changed = () => client.invalidateQueries({ queryKey: [user.id] });
  async function toggle(row: Resource) {
    try {
      const result = await mutateAdministration(
        `/api/v1/admin/stores/${row.storeId}/${kind}/${row.id}/status`,
        'PATCH',
        { active: !row.active },
        user.id,
      );
      setError(null);
      setMessage(result.message || '');
      await changed();
    } catch (failure) {
      setError(failure);
    }
  }
  const storeOptions = [
    { value: '0', label: 'Select the Store' },
    ...(stores.data?.data || []).map((store) => ({ value: store.id, label: store.name })),
  ];
  return (
    <>
      <div className="administration-heading">
        <h2>{kind === 'counters' ? 'Counters' : 'Storages'}</h2>
        <div className="administration-filters">
          <select
            aria-label="Resource type"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value === 'storages' ? 'storages' : 'counters')
            }
          >
            <option value="counters">Counters</option>
            <option value="storages">Storages</option>
          </select>
          <input
            aria-label="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
          />
          <select
            aria-label="Resource status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="true">Active</option>
            <option value="false">Archived</option>
          </select>
          {(kind === 'storages' || user.role === 1) && (
            <button className="button primary" onClick={() => setCreating(true)}>
              <Plus size={16} />
              {kind === 'counters' ? 'Create Counter' : 'Create Storage'}
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
            key={kind}
            ownerId={user.id}
            view={view}
            collection={collection}
            search={search}
            active={status}
            columns={[
              { key: 'id', label: 'ID', sort: 'id', value: (row: Resource) => row.id },
              { key: 'store', label: 'Store', sort: 'store', value: (row) => row.storeName },
              {
                key: 'name',
                label: kind === 'counters' ? 'Counter Name' : 'Storage Name',
                sort: 'name',
                value: (row) => row.name,
              },
              {
                key: 'type',
                label: kind === 'counters' ? 'Counter Type' : 'Storage Type',
                sort: 'type',
                value: (row) => row.type,
              },
              {
                key: 'description',
                label: 'Description',
                sort: 'description',
                value: (row) => row.description,
              },
            ]}
            actions={(row) => (
              <>
                {kind === 'storages' && row.active && (
                  <button className="button secondary" onClick={() => setEditingStorage(row)}>
                    Edit
                  </button>
                )}
                <button className="button secondary" onClick={() => void toggle(row)}>
                  {row.active ? 'Delete' : 'Activate'}
                </button>
              </>
            )}
          />
        )}
      </section>
      {storeId && <TerminalAdministration user={user} storeId={storeId} />}
      {(creating || editingStorage) && (
        <AdministrationEditor
          key={kind}
          title={
            editingStorage
              ? 'Edit Storage'
              : kind === 'counters'
                ? 'Create Counter'
                : 'Create Storage'
          }
          submitLabel="Submit"
          fields={[
            ...(editingStorage
              ? []
              : [
                  {
                    name: 'store',
                    label: kind === 'counters' ? 'Store' : 'Store name',
                    kind: 'select' as const,
                    required: true,
                    options: storeOptions,
                  },
                ]),
            ...(kind === 'storages'
              ? [
                  { name: 'storage_name', label: 'Storage Name', required: true, maxLength: 100 },
                  {
                    name: 'storage_type',
                    label: 'Storage Type',
                    kind: 'select' as const,
                    required: true,
                    options: [
                      { value: '', label: 'Select Storage Type' },
                      { value: 'STORAGE', label: 'STORAGE' },
                    ],
                  },
                ]
              : []),
            {
              name: 'description',
              label: 'Description',
              kind: 'textarea' as const,
              required: true,
              maxLength: 255,
            },
          ]}
          initialValues={{
            store: storeId || '0',
            storage_name: editingStorage?.name || '',
            storage_type: editingStorage ? 'STORAGE' : '',
            description: editingStorage?.description || '',
          }}
          onClose={() => {
            setCreating(false);
            setEditingStorage(null);
          }}
          onSave={async (values) => {
            if (!editingStorage && (!values.store || values.store === '0'))
              throw new Error(kind === 'counters' ? 'Please select the store' : 'Select the store');
            if (kind === 'counters' && !values.description?.trim())
              throw new Error('Provide a valid message');
            let result;
            try {
              result =
                kind === 'counters'
                  ? await mutateAdministration(
                      `/api/v1/admin/stores/${values.store}/counters`,
                      'POST',
                      { description: values.description },
                      user.id,
                    )
                  : await submitAdministrationForm(
                      editingStorage
                        ? `/api/v1/admin/stores/${editingStorage.storeId}/storages/${editingStorage.id}`
                        : `/api/v1/admin/stores/${values.store}/storages`,
                      editingStorage ? 'PUT' : 'POST',
                      {
                        storage_name: values.storage_name,
                        storage_type: values.storage_type,
                        storage_desc: values.description,
                      },
                      user.id,
                    );
            } catch (failure) {
              if (failure instanceof AdministrationFormError)
                throw new Error(
                  Object.entries(failure.fields)
                    .map(([field, messages]) => `${field}: ${messages.join(' ')}`)
                    .join('\n'),
                );
              throw failure;
            }
            setMessage(result.message || '');
            await changed();
          }}
        />
      )}
    </>
  );
}
