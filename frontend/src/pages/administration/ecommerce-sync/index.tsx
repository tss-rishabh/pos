import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { Principal } from '../../../api/types';
import { request } from '../../../api/client';
import { Empty, ErrorState, Loading } from '../../../components/common';
import { useOnline } from '../../../hooks/use-pos';
import { AdministrationEditor } from '../editor';
import { ecommerceSettingSchema } from '../settings-api';

const resultSchema = z.object({ status: z.literal('success'), message: z.string() });

/**
 * Legacy `PosEcomSetting` / `AjaxEcomSettingUpdate` (`core/views.py:2083-2167`): threshold and
 * availability per store; a change starts the background inventory sync.
 */
export function EcommerceDeliveryAdministration(props: { user: Principal; storeId: string }) {
  if (!props.storeId) return <Empty title="Choose a store to manage e-commerce delivery" />;
  return <EcommerceEditor key={props.user.id + ':' + props.storeId} {...props} />;
}
function EcommerceEditor({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    client = useQueryClient(),
    [editing, setEditing] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState<unknown>(null);
  const operation = useRef<{ key: string; id: string } | null>(null);
  const path = `/api/v1/admin/stores/${storeId}/ecommerce-settings`;
  const settings = useQuery({
    queryKey: [user.id, 'administration', storeId, 'ecommerce-settings'],
    enabled: online,
    queryFn: ({ signal }) => request(path, { operatorId: user.id, signal }, ecommerceSettingSchema),
  });
  const lockedUntil = settings.data?.lockedUntil,
    coolingDown = !!lockedUntil && Date.parse(lockedUntil) > Date.now();
  return (
    <>
      <div className="administration-heading administration-section-gap">
        <h2>E-commerce delivery</h2>
      </div>
      {message && (
        <p role="status" className="administration-status">
          {message}
        </p>
      )}
      {error !== null && <ErrorState error={error} />}
      <section className="surface">
        {settings.isPending ? (
          <Loading />
        ) : settings.isError ? (
          <ErrorState error={settings.error} />
        ) : (
          <>
            <div className="administration-heading">
              <div>
                <strong>{settings.data.name}</strong>
                <p>
                  {settings.data.active ? 'Open' : 'Closed'} · Stock threshold{' '}
                  {settings.data.threshold}
                </p>
              </div>
              <button
                className="button secondary"
                disabled={!online || coolingDown || !settings.data.editable}
                onClick={() => setEditing(true)}
              >
                Edit e-commerce delivery
              </button>
            </div>
            {!settings.data.editable && (
              <p className="administration-notice">E-commerce updates are unavailable.</p>
            )}
            {coolingDown && (
              <p className="administration-notice">
                Another update is available after {new Date(lockedUntil).toLocaleTimeString()}.
              </p>
            )}
          </>
        )}
      </section>
      {editing && settings.data && (
        <AdministrationEditor
          title="Edit e-commerce delivery"
          fields={[
            {
              name: 'threshold',
              label: 'Delivery stock threshold',
              kind: 'number',
              required: true,
            },
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
          ]}
          initialValues={{
            threshold: String(settings.data.threshold),
            active: String(settings.data.active),
          }}
          onClose={() => setEditing(false)}
          onSave={async (values) => {
            const body = {
              expectedVersion: settings.data.version,
              threshold: Number(values.threshold),
              active: values.active === 'true',
            };
            const key = JSON.stringify(body);
            if (operation.current?.key !== key)
              operation.current = { key, id: crypto.randomUUID() };
            const result = await request(
              path,
              {
                method: 'PUT',
                operatorId: user.id,
                body: JSON.stringify({ ...body, operationId: operation.current.id }),
              },
              resultSchema,
            );
            operation.current = null;
            setMessage(result.message);
            setError(null);
            setEditing(false);
            await client.invalidateQueries({
              queryKey: [user.id, 'administration', storeId, 'ecommerce-settings'],
            });
          }}
        />
      )}
    </>
  );
}
