import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading } from '../../components/common';
import { AdministrationEditor, type AdministrationField } from './editor';
import { AssignmentEditor } from './assignments';
import { OperatorMfaButton } from './mfa';
import { OperatorAccessButton } from './access';
import { OperatorAdministrativeButton } from './operator-administration';
import {
  mutateAdministration,
  operatorSchema,
  salespersonSchema,
  useAdministrationCollection,
  type AdministrationOperator,
  type AdministrationSalesperson,
} from './api';

const roles = [
  { value: '1', label: 'Super admin' },
  { value: '2', label: 'Admin' },
  { value: '3', label: 'OPM' },
  { value: '4', label: 'SM' },
  { value: '5', label: 'Staff' },
];
const ownership = [
  { value: '1', label: 'In house' },
  { value: '2', label: 'Franchise' },
];
const contactFields: AdministrationField[] = [
  { name: 'firstName', label: 'First name', required: true, maxLength: 255 },
  { name: 'lastName', label: 'Last name', required: true, maxLength: 255 },
  { name: 'email', label: 'Email', kind: 'email', required: true, maxLength: 255 },
  { name: 'phone', label: 'Phone', kind: 'tel', required: true, maxLength: 10 },
];

function CollectionControls({
  label,
  search,
  status,
  onSearch,
  onStatus,
  onCreate,
}: {
  label: string;
  search: string;
  status: string;
  onSearch: (value: string) => void;
  onStatus: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="administration-heading">
      <h2>{label}</h2>
      <div className="administration-filters">
        <input
          aria-label={`Find ${label.toLowerCase()}`}
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Find by name or contact"
        />
        <select
          aria-label={`${label} status`}
          value={status}
          onChange={(event) => onStatus(event.target.value)}
        >
          <option value="true">Active</option>
          <option value="false">Archived</option>
          <option value="all">All</option>
        </select>
        <button className="button primary" onClick={onCreate}>
          <Plus size={16} />
          Create
        </button>
      </div>
    </div>
  );
}

function canManageOperator(user: Principal, target: AdministrationOperator) {
  return (
    user.id !== target.id &&
    (user.role === 1 ||
      (user.role === 2 && target.role !== 1) ||
      (user.role === 3 && target.role >= 4))
  );
}

