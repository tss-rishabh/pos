import { AdministrationCollectionTable, useAdministrationView } from './collection-table';
import { StoreDetailDialog } from './store-detail';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import { AdministrationEditor, type AdministrationField } from './editor';
import { StoreImageDialog } from './store-images';
import { postalCodeFields } from './locations';
import { StoreSlackButton } from './slack';
import {
  mutateAdministration,
  storeSchema,
  useAdministrationCollection,
  administrationIdentifier,
  type AdministrationStore,
} from './api';

const typeChoices = ['STORE', 'WAREHOUSE', 'CORE_WAREHOUSE', 'BUBBLE_STORE'].map((value) => ({
  value,
  label: value.replaceAll('_', ' '),
}));
const baseFields: AdministrationField[] = [
  { name: 'name', label: 'Store name', required: true, maxLength: 100 },
  { name: 'shortName', label: 'Short name', required: true, maxLength: 100 },
  { name: 'type', label: 'Store type', kind: 'select', options: typeChoices, required: true },
  {
    name: 'category',
    label: 'Ownership',
    kind: 'select',
    options: [
      { value: 'IN_HOUSE', label: 'In house' },
      { value: 'FRANCHISE', label: 'Franchise' },
    ],
    required: true,
  },
  { name: 'phone', label: 'Store phone', kind: 'tel', required: true, maxLength: 10 },
  { name: 'email', label: 'Store email', kind: 'email', maxLength: 55 },
  { name: 'latitude', label: 'Latitude', required: true, maxLength: 22 },
  { name: 'longitude', label: 'Longitude', required: true, maxLength: 22 },
  { name: 'address', label: 'Address', kind: 'textarea', required: true, maxLength: 500 },
  { name: 'alternateAddress', label: 'Alternate address', kind: 'textarea', maxLength: 500 },
  { name: 'city', label: 'City', maxLength: 255 },
  { name: 'state', label: 'State', maxLength: 255 },
  { name: 'stateId', label: 'State reference', kind: 'number' },
  { name: 'pincode', label: 'PIN code', maxLength: 10 },
  { name: 'gstin', label: 'GSTIN', maxLength: 15 },
  { name: 'dailyThreshold', label: 'Daily order capacity', kind: 'number' },
  { name: 'hourlyThreshold', label: 'Hourly order capacity', kind: 'number' },
  {
    name: 'slackUrl',
    label: 'New Slack webhook (leave empty to keep)',
    kind: 'password',
    maxLength: 1000,
  },
  {
    name: 'removeSlack',
    label: 'Slack connection',
    kind: 'select',
    options: [
      { value: 'false', label: 'Keep current or use replacement' },
      { value: 'true', label: 'Remove connection' },
    ],
  },
  {
    name: 'franchiseMode',
    label: 'Franchise association',
    kind: 'select',
    options: [
      { value: 'existing', label: 'Associate an existing franchise' },
      { value: 'details', label: 'Create or edit franchise details' },
    ],
    when: { field: 'category', value: 'FRANCHISE' },
  },
  {
    name: 'franchiseName',
    label: 'Franchise name',
    required: true,
    whenAll: [
      { field: 'category', value: 'FRANCHISE' },
      { field: 'franchiseMode', value: 'details' },
    ],
  },
  {
    name: 'franchiseDescription',
    label: 'Franchise description',
    kind: 'textarea',
    whenAll: [
      { field: 'category', value: 'FRANCHISE' },
      { field: 'franchiseMode', value: 'details' },
    ],
  },
  {
    name: 'franchiseCin',
    label: 'Franchise CIN',
    maxLength: 100,
    whenAll: [
      { field: 'category', value: 'FRANCHISE' },
      { field: 'franchiseMode', value: 'details' },
    ],
  },
];
function formValues(store?: AdministrationStore): Record<string, string> {
  return {
    name: store?.name || '',
    shortName: store?.shortName || '',
    locationCode: store?.locationCode || '',
    type: store?.type || 'STORE',
    category: store?.category || 'IN_HOUSE',
    phone: store?.phone || '',
    email: store?.email || '',
    latitude: store?.latitude || '0',
    longitude: store?.longitude || '0',
    address: store?.address || '',
    alternateAddress: store?.alternateAddress || '',
    city: store?.city || '',
    state: store?.state || '',
    cityId: String(store?.cityId ?? 1111),
    stateId: String(store?.stateId || 0),
    countryId: String(store?.countryId || 0),
    pincode: store?.pincode || '',
    gstin: store?.gstin || '',
    dailyThreshold: String(store?.dailyThreshold || 0),
    hourlyThreshold: String(store?.hourlyThreshold || 0),
    slackUrl: '',
    removeSlack: 'false',
    franchiseName: store?.franchise?.name || '',
    franchiseMode: store?.franchise?.id ? 'existing' : 'details',
    franchiseId: store?.franchise?.id || '',
    franchiseDescription: store?.franchise?.description || '',
    franchiseCin: store?.franchise?.cin || '',
  };
}
function storeBody(values: Record<string, string>, imagePath?: string) {
  return {
    name: values.name,
    shortName: values.shortName,
    locationCode: values.locationCode,
    type: values.type,
    category: values.category,
    phone: values.phone,
    email: values.email,
    latitude: values.latitude,
    longitude: values.longitude,
    address: values.address,
    alternateAddress: values.alternateAddress,
    city: values.city,
    state: values.state,
    cityId: Number(values.cityId),
    stateId: Number(values.stateId),
    countryId: Number(values.countryId),
    pincode: values.pincode,
    gstin: values.gstin,
    dailyThreshold: Number(values.dailyThreshold),
    hourlyThreshold: Number(values.hourlyThreshold),
    slackUrl: values.slackUrl,
    removeSlack: values.removeSlack === 'true',
    ...(imagePath ? { imagePath } : {}),
    ...(values.category === 'FRANCHISE'
      ? {
          ...(values.franchiseMode === 'existing'
            ? { franchiseId: values.franchiseId }
            : {
                franchise: {
                  name: values.franchiseName,
                  description: values.franchiseDescription,
                  cin: values.franchiseCin,
                },
              }),
        }
      : {}),
  };
}
export function StoreAdministration({ user }: { user: Principal }) {
  const view = useAdministrationView('stores', user.id),
    [viewing, setViewing] = useState<string | null>(null);
  const client = useQueryClient(),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('true'),
    [editing, setEditing] = useState<AdministrationStore | 'new' | null>(null),
    [imageStore, setImageStore] = useState<AdministrationStore | null>(null),
    [addingLocation, setAddingLocation] = useState(false),
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
  const franchises = useAdministrationCollection(
    user.id,
    [1, 3].includes(user.role) ? '/api/v1/admin/franchises' : '',
    z.object({
      id: administrationIdentifier,
      name: z.string(),
      description: z.string().nullable(),
      cin: z.string().nullable(),
    }),
    '',
    'all',
  );
  const locations = useQuery({
    queryKey: [user.id, 'administration', 'location-codes'],
    queryFn: () =>
      request(
        '/api/v1/admin/store-location-codes',
        { operatorId: user.id },
        z.object({ data: z.array(z.string()) }),
      ),
  });
  const countries = useQuery({
    queryKey: [user.id, 'administration', 'countries'],
    queryFn: () =>
      request(
        '/api/v1/admin/countries',
        { operatorId: user.id },
        z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }),
      ),
  });
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
      setMessage(store.active ? 'Store archived.' : 'Store activated.');
      await changed();
    } catch (failure) {
      setError(failure);
    }
  }
  const fields: AdministrationField[] = [
    {
      name: 'franchiseId',
      label: 'Existing franchise',
      kind: 'select',
      required: true,
      options: [
        { value: '', label: 'Select a franchise' },
        ...(editing &&
        editing !== 'new' &&
        editing.franchise?.id &&
        !franchises.data?.pages.some((page) =>
          page.data.some((franchise) => franchise.id === editing.franchise?.id),
        )
          ? [{ value: editing.franchise.id, label: editing.franchise.name }]
          : []),
        ...(franchises.data?.pages.flatMap((page) => page.data) || []).map((franchise) => ({
          value: franchise.id,
          label: franchise.name,
        })),
      ],
      whenAll: [
        { field: 'category', value: 'FRANCHISE' },
        { field: 'franchiseMode', value: 'existing' },
      ],
      optionsAction: franchises.hasNextPage
        ? {
            label: 'Load more franchises',
            disabled: franchises.isFetchingNextPage,
            run: () => void franchises.fetchNextPage(),
          }
        : undefined,
    },
    {
      name: 'locationCode',
      label: 'Location code',
      kind: 'select',
      required: true,
      options: [
        { value: '', label: 'Select a location' },
        ...(locations.data?.data || []).map((value) => ({ value, label: value })),
      ],
    },
    ...baseFields.slice(0, 13),
    {
      name: 'countryId',
      label: 'Country',
      kind: 'select',
      required: true,
      options: [
        { value: '0', label: 'Select a country' },
        ...(countries.data?.data || []).map((country) => ({
          value: country.id,
          label: country.name,
        })),
      ],
    },
    ...baseFields.slice(13),
  ];
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
            <option value="true">Active</option>
            <option value="false">Archived</option>
            <option value="all">All stores</option>
          </select>
          {[1, 3].includes(user.role) && (
            <button className="button secondary" onClick={() => setAddingLocation(true)}>
              Add location code
            </button>
          )}
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
      {locations.isError && (
        <ErrorState error={locations.error} retry={() => void locations.refetch()} />
      )}
      {countries.isError && (
        <ErrorState error={countries.error} retry={() => void countries.refetch()} />
      )}
      {franchises.isError && (
        <ErrorState error={franchises.error} retry={() => void franchises.refetch()} />
      )}
      <section className="surface">
        {collection.isPending ? (
          <Loading />
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
              { key: 'id', label: 'ID', sort: 'id', value: (row: AdministrationStore) => row.id },
              { key: 'name', label: 'Store', sort: 'name', value: (row) => row.name },
              {
                key: 'locationCode',
                label: 'Location code',
                sort: 'locationCode',
                value: (row) => row.locationCode,
              },
              { key: 'type', label: 'Type', sort: 'type', value: (row) => row.type },
              {
                key: 'category',
                label: 'Ownership',
                sort: 'category',
                value: (row) => row.category,
              },
              { key: 'phone', label: 'Phone', sort: 'phone', value: (row) => row.phone },
              { key: 'email', label: 'Email', sort: 'email', value: (row) => row.email },
              { key: 'city', label: 'City', sort: 'city', value: (row) => row.city },
              { key: 'state', label: 'State', value: (row) => row.state },
              { key: 'address', label: 'Address', sort: 'address', value: (row) => row.address },
              {
                key: 'alternateAddress',
                label: 'Alternate address',
                value: (row) => row.alternateAddress,
              },
              {
                key: 'pincode',
                label: 'Postal code',
                sort: 'pincode',
                value: (row) => row.pincode,
              },
              { key: 'gstin', label: 'GSTIN', value: (row) => row.gstin },
              { key: 'shortName', label: 'Short name', value: (row) => row.shortName },
              {
                key: 'active',
                label: 'Status',
                sort: 'active',
                value: (row) => (row.active ? 'Active' : 'Archived'),
              },
            ]}
            actions={(store) => (
              <>
                <button className="button secondary" onClick={() => setViewing(store.id)}>
                  Details and QR
                </button>
                {store.active && [1, 3].includes(user.role) && (
                  <StoreSlackButton user={user} storeId={store.id} storeName={store.name} />
                )}
                {store.active && [1, 3].includes(user.role) && (
                  <button className="button secondary" onClick={() => setImageStore(store)}>
                    Image
                  </button>
                )}
                {store.active && [1, 3].includes(user.role) && (
                  <button className="button secondary" onClick={() => void edit(store.id)}>
                    Edit
                  </button>
                )}
                {user.role === 1 && (
                  <button className="button secondary" onClick={() => void toggle(store)}>
                    {store.active ? 'Archive' : 'Activate'}
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
        <AdministrationEditor
          description={
            editing !== 'new' && editing.slackConfigured
              ? 'A Slack connection is configured. Leave the replacement empty to keep it.'
              : 'A Slack incoming webhook can be added without exposing it in store reads.'
          }
          key={editing === 'new' ? 'new' : editing.id}
          title={editing === 'new' ? 'Create a store' : `Edit ${editing.name}`}
          fields={fields.map((field) =>
            field.name === 'pincode'
              ? {
                  ...field,
                  updateAction: {
                    label: 'Look up PIN code',
                    run: (values, signal) =>
                      postalCodeFields(user.id, values.pincode || '', signal),
                  },
                }
              : field,
          )}
          initialValues={formValues(editing === 'new' ? undefined : editing)}
          onClose={() => setEditing(null)}
          onSave={async (values) => {
            await mutateAdministration(
              editing === 'new' ? '/api/v1/admin/stores' : `/api/v1/admin/stores/${editing.id}`,
              editing === 'new' ? 'POST' : 'PUT',
              storeBody(values, editing === 'new' ? undefined : editing.imagePath),
              user.id,
            );
            setMessage(editing === 'new' ? 'Store created.' : 'Store updated.');
            await changed();
          }}
        />
      )}
      {imageStore && (
        <StoreImageDialog
          key={imageStore.id}
          user={user}
          storeId={imageStore.id}
          storeName={imageStore.name}
          onClose={() => setImageStore(null)}
        />
      )}
      {addingLocation && (
        <AdministrationEditor
          title="Add a store location code"
          fields={[
            {
              name: 'code',
              label: 'Location code (1–4 letters or digits)',
              required: true,
              maxLength: 4,
            },
          ]}
          initialValues={{ code: '' }}
          onClose={() => setAddingLocation(false)}
          onSave={async (values) => {
            await mutateAdministration(
              '/api/v1/admin/store-location-codes',
              'POST',
              {
                code: values.code,
              },
              user.id,
            );
            setMessage('Location code added.');
            await changed();
          }}
        />
      )}
    </>
  );
}
