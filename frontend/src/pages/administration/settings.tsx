import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { Empty, ErrorState, Loading } from '../../components/common';
import { commonStoreSchema, mutateAdministration } from './api';
import { AdministrationEditor, type AdministrationField } from './editor';
import {
  bufferDuration,
  deliverySlotSchema,
  ecommerceSettingSchema,
  generalSettingSchema,
  type DeliverySlot,
  type EcommerceSetting,
  type GeneralSetting,
} from './settings-api';

const weekdays = [
  ['MON', 'Monday'],
  ['TUE', 'Tuesday'],
  ['WED', 'Wednesday'],
  ['THU', 'Thursday'],
  ['FRI', 'Friday'],
  ['SAT', 'Saturday'],
  ['SUN', 'Sunday'],
] as const;
const slotFields: AdministrationField[] = [
  {
    name: 'weekday',
    label: 'Day',
    kind: 'select',
    required: true,
    options: weekdays.map(([value, label]) => ({ value, label })),
  },
  { name: 'start', label: 'Opening time', kind: 'time', required: true },
  { name: 'end', label: 'Closing time', kind: 'time', required: true },
];
type Editor =
  | { kind: 'new-slot' }
  | { kind: 'slot'; value: DeliverySlot }
  | { kind: 'setting'; value: GeneralSetting }
  | { kind: 'ecommerce'; value: EcommerceSetting };
const settingName = (setting: GeneralSetting) =>
  setting.name === 'HYPERLOCAL_STOCK_THRESHOLD'
    ? 'Delivery stock threshold'
    : 'Order creation buffer (hours:minutes)';
