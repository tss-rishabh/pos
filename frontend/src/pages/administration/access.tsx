import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { Empty, ErrorState, Loading } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { useAdministrationAuthenticationChange } from './access-authentication';
import {
  accessGroupSchema,
  accessGroupSummary,
  accessPermissionSchema,
  accessSuccessSchema,
  groupDeletionPreviewSchema,
  operatorAccessSchema,
  toggleAccessSelection,
  useAccessCapabilities,
  useAccessCollection,
} from './access-api';

function AccessDialog({
  title,
  children,
  onClose,
  onSave,
  submitLabel = 'Save access',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSave?: () => Promise<void>;
  submitLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    online = useOnline();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="administration-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="administration-dialog-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close access editor"
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!onSave || busy || !online) return;
          setBusy(true);
          setError(null);
          void onSave()
            .then(onClose)
            .catch((failure: unknown) => setError(failure))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset className="administration-access-fieldset" disabled={busy}>
          {children}
        </fieldset>
        {error !== null && <ErrorState error={error} />}
        {!online && <p>Reconnect before changing administration access.</p>}
        <div className="administration-dialog-actions">
          <button className="button secondary" type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
          {onSave && (
            <button className="button primary" disabled={busy || !online}>
              {busy ? 'Saving…' : submitLabel}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
function PermissionPicker({
  user,
  selected,
  onChange,
  disabled,
}: {
  user: Principal;
  selected: string[];
  onChange: (keys: string[]) => void;
  disabled: boolean;
}) {
  const [search, setSearch] = useState('');
  const collection = useAccessCollection(
      user.id,
      '/api/v1/admin/access/permissions',
      accessPermissionSchema,
      search,
      true,
    ),
    rows = collection.data?.pages.flatMap((page) => page.data) || [];
  return (
    <section>
      <h3>Permissions</h3>
      <input
        aria-label="Find model permission"
        placeholder="Find a permission"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <p>{selected.length} selected.</p>
      <details>
        <summary>Selected permission keys</summary>
        <textarea
          aria-label="Selected model permission keys"
          readOnly
          rows={4}
          value={selected.join('\n')}
        />
      </details>
      {collection.isPending ? (
        <Loading />
      ) : collection.isError ? (
        <ErrorState error={collection.error} />
      ) : (
        <div className="administration-assignment-list">
          {rows.map((permission) => (
            <label key={permission.key}>
              <input
                type="checkbox"
                aria-label={permission.key}
                checked={selected.includes(permission.key)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(toggleAccessSelection(selected, permission.key, event.target.checked))
                }
              />
              <span>
                {permission.name}
                <small>{permission.key}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {collection.hasNextPage && (
        <button
          type="button"
          className="button secondary"
          disabled={collection.isFetchingNextPage}
          onClick={() => void collection.fetchNextPage()}
        >
          Load more permissions
        </button>
      )}
    </section>
  );
}
function GroupForm({
  user,
  group,
  creating,
  editable,
  onClose,
  onChanged,
}: {
  user: Principal;
  group: { id?: string; name: string; version: string | null; permissionKeys: string[] };
  creating: boolean;
  editable: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(group.name),
    [permissions, setPermissions] = useState(group.permissionKeys),
    operation = useRef(crypto.randomUUID());
  const reauthenticate = useAdministrationAuthenticationChange();
  const changed = () => {
    operation.current = crypto.randomUUID();
  };
  return (
    <AccessDialog
      title={creating ? 'Create model administration group' : 'Model administration group'}
      onClose={onClose}
      submitLabel="Save group"
      onSave={
        editable
          ? async () => {
              const result = await request(
                creating
                  ? '/api/v1/admin/access/groups'
                  : `/api/v1/admin/access/groups/${group.id}`,
                {
                  operatorId: user.id,
                  method: creating ? 'POST' : 'PUT',
                  body: JSON.stringify({
                    operationId: operation.current,
                    expectedVersion: group.version,
                    name,
                    permissionKeys: permissions,
                  }),
                },
                accessSuccessSchema,
              );
              if (result.reauthenticate) await reauthenticate();
              else await onChanged();
            }
          : undefined
      }
    >
      <label>
        Group name
        <input
          aria-label="Group name"
          required
          maxLength={150}
          value={name}
          disabled={!editable}
          onChange={(event) => {
            setName(event.target.value);
            changed();
          }}
        />
      </label>
      <PermissionPicker
        user={user}
        selected={permissions}
        disabled={!editable}
        onChange={(keys) => {
          setPermissions(keys);
          changed();
        }}
      />
    </AccessDialog>
  );
}
function GroupDialog({
  user,
  id,
  editable,
  onClose,
  onChanged,
}: {
  user: Principal;
  id: string | 'new';
  editable: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const detail = useQuery({
    queryKey: [user.id, 'administration', 'model-group', id],
    enabled: id !== 'new',
    queryFn: ({ signal }) =>
      request(
        `/api/v1/admin/access/groups/${id}`,
        { operatorId: user.id, cache: 'no-store', signal },
        accessGroupSchema,
      ),
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (id === 'new')
    return (
      <GroupForm
        user={user}
        group={{ name: '', version: null, permissionKeys: [] }}
        creating
        editable={editable}
        onClose={onClose}
        onChanged={onChanged}
      />
    );
  if (detail.isPending || detail.isError)
    return (
      <AccessDialog title="Model administration group" onClose={onClose}>
        {detail.isPending ? <Loading /> : <ErrorState error={detail.error} />}
      </AccessDialog>
    );
  return (
    <GroupForm
      key={detail.data.version}
      user={user}
      group={detail.data}
      creating={false}
      editable={editable}
      onClose={onClose}
      onChanged={onChanged}
    />
  );
}
function DeleteGroupDialog({
  user,
  id,
  onClose,
  onChanged,
}: {
  user: Principal;
  id: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const operation = useRef(crypto.randomUUID());
  const reauthenticate = useAdministrationAuthenticationChange();
  const detail = useQuery({
    queryKey: [user.id, 'administration', 'model-group-delete', id],
    queryFn: ({ signal }) =>
      request(
        `/api/v1/admin/access/groups/${id}`,
        { operatorId: user.id, cache: 'no-store', signal },
        accessGroupSchema,
      ),
    retry: false,
  });
  return (
    <AccessDialog
      title="Delete administration group"
      onClose={onClose}
      submitLabel="Delete group"
      onSave={
        detail.data
          ? async () => {
              const result = await request(
                `/api/v1/admin/access/groups/${id}`,
                {
                  operatorId: user.id,
                  method: 'DELETE',
                  body: JSON.stringify({
                    operationId: operation.current,
                    expectedVersion: detail.data.version,
                  }),
                },
                accessSuccessSchema,
              );
              if (result.reauthenticate) await reauthenticate();
              else await onChanged();
            }
          : undefined
      }
    >
      {detail.isPending ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : (
        <p>
          Delete {detail.data.name}? This removes its permissions from {detail.data.memberCount}{' '}
          operator memberships.
        </p>
      )}
    </AccessDialog>
  );
}
function DeleteSelectedGroupsDialog({
  user,
  ids,
  onClose,
  onChanged,
}: {
  user: Principal;
  ids: string[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const operation = useRef(crypto.randomUUID()),
    reauthenticate = useAdministrationAuthenticationChange();
  const preview = useQuery({
    queryKey: [user.id, 'administration', 'group-deletion-preview', ids],
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      request(
        '/api/v1/admin/access/group-deletion-previews',
        {
          operatorId: user.id,
          method: 'POST',
          signal,
          cache: 'no-store',
          body: JSON.stringify({ groupIds: ids }),
        },
        groupDeletionPreviewSchema,
      ),
  });
  return (
    <AccessDialog
      title="Delete selected administration groups"
      onClose={onClose}
      submitLabel="Delete selected groups"
      onSave={
        preview.data && !preview.isFetching && !preview.isError
          ? async () => {
              const result = await request(
                '/api/v1/admin/access/group-deletions',
                {
                  operatorId: user.id,
                  method: 'POST',
                  body: JSON.stringify({
                    operationId: operation.current,
                    groups: preview.data.groups.map((group) => ({
                      id: group.id,
                      expectedVersion: group.version,
                    })),
                  }),
                },
                accessSuccessSchema,
              );
              if (result.reauthenticate) await reauthenticate();
              else await onChanged();
            }
          : undefined
      }
    >
      {preview.isPending ? (
        <Loading />
      ) : preview.isError ? (
        <ErrorState error={preview.error} />
      ) : (
        <>
          <p>
            Delete {preview.data.groups.length} groups and remove {preview.data.membershipCount}{' '}
            operator memberships and {preview.data.permissionAssignmentCount} permission
            assignments? Operator accounts and financial identities are retained.
          </p>
          <ul>
            {preview.data.groups.map((group) => (
              <li key={group.id}>
                {group.name}: {group.memberCount} memberships, {group.permissionCount} permissions.
              </li>
            ))}
          </ul>
          <p>
            Affected operators must sign in again. This action applies to the confirmed group
            versions.
          </p>
        </>
      )}
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          operation.current = crypto.randomUUID();
          void preview.refetch();
        }}
      >
        Reload deletion preview
      </button>
    </AccessDialog>
  );
}
export function ModelAccessAdministration({ user }: { user: Principal }) {
  const client = useQueryClient(),
    online = useOnline(),
    capabilities = useAccessCapabilities(user.id),
    [search, setSearch] = useState(''),
    [editing, setEditing] = useState<string | null>(null),
    [deleting, setDeleting] = useState<string | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [deletingSelection, setDeletingSelection] = useState<string[] | null>(null);
  const groups = useAccessCollection(
    user.id,
    '/api/v1/admin/access/groups',
    accessGroupSummary,
    search,
    Boolean(capabilities.data?.canViewGroups),
  );
  const changed = async () => {
    setSelected([]);
    await client.invalidateQueries({ queryKey: [user.id, 'administration'] });
  };
  if (capabilities.isPending) return <Loading />;
  if (capabilities.isError) return <ErrorState error={capabilities.error} />;
  if (!capabilities.data.reconciled)
    return (
      <Empty title="Legacy administration access needs verification">
        Import the complete verified source groups, permissions and operator flags before using
        model administration.
      </Empty>
    );
  if (!capabilities.data.canViewGroups)
    return <Empty title="Model administration permission is required" />;
  const rows = groups.data?.pages.flatMap((page) => page.data) || [];
  return (
    <>
      <div className="administration-heading">
        <h2>Model administration groups</h2>
        <input
          aria-label="Find administration group"
          placeholder="Find a group"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {capabilities.data.canManage && (
          <button className="button primary" onClick={() => setEditing('new')}>
            Create group
          </button>
        )}
      </div>
      <p>
        This controls model administration. POS roles and store assignments also apply. Global
        privilege changes require a current internal superuser.
      </p>
      {capabilities.data.canManage && (
        <div className="administration-actions">
          <button
            className="button secondary"
            disabled={!online || !selected.length}
            onClick={() => setDeletingSelection([...selected].sort())}
          >
            Delete selected groups ({selected.length})
          </button>
          <button
            className="button secondary"
            disabled={!selected.length}
            onClick={() => setSelected([])}
          >
            Clear group selection
          </button>
          <p>
            Select up to 100 groups. The confirmation lists every selected group, including
            selections hidden by a filter.
          </p>
        </div>
      )}
      {groups.isPending ? (
        <Loading />
      ) : groups.isError ? (
        <ErrorState error={groups.error} />
      ) : (
        <section className="surface">
          <table className="administration-table">
            <thead>
              <tr>
                {capabilities.data.canManage && <th>Select</th>}
                <th>Group</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((group) => (
                <tr key={group.id}>
                  {capabilities.data.canManage && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select group ${group.name}`}
                        checked={selected.includes(group.id)}
                        disabled={!selected.includes(group.id) && selected.length >= 100}
                        onChange={(event) =>
                          setSelected((current) =>
                            toggleAccessSelection(current, group.id, event.target.checked),
                          )
                        }
                      />
                    </td>
                  )}
                  <td>{group.name}</td>
                  <td>
                    <div className="administration-table-actions">
                      <button className="button secondary" onClick={() => setEditing(group.id)}>
                        {capabilities.data.canManage ? 'Edit group' : 'View permissions'}
                      </button>
                      {capabilities.data.canManage && (
                        <button className="button secondary" onClick={() => setDeleting(group.id)}>
                          Delete group
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty title="No matching administration groups" />}
        </section>
      )}
      {groups.hasNextPage && (
        <button className="button secondary" onClick={() => void groups.fetchNextPage()}>
          Load more groups
        </button>
      )}
      {editing && (
        <GroupDialog
          key={editing}
          user={user}
          id={editing}
          editable={capabilities.data.canManage}
          onClose={() => setEditing(null)}
          onChanged={changed}
        />
      )}
      {deleting && (
        <DeleteGroupDialog
          user={user}
          id={deleting}
          onClose={() => setDeleting(null)}
          onChanged={changed}
        />
      )}
      {deletingSelection && (
        <DeleteSelectedGroupsDialog
          user={user}
          ids={deletingSelection}
          onClose={() => setDeletingSelection(null)}
          onChanged={changed}
        />
      )}
    </>
  );
}
function OperatorAccessForm({
  user,
  operatorName,
  data,
  editable,
  onClose,
  onChanged,
}: {
  user: Principal;
  operatorName: string;
  data: z.infer<typeof operatorAccessSchema>;
  editable: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [staff, setStaff] = useState(data.isStaff),
    [superuser, setSuperuser] = useState(data.isSuperuser),
    [groupIds, setGroupIds] = useState(data.groupIds),
    [permissions, setPermissions] = useState(data.permissionKeys),
    [search, setSearch] = useState(''),
    operation = useRef(crypto.randomUUID());
  const groups = useAccessCollection(
      user.id,
      '/api/v1/admin/access/groups',
      accessGroupSummary,
      search,
      editable,
    ),
    rows = groups.data?.pages.flatMap((page) => page.data) || [];
  const changed = () => {
    operation.current = crypto.randomUUID();
  };
  return (
    <AccessDialog
      title={`Administration access for ${operatorName}`}
      onClose={onClose}
      onSave={
        editable
          ? async () => {
              await request(
                `/api/v1/admin/operators/${data.id}/administration-access`,
                {
                  operatorId: user.id,
                  method: 'PUT',
                  body: JSON.stringify({
                    operationId: operation.current,
                    expectedVersion: data.version,
                    isStaff: staff,
                    isSuperuser: superuser,
                    groupIds,
                    permissionKeys: permissions,
                  }),
                },
                accessSuccessSchema,
              );
              await onChanged();
            }
          : undefined
      }
    >
      <p>
        Changes to staff or superuser flags sign this operator out of existing sessions. Another
        superuser must change your own privileges.
      </p>
      <label className="administration-access-checkbox">
        <input
          type="checkbox"
          aria-label="Model administration staff access"
          checked={staff}
          disabled={!editable}
          onChange={(event) => {
            setStaff(event.target.checked);
            if (!event.target.checked) setSuperuser(false);
            changed();
          }}
        />
        Model administration staff access
      </label>
      <label className="administration-access-checkbox">
        <input
          type="checkbox"
          aria-label="Model administration superuser access"
          checked={superuser}
          disabled={!editable}
          onChange={(event) => {
            setSuperuser(event.target.checked);
            if (event.target.checked) setStaff(true);
            changed();
          }}
        />
        Superuser access to every model permission
      </label>
      <h3>Groups</h3>
      <p>
        {groupIds.length} selected.{' '}
        {data.groups
          .filter((group) => groupIds.includes(group.id))
          .map((group) => group.name)
          .join(', ')}
      </p>
      {editable && (
        <>
          <input
            aria-label="Find operator administration group"
            placeholder="Find a group"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {groups.isPending ? (
            <Loading />
          ) : groups.isError ? (
            <ErrorState error={groups.error} />
          ) : (
            <div className="administration-assignment-list">
              {rows.map((group) => (
                <label key={group.id}>
                  <input
                    type="checkbox"
                    aria-label={`Group ${group.name}`}
                    checked={groupIds.includes(group.id)}
                    onChange={(event) => {
                      setGroupIds(toggleAccessSelection(groupIds, group.id, event.target.checked));
                      changed();
                    }}
                  />
                  {group.name}
                </label>
              ))}
            </div>
          )}
          {groups.hasNextPage && (
            <button
              type="button"
              className="button secondary"
              onClick={() => void groups.fetchNextPage()}
            >
              Load more operator groups
            </button>
          )}
        </>
      )}
      <PermissionPicker
        user={user}
        selected={permissions}
        disabled={!editable}
        onChange={(keys) => {
          setPermissions(keys);
          changed();
        }}
      />
    </AccessDialog>
  );
}
function OperatorAccessDialog({
  user,
  operatorId,
  operatorName,
  onClose,
}: {
  user: Principal;
  operatorId: string;
  operatorName: string;
  onClose: () => void;
}) {
  const capabilities = useAccessCapabilities(user.id),
    client = useQueryClient();
  const detail = useQuery({
    queryKey: [user.id, 'administration', 'operator-model-access', operatorId],
    queryFn: ({ signal }) =>
      request(
        `/api/v1/admin/operators/${operatorId}/administration-access`,
        { operatorId: user.id, cache: 'no-store', signal },
        operatorAccessSchema,
      ),
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (detail.isPending || capabilities.isPending)
    return (
      <AccessDialog title="Operator administration access" onClose={onClose}>
        <Loading />
      </AccessDialog>
    );
  if (detail.isError || capabilities.isError)
    return (
      <AccessDialog title="Operator administration access" onClose={onClose}>
        <ErrorState error={detail.error || capabilities.error} />
      </AccessDialog>
    );
  return (
    <OperatorAccessForm
      user={user}
      operatorName={operatorName}
      data={detail.data}
      editable={capabilities.data.canManage && operatorId !== user.id}
      onClose={onClose}
      onChanged={async () => {
        await client.invalidateQueries({ queryKey: [user.id] });
      }}
    />
  );
}
export function OperatorAccessButton({
  user,
  operatorId,
  operatorName,
}: {
  user: Principal;
  operatorId: string;
  operatorName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="button secondary" onClick={() => setOpen(true)}>
        Administration access
      </button>
      {open && (
        <OperatorAccessDialog
          user={user}
          operatorId={operatorId}
          operatorName={operatorName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
