import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { errorRequestId, request } from '../../api/client';
import { RequestReference, useProblem } from '../../components/common';
import { Modal } from '../../components/modal';
import { useOnline } from '../../hooks/use-pos';
import {
  AdministrationFormError,
  mutateAdministration,
  submitAdministrationForm,
  type AdministrationStore,
} from './api';
import { postalCodeFields } from './locations';
import { SlackConnectButton } from './slack';
import { StoreImagePreview, uploadStoreImage } from './store-images';

type Values = Record<string, string>;
const storeTypes = ['STORE', 'WAREHOUSE', 'CORE_WAREHOUSE', 'BUBBLE_STORE'];
/** Blank value as `_form.html` renders it (`{% if value %}`: 0 and None show empty). */
const shown = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === 0 || value === '' ? '' : String(value);
function initialValues(store?: AdministrationStore): Values {
  return {
    category: store?.category || 'IN_HOUSE',
    franchise_name: store?.franchise?.name || '',
    franchise_description: store?.franchise?.description || '',
    cin_number: store?.franchise?.cin || '',
    store_name: store?.name || '',
    short_name: store?.shortName || '',
    location_code: store?.locationCode || '',
    type: store?.type || 'STORE',
    email: store?.email || '',
    phone: store?.phone || '',
    latitude: shown(store?.latitude),
    longitude: shown(store?.longitude),
    pincode: store?.pincode || '',
    city_name: store?.city || '',
    // The shared legacy partial hard-codes city_id 1111 for create and edit (`_form.html:200`).
    city_id: '1111',
    state_name: store?.state || '',
    state_id: shown(store?.stateId),
    country_name: store?.countryName || '',
    country_id: store ? String(store.countryId) : '',
    address: store?.address || '',
    alt_address: store?.alternateAddress || '',
    gstin: store?.gstin || '',
    slack_group_url: store?.slackGroupUrl || '',
    per_day_threshold: shown(store?.dailyThreshold),
    per_hour_threshold: shown(store?.hourlyThreshold),
  };
}
const posted = [
  'category',
  'franchise_name',
  'franchise_description',
  'cin_number',
  'store_name',
  'short_name',
  'location_code',
  'type',
  'email',
  'phone',
  'latitude',
  'longitude',
  'pincode',
  'city_name',
  'city_id',
  'state_name',
  'state_id',
  'country_id',
  'address',
  'alt_address',
  'gstin',
  'slack_group_url',
  'per_day_threshold',
  'per_hour_threshold',
] as const;