export function StoreSettingsAdministration({
  user,
  storeId,
}: {
  user: Principal;
  storeId: string;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<Editor | null>(null),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [clock, setClock] = useState(() => Date.now());
  const operation = useRef<{ key: string; id: string } | null>(null);
  function operationId(payload: unknown) {
    const key = JSON.stringify(payload);
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    return operation.current.id;
  }
  const settings = useQuery({
    queryKey: [user.id, 'administration', 'general-settings'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/admin/general-settings',
        { operatorId: user.id, signal },
        z.object({ data: z.array(generalSettingSchema) }),
      ),
  });
  const slots = useQuery({
    queryKey: [user.id, 'administration', storeId, 'delivery-slots'],
    enabled: !!storeId,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/admin/stores/${storeId}/delivery-slots`,
        { operatorId: user.id, signal },
        z.object({ data: z.array(deliverySlotSchema) }),
      ),
  });
  const stores = useQuery({
    queryKey: [user.id, 'administration', 'timing-stores'],
    enabled: editing?.kind === 'slot',
    queryFn: ({ signal }) =>
      request(
        '/api/v1/stores',
        { operatorId: user.id, signal },
        z.object({ data: z.array(commonStoreSchema) }),
      ),
  });
  const ecommerce = useQuery({
    queryKey: [user.id, 'administration', storeId, 'ecommerce-settings'],
    enabled: user.role === 1 && !!storeId,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/admin/stores/${storeId}/ecommerce-settings`,
        { operatorId: user.id, signal },
        ecommerceSettingSchema,
      ),
  });
  const lockedUntil = ecommerce.data?.lockedUntil;
  useEffect(() => {
    const expiry = lockedUntil ? Date.parse(lockedUntil) : 0;
    if (expiry <= clock) return;
    const timeout = setTimeout(
      () => setClock(Date.now()),
      Math.min(expiry - Date.now() + 100, 3_600_000),
    );
    return () => clearTimeout(timeout);
  }, [lockedUntil, clock]);
  const coolingDown = !!lockedUntil && Date.parse(lockedUntil) > clock;
  const slotRows = slots.data?.data || [];
  const anyAvailable = slotRows.some((slot) => slot.available === 1);
  const refresh = () => client.invalidateQueries({ queryKey: [user.id] });
  async function availability(slot?: DeliverySlot) {
    setBusy(true);
    try {
      const body = slot
        ? { expectedVersion: slot.version, active: slot.available !== 1 }
        : {
            expectedSlots: slotRows.map(({ id, version }) => ({ id, version })),
            active: !anyAvailable,
          };
      const path = slot
        ? `/api/v1/admin/stores/${storeId}/delivery-slots/${slot.id}/availability`
        : `/api/v1/admin/stores/${storeId}/delivery-slots/availability`;
      await mutateAdministration(
        path,
        'PATCH',
        {
          ...body,
          operationId: operationId({ path, body }),
        },
        user.id,
      );
      setMessage('Delivery availability saved.');
      setError(null);
      await refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  let title = '',
    fields: AdministrationField[] = [],
    initialValues: Record<string, string> = {};
  if (editing?.kind === 'new-slot' || editing?.kind === 'slot') {
    title = editing.kind === 'new-slot' ? 'Add delivery timings' : 'Edit delivery timings';
    fields = [...slotFields];
    initialValues =
      editing.kind === 'new-slot'
        ? { weekday: 'MON', start: '09:00', end: '22:00' }
        : {
            weekday: editing.value.weekday,
            start: editing.value.start,
            end: editing.value.end,
            destinationStoreId: storeId,
          };
    if (editing.kind === 'slot')
      fields.push({
        name: 'destinationStoreId',
        label: 'Store',
        kind: 'select',
        required: true,
        options: (stores.data?.data || [{ id: storeId, name: 'Current store' }]).map((store) => ({
          value: store.id,
          label: store.name,
        })),
      });
  } else if (editing?.kind === 'setting') {
    title = settingName(editing.value);
    fields = [
      {
        name: 'value',
        label: title,
        kind: editing.value.name === 'HYPERLOCAL_STOCK_THRESHOLD' ? 'number' : 'text',
        required: true,
        maxLength: 10,
      },
    ];
    initialValues = {
      value:
        editing.value.name === 'HYPERLOCAL_STOCK_THRESHOLD'
          ? editing.value.value
          : bufferDuration(editing.value.value),
    };
  } else if (editing?.kind === 'ecommerce') {
    title = 'Edit e-commerce delivery';
    fields = [
      { name: 'threshold', label: 'Delivery stock threshold', kind: 'number', required: true },
      {
        name: 'active',
        label: 'Delivery availability',
        kind: 'select',
        required: true,
        options: [
          { value: 'true', label: 'Open' },
          { value: 'false', label: 'Closed' },
        ],
      },
    ];
    initialValues = {
      threshold: String(editing.value.threshold),
      active: String(editing.value.active),
    };
  }
  return (
    <>
      <div className="administration-heading">
        <h2>Order settings</h2>
      </div>
      {message && (
        <div role="status" className="administration-status">
          {message}
        </div>
      )}
      {error !== null && <ErrorState error={error} />}
      <section className="surface">
        {settings.isPending ? (
          <Loading />
        ) : settings.isError ? (
          <ErrorState error={settings.error} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Value</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {settings.data.data.map((setting) => (
                  <tr key={setting.name}>
                    <td>{settingName(setting)}</td>
                    <td>
                      {setting.name === 'HYPERLOCAL_STOCK_THRESHOLD'
                        ? setting.value
                        : bufferDuration(setting.value)}
                    </td>
                    <td>
                      <button
                        className="button secondary"
                        disabled={!setting.editable || busy}
                        onClick={() => setEditing({ kind: 'setting', value: setting })}
                      >
                        Edit
                      </button>
                      {!setting.editable && (
                        <small>
                          {setting.configured
                            ? ' Editing is currently unavailable.'
                            : ' Not configured.'}
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="administration-heading administration-section-gap">
        <h2>Delivery timings</h2>
        <div className="administration-actions">
          {slotRows.length > 0 && (
            <button
              className="button secondary"
              disabled={busy || slotRows.some((slot) => !slot.availabilityEditable)}
              onClick={() => void availability()}
            >
              {anyAvailable ? 'Close all slots' : 'Open all slots'}
            </button>
          )}
          <button
            className="button primary"
            disabled={!storeId || busy}
            onClick={() => setEditing({ kind: 'new-slot' })}
          >
            Add delivery timings
          </button>
        </div>
      </div>
      <section className="surface">
        {!storeId ? (
          <Empty title="Choose a store to view delivery timings" />
        ) : slots.isPending ? (
          <Loading />
        ) : slots.isError ? (
          <ErrorState error={slots.error} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>From</th>
                  <th>Until</th>
                  <th>Availability</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {slotRows.map((slot) => (
                  <tr key={slot.id}>
                    <td>{slot.weekday}</td>
                    <td>{slot.start}</td>
                    <td>{slot.end}</td>
                    <td>{slot.available === 1 ? 'Available' : 'Unavailable'}</td>
                    <td>
                      <div className="administration-table-actions">
                        <button
                          className="button secondary"
                          disabled={!slot.editable || busy}
                          onClick={() => setEditing({ kind: 'slot', value: slot })}
                        >
                          Edit
                        </button>
                        <button
                          className="button secondary"
                          disabled={!slot.availabilityEditable || busy}
                          onClick={() => void availability(slot)}
                        >
                          {slot.available === 1 ? 'Close' : 'Open'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!slotRows.length && <Empty title="No delivery timings configured" />}
          </div>
        )}
      </section>
      {user.role === 1 && (
        <>
          <div className="administration-heading administration-section-gap">
            <h2>E-commerce delivery</h2>
          </div>
          <section className="surface">
            {!storeId ? (
              <Empty title="Choose a store to manage e-commerce delivery" />
            ) : ecommerce.isPending ? (
              <Loading />
            ) : ecommerce.isError ? (
              <ErrorState error={ecommerce.error} />
            ) : (
              <>
                <div className="administration-heading">
                  <div>
                    <strong>{ecommerce.data.name}</strong>
                    <p>
                      {ecommerce.data.active ? 'Open' : 'Closed'} · Stock threshold{' '}
                      {ecommerce.data.threshold}
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    disabled={!ecommerce.data.editable || coolingDown || busy}
                    onClick={() => setEditing({ kind: 'ecommerce', value: ecommerce.data })}
                  >
                    Edit e-commerce delivery
                  </button>
                </div>
                {!ecommerce.data.editable && (
                  <p className="administration-notice">
                    E-commerce updates require inventory synchronization to be enabled.
                  </p>
                )}
                {coolingDown && (
                  <p className="administration-notice">
                    Another update is available after {new Date(lockedUntil!).toLocaleTimeString()}.
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}
      {editing && (
        <AdministrationEditor
          key={JSON.stringify(editing)}
          title={title}
          fields={fields}
          initialValues={initialValues}
          onClose={() => {
            setEditing(null);
            operation.current = null;
          }}
          onSave={async (values) => {
            let path: string,
              body: Record<string, unknown>,
              method: 'POST' | 'PUT' = 'PUT';
            if (editing.kind === 'new-slot') {
              path = `/api/v1/admin/stores/${storeId}/delivery-slots`;
              method = 'POST';
              body = { weekday: values.weekday, start: values.start, end: values.end };
            } else if (editing.kind === 'slot') {
              path = `/api/v1/admin/stores/${storeId}/delivery-slots/${editing.value.id}`;
              body = {
                expectedVersion: editing.value.version,
                destinationStoreId: values.destinationStoreId,
                weekday: values.weekday,
                start: values.start,
                end: values.end,
              };
            } else if (editing.kind === 'setting') {
              const threshold = editing.value.name === 'HYPERLOCAL_STOCK_THRESHOLD';
              path = `/api/v1/admin/general-settings/${threshold ? 'delivery-stock-threshold' : 'order-creation-buffer'}`;
              body = {
                expectedVersion: editing.value.version,
                value: threshold ? Number(values.value) : values.value,
              };
            } else {
              path = `/api/v1/admin/stores/${storeId}/ecommerce-settings`;
              body = {
                expectedVersion: editing.value.version,
                threshold: Number(values.threshold),
                active: values.active === 'true',
              };
            }
            await mutateAdministration(
              path,
              method,
              editing.kind === 'new-slot'
                ? body
                : { ...body, operationId: operationId({ path, body }) },
              user.id,
            );
            setMessage('Settings saved. Changes may take a moment to appear elsewhere.');
            setError(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}
