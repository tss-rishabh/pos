import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import { AdministrationEditor, type AdministrationField } from './editor';
import { commonStoreSchema, mutateAdministration } from './api';
import { TerminalDirectory, type TerminalDirectoryRow } from './terminal-directory';

type Provider = 'paytm' | 'pine-labs';
type Target = { provider: Provider; id?: string; storeId?: string };
const baseDetail = {
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  terminalId: z.string(),
  merchantId: z.string(),
};
export const terminalDetailSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('paytm'), ...baseDetail, deviceSerialNumber: z.string() }),
  z.object({
    provider: z.literal('pine-labs'),
    ...baseDetail,
    clientId: z.string(),
    hardwareId: z.string(),
    merchantStorePosCode: z.string(),
  }),
]);
const providerName = (provider: Provider) => (provider === 'paytm' ? 'Paytm' : 'Pine Labs');

function TerminalEditor({
  user,
  storeId,
  target,
  onClose,
  onSaved,
}: {
  user: Principal;
  storeId: string;
  target: Target;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const creating = !target.id;
  const path = `/api/v1/admin/stores/${storeId}/payment-terminals`;
  const detail = useQuery({
    queryKey: [user.id, 'administration', storeId, 'terminal', target.provider, target.id],
    enabled: !creating,
    queryFn: ({ signal }) =>
      request(
        `${path}/${target.provider}/${target.id}`,
        { operatorId: user.id, signal },
        terminalDetailSchema,
      ),
  });
  const nextName = useQuery({
    queryKey: [user.id, 'administration', storeId, 'next-terminal-name', target.provider],
    enabled: creating,
    queryFn: ({ signal }) =>
      request(
        `${path}/next-name?provider=${target.provider}`,
        { operatorId: user.id, signal },
        z.object({ name: z.string() }),
      ),
  });
  const stores = useQuery({
    queryKey: [user.id, 'administration', 'assignable-stores'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/stores',
        { operatorId: user.id, signal },
        z.object({ data: z.array(commonStoreSchema) }),
      ),
  });
  if (!creating && detail.isPending) return <Loading />;
  if (!creating && detail.isError)
    return (
      <>
        <ErrorState error={detail.error} />
        <button className="button secondary" onClick={onClose}>
          Close editor
        </button>
      </>
    );
  const value = detail.data;
  const fields: AdministrationField[] = [
    {
      name: 'merchantId',
      label: target.provider === 'paytm' ? 'Paytm merchant ID' : 'Merchant ID',
      required: true,
      maxLength: target.provider === 'paytm' ? 255 : 45,
    },
    {
      name: 'terminalId',
      label: 'Terminal ID',
      required: true,
      maxLength: target.provider === 'paytm' ? 255 : 45,
    },
    ...(target.provider === 'paytm'
      ? [
          {
            name: 'deviceSerialNumber',
            label: 'Device serial number',
            required: true,
            maxLength: 19,
          },
          {
            name: 'merchantKey',
            label: creating ? 'Merchant key' : 'New merchant key (leave empty to keep)',
            kind: 'password' as const,
            required: creating,
            maxLength: 255,
          },
        ]
      : [
          { name: 'clientId', label: 'Client ID', required: true, maxLength: 45 },
          { name: 'hardwareId', label: 'Hardware ID', required: true, maxLength: 255 },
          {
            name: 'merchantStorePosCode',
            label: 'Merchant store POS code',
            required: true,
            maxLength: 45,
          },
          {
            name: 'securityToken',
            label: creating ? 'Security token' : 'New security token (leave empty to keep)',
            kind: 'password' as const,
            required: creating,
            maxLength: 255,
          },
        ]),
    {
      name: 'active',
      label: 'Status',
      kind: 'select',
      options: [
        { value: 'true', label: 'Active' },
        { value: 'false', label: 'Archived' },
      ],
      required: true,
    },
    ...(!creating
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
  const initialValues = {
    merchantId: value?.merchantId || '',
    terminalId: value?.terminalId || '',
    deviceSerialNumber: value?.provider === 'paytm' ? value.deviceSerialNumber : '',
    clientId: value?.provider === 'pine-labs' ? value.clientId : '',
    hardwareId: value?.provider === 'pine-labs' ? value.hardwareId : '',
    merchantStorePosCode: value?.provider === 'pine-labs' ? value.merchantStorePosCode : '',
    merchantKey: '',
    securityToken: '',
    active: String(value?.active ?? true),
    destinationStoreId: storeId,
  };
  return (
    <AdministrationEditor
      title={`${creating ? 'Create' : 'Edit'} ${providerName(target.provider)} terminal${creating && nextName.data ? ` · ${nextName.data.name}` : value ? ` · ${value.name}` : ''}`}
      fields={fields}
      initialValues={initialValues}
      onClose={onClose}
      onSave={async (values) => {
        const common = {
          provider: target.provider,
          merchantId: values.merchantId,
          terminalId: values.terminalId,
          active: values.active === 'true',
          ...(!creating ? { destinationStoreId: values.destinationStoreId } : {}),
        };
        const body =
          target.provider === 'paytm'
            ? {
                ...common,
                deviceSerialNumber: values.deviceSerialNumber,
                ...(values.merchantKey ? { merchantKey: values.merchantKey } : {}),
              }
            : {
                ...common,
                clientId: values.clientId,
                hardwareId: values.hardwareId,
                merchantStorePosCode: values.merchantStorePosCode,
                ...(values.securityToken ? { securityToken: values.securityToken } : {}),
              };
        await mutateAdministration(
          creating ? path : `${path}/${target.provider}/${target.id}`,
          creating ? 'POST' : 'PUT',
          body,
          user.id,
        );
        await onSaved();
      }}
    />
  );
}

export function TerminalAdministration({ user, storeId }: { user: Principal; storeId: string }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<Target | null>(null);
  const [deleting, setDeleting] = useState<TerminalDirectoryRow | null>(null);
  const [message, setMessage] = useState('');
  const changed = async () => {
    await client.invalidateQueries({ queryKey: [user.id] });
  };
  return (
    <>
      <div className="administration-heading administration-section-gap">
        <h2>Payment terminals</h2>
        <div className="administration-actions">
          <button className="button secondary" onClick={() => setEditing({ provider: 'paytm' })}>
            Add Paytm
          </button>
          <button
            className="button secondary"
            onClick={() => setEditing({ provider: 'pine-labs' })}
          >
            Add Pine Labs
          </button>
        </div>
      </div>
      {message && (
        <div className="administration-status" role="status">
          {message}
        </div>
      )}
      <TerminalDirectory
        key={user.id + ':' + storeId}
        user={user}
        storeId={storeId}
        onEdit={(row) => setEditing({ provider: row.provider, id: row.id, storeId: row.storeId })}
        onDelete={setDeleting}
      />
      {editing && (
        <TerminalEditor
          key={`${editing.provider}:${editing.storeId || storeId}:${editing.id || 'new'}`}
          user={user}
          storeId={editing.storeId || storeId}
          target={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setMessage(editing.id ? 'Payment terminal updated.' : 'Payment terminal created.');
            await changed();
          }}
        />
      )}
      {deleting && (
        <AdministrationEditor
          title={`Delete ${providerName(deleting.provider)} ${deleting.name}?`}
          description="This removes the terminal from this store's payment setup."
          submitLabel="Delete terminal"
          fields={[]}
          initialValues={{}}
          onClose={() => setDeleting(null)}
          onSave={async () => {
            await mutateAdministration(
              `/api/v1/admin/stores/${deleting.storeId}/payment-terminals/${deleting.provider}/${deleting.id}`,
              'DELETE',
              undefined,
              user.id,
            );
            setMessage('Payment terminal deleted.');
            await changed();
          }}
        />
      )}
    </>
  );
}