/** Legacy store create/edit page (`stores/templates/stores/_form.html`, `create.html`, `edit.html`). */
export function StoreForm({
  user,
  store,
  onClose,
  onSaved,
}: {
  user: Principal;
  store?: AdministrationStore;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const formId = useId(),
    lookup = useRef<AbortController | null>(null),
    client = useQueryClient(),
    online = useOnline(),
    [values, setValues] = useState<Values>(() => initialValues(store)),
    [image, setImage] = useState<File | null>(null),
    [errors, setErrors] = useState<Record<string, string[]>>({}),
    [failure, setFailure, failureCause, reportFailure] = useProblem(),
    [imageCause, setImageCause] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const locations = useQuery({
    queryKey: [user.id, 'administration', 'location-codes'],
    queryFn: () =>
      request(
        '/api/v1/admin/store-location-codes',
        { operatorId: user.id },
        z.object({ data: z.array(z.string()) }),
      ),
  });
  useEffect(
    () => () => {
      lookup.current?.abort();
    },
    [],
  );
  const set = (name: string, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));
  /** `create.html:186-216`: look up 6-character PIN codes after 400 ms on keyup/blur. */
  useEffect(() => {
    const pincode = values.pincode?.trim() || '';
    if (pincode.length !== 6) return;
    const timer = setTimeout(() => {
      lookup.current?.abort();
      const controller = new AbortController();
      lookup.current = controller;
      void postalCodeFields(user.id, pincode, controller.signal)
        .then((patch) => {
          if (patch && !controller.signal.aborted)
            setValues((current) => ({ ...current, ...patch }));
        })
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [values.pincode, user.id]);
  async function submit() {
    setBusy(true);
    setFailure('');
    setErrors({});
    setImageCause(null);
    try {
      const body: Record<string, string> = {};
      for (const name of posted) body[name] = values[name] ?? '';
      if (image) {
        try {
          body.store_image = await uploadStoreImage(
            image,
            user.id,
            store?.id,
            AbortSignal.timeout(180000),
          );
        } catch (error) {
          setImageCause(error);
          setErrors({ store_image: [error instanceof Error ? error.message : 'Upload failed.'] });
          return;
        }
      }
      const result = await submitAdministrationForm(
        store ? `/api/v1/admin/stores/${store.id}` : '/api/v1/admin/stores',
        store ? 'PUT' : 'POST',
        body,
        user.id,
      );
      await client.invalidateQueries({ queryKey: [user.id, 'administration', 'store-image'] });
      await onSaved(
        result.message || (store ? 'Store has been updated!' : 'Store has been created!'),
      );
      onClose();
    } catch (error) {
      if (error instanceof AdministrationFormError) setErrors(error.fields);
      else reportFailure(error, 'The store could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  const field = (name: string, label: string, control: ReactNode) => (
    <label key={name}>
      {label}
      {control}
      {errors[name]?.length ? (
        <ul className="errorlist">
          {errors[name].map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {name === 'store_image' && <RequestReference error={imageCause} />}
    </label>
  );
  const input = (
    name: string,
    label: string,
    placeholder: string,
    options: { readOnly?: boolean; type?: string } = {},
  ) =>
    field(
      name,
      label,
      <input
        aria-label={label}
        type={options.type || 'text'}
        name={name}
        placeholder={placeholder}
        readOnly={options.readOnly}
        value={values[name] || ''}
        onChange={(event) => set(name, event.target.value)}
      />,
    );
  return (
    <Modal
      title={store ? 'Edit Store' : 'Create Store'}
      size="lg"
      closeLabel="Close editor"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="button primary"
            disabled={busy || !online}
            aria-busy={busy}
          >
            {busy ? 'Saving…' : 'Submit'}
          </button>
        </>
      }
    >
      {store && <StoreImagePreview operatorId={user.id} storeId={store.id} />}
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && online) void submit();
        }}
      >
        <fieldset className="administration-access-fieldset" disabled={busy}>
          <div className="administration-fields">
            {field(
              'category',
              'Store Category',
              <select
                aria-label="Store Category"
                value={values.category}
                onChange={(event) => set('category', event.target.value)}
              >
                <option value="IN_HOUSE">IN_HOUSE</option>
                <option value="FRANCHISE">FRANCHISE</option>
              </select>,
            )}
            {values.category === 'FRANCHISE' && (
              <>
                {input('franchise_name', 'Franchise Name', 'Enter Franchise Name')}
                {input('franchise_description', 'Franchise Description', 'Enter Description')}
                {input('cin_number', 'CIN Number', 'Enter CIN Number')}
              </>
            )}
            {input('store_name', 'Store Name', 'Enter Store Name...')}
            {input('short_name', 'Store Short Name', 'Enter Store Short Name...')}
            {field(
              'location_code',
              'Location Code',
              <select
                aria-label="Location Code"
                value={values.location_code}
                onChange={(event) => set('location_code', event.target.value)}
              >
                <option value="">Select Location Code</option>
                {(locations.data?.data || []).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>,
            )}
            {field(
              'type',
              'Store Type',
              <select
                aria-label="Store Type"
                value={values.type}
                onChange={(event) => set('type', event.target.value)}
              >
                <option value="">Select Store Type</option>
                {storeTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>,
            )}
            {input('email', 'Email', 'Enter Email', { type: 'email' })}
            {input('phone', 'Phone', 'Enter Phone Number...', { type: 'tel' })}
            {input('latitude', 'Latitude', 'Enter Latitude...')}
            {input('longitude', 'Longitude', 'Enter longitude...')}
            {input('pincode', 'Pincode', 'Enter Pincode')}
            {input('city_name', 'City', 'City Name', { readOnly: true })}
            {input('state_name', 'State', 'State Name', { readOnly: true })}
            {field(
              'country_id',
              'Country',
              <input
                aria-label="Country"
                value={values.country_name || ''}
                placeholder="Country Name"
                disabled
              />,
            )}
            {input('address', 'Address', 'Enter Address...')}
            {input('alt_address', 'Secondory Address', 'Enter Address ...')}
            {input('gstin', 'GSTIN', 'Enter GSTIN ...')}
            {field(
              'slack_group_url',
              'Slack Group URL',
              <>
                <input
                  aria-label="Slack Group URL"
                  value={values.slack_group_url || ''}
                  placeholder="Enter Slack Group URL ..."
                  onChange={(event) => set('slack_group_url', event.target.value)}
                />
                <SlackConnectButton
                  connected={Boolean(store?.slackGroupUrl)}
                  disabled={busy || !online}
                  onConnected={(url) => set('slack_group_url', url)}
                />
              </>,
            )}
            {input('per_day_threshold', 'Per Day Threshold', 'Enter Per Day Threshold...')}
            {input('per_hour_threshold', 'Per Hour Threshold', 'Enter Per Hour Threshold...')}
            {field(
              'store_image',
              'Store Image',
              <input
                aria-label="Store Image"
                type="file"
                accept="image/*"
                onChange={(event) => setImage(event.target.files?.[0] ?? null)}
              />,
            )}
          </div>
        </fieldset>
        {Object.keys(errors).length > 0 && (
          <div className="inline-error" role="alert">
            Please correct the errors below.
          </div>
        )}
        {failure && (
          <div className="inline-error" role="alert">
            {failure}
            <RequestReference error={failureCause} />
          </div>
        )}
      </form>
      {!store && [1, 3].includes(user.role) && <AddLocationCode user={user} />}
    </Modal>
  );
}

/** Legacy "Add store location code" card of the create page (`create.html:17-35`, `:137-178`). */
function AddLocationCode({ user }: { user: Principal }) {
  const client = useQueryClient(),
    [code, setCode] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="surface administration-location-code">
      <p>Didn&apos;t find the desired Location Code in the dropdown above?</p>
      <input
        aria-label="New Location Code"
        maxLength={4}
        placeholder="Enter new Location Code"
        value={code}
        disabled={busy}
        onChange={(event) => setCode(event.target.value)}
      />
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          if (!code.trim()) {
            window.alert('Please enter a Location Code.');
            return;
          }
          setBusy(true);
          void mutateAdministration('/api/v1/admin/store-location-codes', 'POST', { code }, user.id)
            .then(async () => {
              window.alert('Location Code added successfully!');
              setCode('');
              await client.invalidateQueries({
                queryKey: [user.id, 'administration', 'location-codes'],
              });
            })
            .catch((error: unknown) => {
              const reference = errorRequestId(error);
              window.alert(
                `${error instanceof Error ? error.message : 'Error adding Location Code.'}${reference ? ` (Reference ${reference})` : ''}`,
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Adding...' : 'Add New Location Code'}
      </button>
    </section>
  );
}
