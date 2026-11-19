import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { ErrorState, Loading } from '../../components/common';
import { PrivateImages } from '../../components/private-images';
import { useOnline } from '../../hooks/use-pos';

export const operatorAdministrativeProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  contactEmail: z.string().nullable(),
  age: z.number().int().nullable(),
  gender: z.string().nullable(),
  role: z.number().int(),
  userType: z.number().int(),
  otpMethod: z.number().int(),
  active: z.boolean(),
  isStaff: z.boolean(),
  isSuperuser: z.boolean(),
  mfaEnabled: z.boolean(),
  passwordConfigured: z.boolean(),
  lastLogin: z.string().nullable(),
  dateJoined: z.string(),
  timeZone: z.string(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  imagesAvailable: z.boolean(),
  hasProfileImage: z.boolean(),
  hasCoverImage: z.boolean(),
  canEdit: z.boolean(),
  canResetPassword: z.boolean(),
});
const savedSchema = z.object({
  id: z.string(),
  status: z.literal('success'),
  message: z.string(),
  credentialsChanged: z.boolean(),
});
type Profile = z.infer<typeof operatorAdministrativeProfileSchema>;
const valuesFrom = (profile: Profile) => ({
  username: profile.username,
  firstName: profile.firstName,
  lastName: profile.lastName,
  email: profile.email || '',
  phone: profile.phone || '',
  contactEmail: profile.contactEmail || '',
  age: profile.age === null ? '' : String(profile.age),
  gender: profile.gender || '',
  role: String(profile.role),
  userType: String(profile.userType),
  otpMethod: String(profile.otpMethod),
  active: profile.active,
  lastLogin: profile.lastLogin || '',
  dateJoined: profile.dateJoined,
});
function AdministrativeProfileForm({
  user,
  profile,
  path,
  onSaved,
  onBusy,
}: {
  user: Principal;
  profile: Profile;
  path: string;
  onSaved: (message: string) => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [values, setValues] = useState(() => valuesFrom(profile)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const operation = useRef(crypto.randomUUID()),
    online = useOnline();
  function field<Key extends keyof typeof values>(key: Key, value: (typeof values)[Key]) {
    setValues((current) => ({ ...current, [key]: value }));
    operation.current = crypto.randomUUID();
  }
  async function save() {
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const result = await request(
        `${path}/administrative-profile`,
        {
          method: 'PUT',
          operatorId: user.id,
          cache: 'no-store',
          body: JSON.stringify({
            ...values,
            age: values.age === '' ? null : Number(values.age),
            gender: values.gender || null,
            role: Number(values.role),
            userType: Number(values.userType),
            otpMethod: Number(values.otpMethod),
            operationId: operation.current,
            expectedVersion: profile.revision,
          }),
        },
        savedSchema,
      );
      await onSaved(result.message);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && online && profile.canEdit) void save();
      }}
    >
      <fieldset
        className="administration-access-fieldset"
        disabled={busy || !online || !profile.canEdit}
      >
        <div className="administration-fields">
          <label>
            Login name
            <input
              aria-label="Administrative login name"
              required
              maxLength={600}
              autoComplete="off"
              value={values.username}
              onChange={(event) => field('username', event.target.value)}
            />
          </label>
          <label>
            First name
            <input
              aria-label="Administrative first name"
              maxLength={150}
              autoComplete="off"
              value={values.firstName}
              onChange={(event) => field('firstName', event.target.value)}
            />
          </label>
          <label>
            Last name
            <input
              aria-label="Administrative last name"
              maxLength={150}
              autoComplete="off"
              value={values.lastName}
              onChange={(event) => field('lastName', event.target.value)}
            />
          </label>
          <label>
            Email
            <input
              aria-label="Administrative email"
              type="email"
              maxLength={254}
              autoComplete="off"
              value={values.email}
              onChange={(event) => field('email', event.target.value)}
            />
          </label>
          <label>
            Phone
            <input
              aria-label="Administrative phone"
              type="tel"
              pattern="[1-9][0-9]{9}"
              maxLength={10}
              autoComplete="off"
              value={values.phone}
              onChange={(event) => field('phone', event.target.value)}
            />
          </label>
          <label>
            OTP email
            <input
              aria-label="Administrative OTP email"
              type="email"
              maxLength={254}
              autoComplete="off"
              value={values.contactEmail}
              onChange={(event) => field('contactEmail', event.target.value)}
            />
          </label>
          <label>
            Age
            <input
              aria-label="Administrative age"
              type="number"
              min={0}
              max={150}
              step={1}
              value={values.age}
              onChange={(event) => field('age', event.target.value)}
            />
          </label>
          <label>
            Gender
            <select
              aria-label="Administrative gender"
              value={values.gender}
              onChange={(event) => field('gender', event.target.value)}
            >
              <option value="">Not specified</option>
              <option value="M">Male</option>
              <option value="F">Female</option>
              <option value="O">Other</option>
            </select>
          </label>
          <label>
            POS role
            <select
              aria-label="Administrative POS role"
              value={values.role}
              onChange={(event) => field('role', event.target.value)}
            >
              {['Super admin', 'Admin', 'OPM', 'SM', 'Staff'].map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ownership
            <select
              aria-label="Administrative ownership"
              value={values.userType}
              onChange={(event) => field('userType', event.target.value)}
            >
              <option value="1">In house</option>
              <option value="2">Franchise</option>
            </select>
          </label>
          <label>
            OTP delivery
            <select
              aria-label="Administrative OTP delivery"
              value={values.otpMethod}
              onChange={(event) => field('otpMethod', event.target.value)}
            >
              <option value="1">Mobile</option>
              <option value="2">Email</option>
            </select>
          </label>
          <label>
            Account status
            <select
              aria-label="Administrative account status"
              value={String(values.active)}
              onChange={(event) => field('active', event.target.value === 'true')}
            >
              <option value="true">Active</option>
              <option value="false">Archived</option>
            </select>
          </label>
          <label>
            Last login
            <input
              aria-label="Administrative last login"
              placeholder="YYYY-MM-DD HH:mm:ss"
              maxLength={26}
              value={values.lastLogin}
              onChange={(event) => field('lastLogin', event.target.value)}
            />
          </label>
          <label>
            Date joined
            <input
              aria-label="Administrative date joined"
              required
              placeholder="YYYY-MM-DD HH:mm:ss"
              maxLength={26}
              value={values.dateJoined}
              onChange={(event) => field('dateJoined', event.target.value)}
            />
          </label>
        </div>
        <p className="administration-notice">
          Dates use {profile.timeZone} store time. Saving a login name, contact, role or account
          status revokes this operator’s existing authentication.
        </p>
        {profile.canEdit && (
          <button className="button primary" disabled={busy || !online}>
            {busy ? 'Saving…' : 'Save administrative profile'}
          </button>
        )}
      </fieldset>
      {error !== null && <ErrorState error={error} />}
    </form>
  );
}
function AdministrativePasswordForm({
  user,
  profile,
  path,
  onSaved,
  onBusy,
}: {
  user: Principal;
  profile: Profile;
  path: string;
  onSaved: (message: string) => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const operation = useRef(crypto.randomUUID()),
    online = useOnline();
  async function save() {
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      if (password !== confirmation) throw new Error('The password confirmation must match.');
      const result = await request(
        `${path}/password-resets`,
        {
          method: 'POST',
          operatorId: user.id,
          cache: 'no-store',
          body: JSON.stringify({
            operationId: operation.current,
            expectedVersion: profile.revision,
            newPassword: password,
            confirmation,
          }),
        },
        savedSchema,
      );
      setPassword('');
      setConfirmation('');
      await onSaved(result.message);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && online) void save();
      }}
    >
      <h3>Reset operator password</h3>
      <p className="administration-notice">
        The source password policy applies. Resetting the password revokes existing authentication.
      </p>
      <fieldset className="administration-access-fieldset" disabled={busy || !online}>
        <div className="administration-fields">
          <label>
            New password
            <input
              aria-label="Administrative new password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                operation.current = crypto.randomUUID();
              }}
            />
          </label>
          <label>
            Confirm password
            <input
              aria-label="Administrative confirm password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
                operation.current = crypto.randomUUID();
              }}
            />
          </label>
        </div>
        <button className="button secondary" disabled={busy || !online}>
          {busy ? 'Resetting…' : 'Reset password'}
        </button>
      </fieldset>
      {error !== null && <ErrorState error={error} />}
    </form>
  );
}
function OperatorAdministrativeDialog({
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
  const dialog = useRef<HTMLDialogElement>(null),
    client = useQueryClient(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    online = useOnline();
  const path = `/api/v1/admin/operators/${encodeURIComponent(operatorId)}`;
  const view = useQuery({
    queryKey: [user.id, 'administration', 'operator-administrative-profile', operatorId],
    queryFn: ({ signal }) =>
      request(
        `${path}/administrative-profile`,
        { operatorId: user.id, cache: 'no-store', signal },
        operatorAdministrativeProfileSchema,
      ),
    retry: false,
  });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const refresh = async (notice: string) => {
    setMessage(notice);
    await view.refetch({ throwOnError: true });
    await client.invalidateQueries({
      queryKey: [user.id, 'administration', '/api/v1/admin/operators'],
    });
  };
  return (
    <dialog
      ref={dialog}
      className="administration-dialog"
      aria-label={`Administrative profile for ${operatorName}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="administration-dialog-heading">
        <h2>Administrative profile for {operatorName}</h2>
        <button
          className="icon-button"
          aria-label="Close administrative profile"
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {!online && <p>Reconnect before changing this operator.</p>}
      {view.isPending ? (
        <Loading />
      ) : view.isError ? (
        <ErrorState error={view.error} retry={() => void view.refetch()} />
      ) : (
        <>
          {!view.data.canEdit && (
            <p>This profile is read only. Use your personal profile for your own account.</p>
          )}
          <AdministrativeProfileForm
            key={`fields:${view.data.revision}`}
            user={user}
            profile={view.data}
            path={path}
            onSaved={refresh}
            onBusy={setBusy}
          />
          <p className="administration-notice">
            Staff: {view.data.isStaff ? 'yes' : 'no'} · Superuser:{' '}
            {view.data.isSuperuser ? 'yes' : 'no'} · MFA:{' '}
            {view.data.mfaEnabled ? 'enabled' : 'disabled'} · Password:{' '}
            {view.data.passwordConfigured ? 'configured' : 'unusable'}. Manage model grants and MFA
            through their dedicated actions.
          </p>
          {view.data.canResetPassword && (
            <AdministrativePasswordForm
              key={`password:${view.data.revision}`}
              user={user}
              profile={view.data}
              path={path}
              onSaved={refresh}
              onBusy={setBusy}
            />
          )}
          <PrivateImages
            title="Operator images"
            operatorId={user.id}
            revision={view.data.revision}
            available={view.data.imagesAvailable}
            editable={view.data.canEdit && !busy}
            online={online}
            reservePath={`${path}/profile/image-uploads`}
            attachmentPath={(id) => `${path}/profile/image-uploads/${id}/attachment`}
            attachmentSchema={z.object({ profile: operatorAdministrativeProfileSchema })}
            onAttached={() => refresh('Operator image saved.')}
            slots={[
              {
                kind: 'image',
                label: 'Operator profile image',
                exists: view.data.hasProfileImage,
                variant: 'portrait',
                url: `${path}/profile/images/image?v=${view.data.revision}`,
              },
              {
                kind: 'cover-image',
                label: 'Operator cover image',
                exists: view.data.hasCoverImage,
                variant: 'cover',
                url: `${path}/profile/images/cover-image?v=${view.data.revision}`,
              },
            ]}
          />
        </>
      )}
    </dialog>
  );
}
export function OperatorAdministrativeButton({
  user,
  operatorId,
  operatorName,
}: {
  user: Principal;
  operatorId: string;
  operatorName: string;
}) {
  const capabilities = useQuery({
      queryKey: [user.id, 'administration', 'operator-administration-capabilities'],
      queryFn: ({ signal }) =>
        request(
          '/api/v1/admin/operator-administration/capabilities',
          { cache: 'no-store', signal, operatorId: user.id },
          z.object({ canViewOperators: z.boolean() }),
        ),
      retry: false,
    }),
    [open, setOpen] = useState(false);
  if (!capabilities.data?.canViewOperators) return null;
  return (
    <>
      <button className="button secondary" onClick={() => setOpen(true)}>
        Full profile
      </button>
      {open && (
        <OperatorAdministrativeDialog
          user={user}
          operatorId={operatorId}
          operatorName={operatorName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
