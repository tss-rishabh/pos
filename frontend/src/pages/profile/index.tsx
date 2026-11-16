import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { principalSchema } from '../../api/schemas';
import { request } from '../../api/client';
import { db } from '../../offline/database';
import { ErrorState, Loading, PageTitle } from '../../components/common';
import './style.css';
import { ProfileImages } from './images';
import { OperatorMfaButton } from '../administration/mfa';
import { clearLocalIdentity } from '../../offline/clear-identity';
import { DeviceHandoffButton } from './device-handoff';

const profileSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  gender: z.enum(['M', 'F', 'O']).nullable(),
  age: z.number().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  contactEmail: z.string().nullable(),
  otpMethod: z.enum(['sms', 'email']),
  mfaEnabled: z.boolean(),
  canChangeEmailAndPhone: z.boolean(),
  hasProfileImage: z.boolean(),
  hasCoverImage: z.boolean(),
  imagesAvailable: z.boolean().optional().default(false),
  revision: z.string(),
});
const readSchema = z.object({ profile: profileSchema, sessionExpiresAt: z.number().positive() });
const savedSchema = readSchema.extend({ user: principalSchema });
type Profile = z.infer<typeof profileSchema>;
export function ProfilePage({ user, online }: { user: Principal; online: boolean }) {
  const client = useQueryClient();
  const key = [user.id, 'operator-profile'];
  const profile = useQuery({
    queryKey: key,
    enabled: online,
    queryFn: () => request('/api/v1/operators/current/profile', {}, readSchema),
    retry: false,
  });
  async function mfaChanged(credentialsChanged = false) {
    if (!credentialsChanged) {
      await profile.refetch();
      return;
    }
    await clearLocalIdentity(client, user.id);
  }
  async function saved(result: z.infer<typeof savedSchema>) {
    try {
      await db.sessions.put({
        id: 'current',
        user: result.user,
        expiresAt: result.sessionExpiresAt,
      });
    } catch {
      /* The confirmed server update remains successful if local caching is unavailable. */
    }
    client.setQueryData(['operator'], result.user);
    client.setQueryData(key, {
      profile: result.profile,
      sessionExpiresAt: result.sessionExpiresAt,
    });
  }
  return (
    <>
      <PageTitle eyebrow="YOUR WORKSPACE ACCOUNT" title="Your profile" />
      {!online && <p role="status">Reconnect to change your profile or password.</p>}
      {profile.isError ? (
        <ErrorState error={profile.error} retry={() => void profile.refetch()} />
      ) : !profile.data ? (
        online ? (
          <Loading />
        ) : null
      ) : (
        <div className="profile-layout">
          <ProfileForm
            key={profile.data.profile.revision}
            profile={profile.data.profile}
            operatorId={user.id}
            online={online}
            onSaved={saved}
          />
          <PasswordForm operatorId={user.id} online={online} onSaved={saved} />
          <ProfileImages
            key={`images:${profile.data.profile.revision}`}
            revision={profile.data.profile.revision}
            available={profile.data.profile.imagesAvailable}
            hasImage={profile.data.profile.hasProfileImage}
            hasCover={profile.data.profile.hasCoverImage}
            online={online}
            operatorId={user.id}
            onAttached={async () => {
              await profile.refetch();
            }}
          />
          <section className="surface profile-status">
            <h2>Session & sign-in</h2>
            <p>Authenticator: {profile.data.profile.mfaEnabled ? 'Enabled' : 'Not enabled'}</p>
            <DeviceHandoffButton ownerId={user.id} online={online} />
            {online && [1, 2, 3].includes(user.role) && (
              <OperatorMfaButton
                operatorId={user.id}
                operatorName={user.name}
                actorId={user.id}
                self
                onChanged={mfaChanged}
              />
            )}
            <p>
              This session ends{' '}
              {new Intl.DateTimeFormat('en-IN', {
                timeZone: 'Asia/Kolkata',
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(profile.data.sessionExpiresAt)}
              .
            </p>
          </section>
        </div>
      )}
    </>
  );
}
function ProfileForm({
  profile,
  online,
  operatorId,
  onSaved,
}: {
  profile: Profile;
  operatorId: string;
  online: boolean;
  onSaved: (result: z.infer<typeof savedSchema>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.email || '',
    phone: profile.phone || '',
    contactEmail: profile.contactEmail || '',
    gender: profile.gender || '',
    age: profile.age === null ? '' : String(profile.age),
    otpMethod: profile.otpMethod,
    currentPassword: '',
  });
  const mutation = useMutation({
    mutationFn: () =>
      request(
        '/api/v1/operators/current/profile',
        {
          method: 'PATCH',
          operatorId,
          body: JSON.stringify({
            ...form,
            revision: profile.revision,
            email: form.email || null,
            phone: form.phone || null,
            contactEmail: form.contactEmail || null,
            gender: form.gender || null,
            age: form.age === '' ? null : Number(form.age),
            currentPassword: form.currentPassword || undefined,
          }),
        },
        savedSchema,
      ),
    onSuccess: onSaved,
    retry: false,
  });
  const sensitive =
    form.email !== (profile.email || '') ||
    form.phone !== (profile.phone || '') ||
    form.contactEmail !== (profile.contactEmail || '') ||
    form.otpMethod !== profile.otpMethod;
  return (
    <form
      className="surface profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (online) mutation.mutate();
      }}
    >
      <h2>Personal details</h2>
      <fieldset disabled={!online || mutation.isPending}>
        <label>
          First name
          <input
            value={form.firstName}
            maxLength={150}
            autoComplete="given-name"
            onChange={(event) => setForm({ ...form, firstName: event.target.value })}
          />
        </label>
        <label>
          Last name
          <input
            value={form.lastName}
            maxLength={150}
            autoComplete="family-name"
            onChange={(event) => setForm({ ...form, lastName: event.target.value })}
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={form.email}
            maxLength={254}
            readOnly={!profile.canChangeEmailAndPhone}
            required={profile.canChangeEmailAndPhone}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </label>
        <label>
          Phone
          <input
            type="tel"
            value={form.phone}
            pattern="[0-9]{10}"
            maxLength={10}
            readOnly={!profile.canChangeEmailAndPhone}
            required={profile.canChangeEmailAndPhone || form.otpMethod === 'sms'}
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
          />
        </label>
        <label>
          Gender
          <select
            value={form.gender}
            onChange={(event) => setForm({ ...form, gender: event.target.value })}
          >
            <option value="">Prefer not to say</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="O">Other</option>
          </select>
        </label>
        <label>
          Age
          <input
            type="number"
            min={0}
            max={2147483647}
            step={1}
            value={form.age}
            onChange={(event) => setForm({ ...form, age: event.target.value })}
          />
        </label>
        <label>
          OTP contact email
          <input
            type="email"
            maxLength={254}
            value={form.contactEmail}
            required={form.otpMethod === 'email'}
            onChange={(event) => setForm({ ...form, contactEmail: event.target.value })}
          />
        </label>
        <label>
          OTP delivery
          <select
            value={form.otpMethod}
            onChange={(event) =>
              setForm({ ...form, otpMethod: event.target.value === 'sms' ? 'sms' : 'email' })
            }
          >
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
        </label>
        {sensitive && (
          <label className="profile-wide">
            Current password
            <input
              type="password"
              autoComplete="current-password"
              maxLength={512}
              required
              value={form.currentPassword}
              onChange={(event) => setForm({ ...form, currentPassword: event.target.value })}
            />
          </label>
        )}
      </fieldset>
      {mutation.isError && <ErrorState error={mutation.error} />}
      <button className="button primary" disabled={!online || mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save profile'}
      </button>
    </form>
  );
}
function PasswordForm({
  operatorId,
  online,
  onSaved,
}: {
  online: boolean;
  operatorId: string;
  onSaved: (result: z.infer<typeof savedSchema>) => Promise<void>;
}) {
  const [currentPassword, setCurrent] = useState(''),
    [newPassword, setNew] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      request(
        '/api/v1/operators/current/password',
        {
          method: 'PUT',
          operatorId,
          body: JSON.stringify({ currentPassword, newPassword, confirmation }),
        },
        savedSchema,
      ),
    onSuccess: async (result) => {
      setCurrent('');
      setNew('');
      setConfirmation('');
      await onSaved(result);
    },
    retry: false,
  });
  return (
    <form
      className="surface profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        setMismatch(newPassword !== confirmation);
        if (online && newPassword === confirmation) mutation.mutate();
      }}
    >
      <h2>Change password</h2>
      <p>
        Use at least eight characters. Avoid common passwords, only numbers, and your personal
        information.
      </p>
      <fieldset disabled={!online || mutation.isPending}>
        <label className="profile-wide">
          Current password
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={512}
            value={currentPassword}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={512}
            value={newPassword}
            onChange={(event) => setNew(event.target.value)}
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            required
            maxLength={512}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
      </fieldset>
      {mismatch && <p role="alert">Passwords must match.</p>}
      {mutation.isError && <ErrorState error={mutation.error} />}
      {mutation.isSuccess && (
        <p role="status">Password changed. Your other sessions have been signed out.</p>
      )}
      <button className="button primary" disabled={!online || mutation.isPending}>
        {mutation.isPending ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}