export function OperatorAdministration({ user }: { user: Principal }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('true');
  const [editing, setEditing] = useState<AdministrationOperator | 'new' | null>(null);
  const [assigning, setAssigning] = useState<AdministrationOperator | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const collection = useAdministrationCollection(
    user.id,
    '/api/v1/admin/operators',
    operatorSchema,
    search,
    status,
  );
  const rows = collection.data?.pages.flatMap((page) => page.data) || [];
  const changed = () => client.invalidateQueries({ queryKey: [user.id] });
  const creating = editing === 'new';
  const roleOptions = roles.filter(
    (role) => user.role === 1 || (user.role === 2 ? role.value !== '1' : Number(role.value) >= 4),
  );
  const fields: AdministrationField[] = [
    ...contactFields.map((field) => ({
      ...field,
      maxLength:
        field.name === 'phone'
          ? 10
          : creating
            ? field.name === 'email'
              ? 96
              : 32
            : field.name === 'email'
              ? 254
              : 150,
    })),
    { name: 'contactEmail', label: 'OTP email', kind: 'email', required: true, maxLength: 254 },
    { name: 'role', label: 'Role', kind: 'select', required: true, options: roleOptions },
    {
      name: 'otpMethod',
      label: 'OTP delivery',
      kind: 'select',
      required: true,
      options: [
        { value: '1', label: 'Mobile' },
        { value: '2', label: 'Email' },
      ],
    },
    {
      name: 'userType',
      label: 'Ownership',
      kind: 'select',
      required: true,
      options: user.userType === 2 ? ownership.slice(1) : ownership,
    },
    ...(creating
      ? [
          {
            name: 'password',
            label: 'Initial password (at least 12 characters)',
            kind: 'password' as const,
            required: true,
            maxLength: 128,
          },
          {
            name: 'confirmPassword',
            label: 'Confirm password',
            kind: 'password' as const,
            required: true,
            maxLength: 128,
          },
        ]
      : []),
  ];
  const selected = editing && editing !== 'new' ? editing : null;
  const values = {
    firstName: selected?.firstName || '',
    lastName: selected?.lastName || '',
    email: selected?.email || '',
    phone: selected?.phone || '',
    contactEmail: selected?.contactEmail || '',
    role: String(selected?.role || 5),
    otpMethod: String(selected?.otpMethod || 1),
    userType: String(selected?.userType || user.userType),
    password: '',
    confirmPassword: '',
  };
  async function toggle(target: AdministrationOperator) {
    try {
      await mutateAdministration(
        `/api/v1/admin/operators/${target.id}/status`,
        'PATCH',
        {
          active: !target.active,
        },
        user.id,
      );
      setMessage(target.active ? 'Operator archived.' : 'Operator activated.');
      await changed();
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <>
      <CollectionControls
        label="Operators"
        search={search}
        status={status}
        onSearch={setSearch}
        onStatus={setStatus}
        onCreate={() => setEditing('new')}
      />
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
          <div className="table-wrap">
            <table className="administration-table">
              <thead>
                <tr>
                  <th>Operator</th>
                  <th>Role</th>
                  <th>OTP</th>
                  <th>Stores</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((target) => (
                  <tr key={target.id}>
                    <td>
                      <strong>
                        {target.firstName} {target.lastName}
                      </strong>
                      <small>{target.email}</small>
                      {target.username && target.username !== target.email && (
                        <small>{target.username}</small>
                      )}
                    </td>
                    <td>
                      {roles.find((role) => Number(role.value) === target.role)?.label || 'Unknown'}
                    </td>
                    <td>
                      {target.otpMethod === 1 ? 'Mobile' : 'Email'}
                      <small>MFA {target.mfa ? 'enabled' : 'disabled'}</small>
                    </td>
                    <td>{target.role === 1 ? 'All stores' : target.storeIds.length}</td>
                    <td>
                      <span className={`badge ${target.active ? 'green' : 'neutral'}`}>
                        {target.active ? 'Active' : 'Archived'}
                      </span>
                    </td>
                    <td>
                      <div className="administration-table-actions">
                        {user.role === 1 && (
                          <OperatorAdministrativeButton
                            user={user}
                            operatorId={target.id}
                            operatorName={`${target.firstName} ${target.lastName}`}
                          />
                        )}
                        {user.role === 1 && (
                          <OperatorAccessButton
                            user={user}
                            operatorId={target.id}
                            operatorName={`${target.firstName} ${target.lastName}`}
                          />
                        )}
                        {target.active &&
                          (target.id === user.id || canManageOperator(user, target)) && (
                            <OperatorMfaButton
                              actorId={user.id}
                              operatorId={target.id}
                              operatorName={`${target.firstName} ${target.lastName}`}
                              self={target.id === user.id}
                              onChanged={changed}
                            />
                          )}
                        {canManageOperator(user, target) && (
                          <>
                            <button className="button secondary" onClick={() => setEditing(target)}>
                              Edit
                            </button>
                            {target.role !== 1 && (
                              <button
                                className="button secondary"
                                onClick={() => setAssigning(target)}
                              >
                                Stores
                              </button>
                            )}
                            <button
                              className="button secondary"
                              onClick={() => void toggle(target)}
                            >
                              {target.active ? 'Archive' : 'Activate'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <Empty title="No matching operators" />}
          </div>
        )}
        {collection.hasNextPage && (
          <button
            className="button secondary load-more"
            onClick={() => void collection.fetchNextPage()}
          >
            Load more operators
          </button>
        )}
      </section>
      {editing && (
        <AdministrationEditor
          key={creating ? 'new' : selected?.id}
          title={creating ? 'Create an operator' : 'Edit operator'}
          fields={fields}
          initialValues={values}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await mutateAdministration(
              creating ? '/api/v1/admin/operators' : `/api/v1/admin/operators/${selected?.id}`,
              creating ? 'POST' : 'PUT',
              {
                firstName: input.firstName,
                lastName: input.lastName,
                email: input.email,
                phone: input.phone,
                contactEmail: input.contactEmail,
                role: Number(input.role),
                otpMethod: Number(input.otpMethod),
                userType: Number(input.userType),
                ...(creating
                  ? { password: input.password, confirmPassword: input.confirmPassword }
                  : {}),
              },
              user.id,
            );
            setMessage(creating ? 'Operator created.' : 'Operator updated.');
            await changed();
          }}
        />
      )}
      {assigning && (
        <AssignmentEditor
          key={assigning.id}
          ownerId={user.id}
          title={`Stores for ${assigning.firstName}`}
          initialIds={assigning.storeIds}
          onClose={() => setAssigning(null)}
          onSave={async (storeIds) => {
            await mutateAdministration(
              `/api/v1/admin/operators/${assigning.id}/stores`,
              'PUT',
              {
                storeIds,
              },
              user.id,
            );
            setMessage('Operator store access updated.');
            await changed();
          }}
        />
      )}
    </>
  );
}

export function SalespersonAdministration({ user }: { user: Principal }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('true');
  const [editing, setEditing] = useState<AdministrationSalesperson | 'new' | null>(null);
  const [assigning, setAssigning] = useState<AdministrationSalesperson | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const collection = useAdministrationCollection(
    user.id,
    '/api/v1/admin/salespeople',
    salespersonSchema,
    search,
    status,
  );
  const rows = collection.data?.pages.flatMap((page) => page.data) || [];
  const changed = () => client.invalidateQueries({ queryKey: [user.id] });
  const selected = editing && editing !== 'new' ? editing : null;
  const fields: AdministrationField[] = [
    { name: 'employeeId', label: 'Employee ID', required: true, maxLength: 45 },
    ...contactFields.map((field) => ({ ...field, maxLength: field.name === 'phone' ? 10 : 45 })),
    {
      name: 'userType',
      label: 'Ownership',
      kind: 'select',
      required: true,
      options: user.userType === 2 ? ownership.slice(1) : ownership,
    },
  ];
  const values = {
    employeeId: selected?.employeeId || '',
    firstName: selected?.firstName || '',
    lastName: selected?.lastName || '',
    email: selected?.email || '',
    phone: selected?.phone || '',
    userType: String(selected?.userType || user.userType),
  };
  async function toggle(target: AdministrationSalesperson) {
    try {
      await mutateAdministration(
        `/api/v1/admin/salespeople/${target.id}/status`,
        'PATCH',
        {
          active: !target.active,
        },
        user.id,
      );
      setMessage(target.active ? 'Salesperson archived.' : 'Salesperson activated.');
      await changed();
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <>
      <CollectionControls
        label="Salespeople"
        search={search}
        status={status}
        onSearch={setSearch}
        onStatus={setStatus}
        onCreate={() => setEditing('new')}
      />
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
          <div className="table-wrap">
            <table className="administration-table">
              <thead>
                <tr>
                  <th>Salesperson</th>
                  <th>Employee ID</th>
                  <th>Ownership</th>
                  <th>Stores</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((target) => (
                  <tr key={target.id}>
                    <td>
                      <strong>
                        {target.firstName} {target.lastName}
                      </strong>
                      <small>{target.email}</small>
                    </td>
                    <td className="administration-value">{target.employeeId}</td>
                    <td>{target.userType === 2 ? 'Franchise' : 'In house'}</td>
                    <td>{target.storeIds.length}</td>
                    <td>
                      <span className={`badge ${target.active ? 'green' : 'neutral'}`}>
                        {target.active ? 'Active' : 'Archived'}
                      </span>
                    </td>
                    <td>
                      <div className="administration-table-actions">
                        <button className="button secondary" onClick={() => setEditing(target)}>
                          Edit
                        </button>
                        <button className="button secondary" onClick={() => setAssigning(target)}>
                          Stores
                        </button>
                        <button className="button secondary" onClick={() => void toggle(target)}>
                          {target.active ? 'Archive' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <Empty title="No matching salespeople" />}
          </div>
        )}
        {collection.hasNextPage && (
          <button
            className="button secondary load-more"
            onClick={() => void collection.fetchNextPage()}
          >
            Load more salespeople
          </button>
        )}
      </section>
      {editing && (
        <AdministrationEditor
          key={selected?.id || 'new'}
          title={selected ? 'Edit salesperson' : 'Create a salesperson'}
          fields={fields}
          initialValues={values}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await mutateAdministration(
              selected ? `/api/v1/admin/salespeople/${selected.id}` : '/api/v1/admin/salespeople',
              selected ? 'PUT' : 'POST',
              {
                employeeId: input.employeeId,
                firstName: input.firstName,
                lastName: input.lastName,
                email: input.email,
                phone: input.phone,
                userType: Number(input.userType),
                active: selected?.active ?? true,
              },
              user.id,
            );
            setMessage(selected ? 'Salesperson updated.' : 'Salesperson created.');
            await changed();
          }}
        />
      )}
      {assigning && (
        <AssignmentEditor
          key={assigning.id}
          ownerId={user.id}
          title={`Stores for ${assigning.firstName}`}
          initialIds={assigning.storeIds}
          initialActiveStoreId={assigning.activeStoreId}
          onClose={() => setAssigning(null)}
          onSave={async (storeIds, activeStoreId) => {
            await mutateAdministration(
              `/api/v1/admin/salespeople/${assigning.id}/stores`,
              'PUT',
              {
                storeIds,
                activeStoreId,
              },
              user.id,
            );
            setMessage('Salesperson store access updated.');
            await changed();
          }}
        />
      )}
    </>
  );
}
