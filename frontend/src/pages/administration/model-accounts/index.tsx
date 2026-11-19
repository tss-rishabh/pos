import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Principal } from '../../../api/types';
import { ApiError, captureOperatorScope, request } from '../../../api/client';
import { Empty, ErrorState, Loading, PageTitle } from '../../../components/common';
import { useOnline } from '../../../hooks/use-pos';
import {
  accountCapabilities,
  accountCapabilitiesPath,
  createAccount,
  readAccount,
  type AccountResult,
} from './api';
import { pendingAccounts, removePendingAccount, savePendingAccount } from './pending';
import '../styles.css';
function initial(ownerId: string) {
  try {
    return { rows: pendingAccounts(ownerId), error: null };
  } catch (error) {
    return { rows: [], error };
  }
}
function AccountForm({ user }: { user: Principal }) {
  const online = useOnline(),
    client = useQueryClient(),
    [saved] = useState(() => initial(user.id)),
    [pending, setPending] = useState(saved.rows),
    [storageError, setStorageError] = useState<unknown>(saved.error),
    [error, setError] = useState<unknown>(null),
    [result, setResult] = useState<AccountResult | null>(null),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [retryId, setRetryId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    running = useRef(false),
    owner = useRef<AbortController | null>(null);
  const capabilities = useQuery({
    queryKey: [user.id, 'administration', 'model-account-capabilities'],
    queryFn: ({ signal }) =>
      request(accountCapabilitiesPath, { operatorId: user.id, signal }, accountCapabilities),
  });
  useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    const reload = () => {
      try {
        setPending(pendingAccounts(user.id));
        setStorageError(null);
      } catch (problem) {
        setStorageError(problem);
      }
    };
    window.addEventListener('storage', reload);
    return () => {
      controller.abort();
      window.removeEventListener('storage', reload);
    };
  }, [user.id]);
  function scope() {
    if (!owner.current) throw new DOMException('This editor is closed.', 'AbortError');
    return AbortSignal.any([owner.current.signal, captureOperatorScope(user.id)]);
  }
  function publish(receipt: AccountResult, signal: AbortSignal) {
    signal.throwIfAborted();
    setResult(receipt);
    setRetryId(null);
    setError(null);
    setUsername('');
    setPassword('');
    setConfirmation('');
    try {
      removePendingAccount(user.id, receipt.operationId);
      setPending(pendingAccounts(user.id));
      setStorageError(null);
    } catch (problem) {
      setStorageError(problem);
    }
    void client
      .invalidateQueries({ queryKey: [user.id, 'administration'], refetchType: 'none' })
      .catch(() => undefined);
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running.current || !online) return;
    let signal: AbortSignal;
    try {
      signal = scope();
    } catch (problem) {
      setError(problem);
      return;
    }
    if (!username.trim() || !password || password !== confirmation) {
      setError(new Error('Enter a username and matching passwords.'));
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const remaining = pendingAccounts(user.id);
      if (remaining.length && !retryId)
        throw new Error('Check the original account operation before starting another.');
      if (retryId && !remaining.some((row) => row.operationId === retryId))
        throw new Error('The original operation changed. Reload before continuing.');
      const input = {
        operationId: retryId || crypto.randomUUID(),
        username,
        password,
        confirmation,
      };
      savePendingAccount(user.id, input.operationId);
      setPending(pendingAccounts(user.id));
      signal.throwIfAborted();
      setPassword('');
      setConfirmation('');
      setRetryId(null);
      publish(await createAccount(user.id, input, signal), signal);
    } catch (problem) {
      if (!signal.aborted) setError(problem);
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  async function reconcile(operationId: string) {
    if (running.current || !online) return;
    const signal = scope();
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      publish(await readAccount(user.id, operationId, signal), signal);
    } catch (problem) {
      if (signal.aborted) return;
      if (problem instanceof ApiError && problem.code === 'OPERATOR_MODEL_ACCOUNT_NOT_FOUND') {
        // Retain the same UUID even if an earlier request is still in flight.
        setRetryId(operationId);
        setError(
          new Error(
            'The original request has no saved result yet. Re-enter its username and password to retry the same operation.',
          ),
        );
      } else setError(problem);
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <PageTitle title="Administrative account creation" />
      <p className="administration-notice">
        New accounts have the Super admin business role, are active and in-house, and start without
        staff/superuser grants, store access, contact details or MFA enrollment. Their email is
        blank. Complete the existing blank-email account before adding another. Use standard staff
        creation for a complete staff profile.
      </p>
      {storageError !== null && <ErrorState error={storageError} />}
      {error !== null && <ErrorState error={error} />}
      {pending.length > 0 && (
        <section className="surface">
          <h2>Original account operations</h2>
          <p>
            Recovery reads the original result. It does not create another account or reset its
            password.
          </p>
          {pending.map((row) => (
            <p key={row.operationId}>
              <code>{row.operationId}</code>{' '}
              <button
                className="button secondary"
                disabled={busy || !online}
                onClick={() => void reconcile(row.operationId)}
              >
                Check original account request
              </button>
            </p>
          ))}
        </section>
      )}
      {result && (
        <section className="surface administration-status" role="status">
          <h2>Account created</h2>
          <p>
            {result.message} Operator ID: <strong>{result.id}</strong>
          </p>
          <p>Complete the account profile, store access and sign-in verification before use.</p>
          <a className="button secondary" href="/administration">
            Open administration
          </a>
        </section>
      )}
      {capabilities.isPending ? (
        <Loading />
      ) : capabilities.isError ? (
        <ErrorState error={capabilities.error} />
      ) : (
        <form
          className="surface administration-section-gap"
          onSubmit={(event) => void submit(event)}
        >
          <h2>{retryId ? 'Retry the original request' : 'Username and password'}</h2>
          <label>
            Username
            <input
              aria-label="Administrative username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              maxLength={600}
              required
              disabled={busy}
            />
          </label>
          <label>
            Password
            <input
              aria-label="New administrative password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="new-password"
              maxLength={512}
              required
              disabled={busy}
            />
          </label>
          <label>
            Confirm password
            <input
              aria-label="Confirm administrative password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              type="password"
              autoComplete="new-password"
              maxLength={512}
              required
              disabled={busy}
            />
          </label>
          <p>
            Use at least eight characters and avoid common, entirely numeric or username-similar
            passwords. Passwords are cleared after dispatch and are never saved for recovery.
          </p>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !online || storageError !== null || (pending.length > 0 && !retryId)}
          >
            {retryId ? 'Retry original account request' : 'Create administrative account'}
          </button>
          {!online && <p>Reconnect to create or recover an account.</p>}
          {busy && <p role="status">Processing account operation…</p>}
        </form>
      )}
    </>
  );
}
export default function OperatorModelAccountsPage({ user }: { user: Principal }) {
  if (user.role !== 1 || user.userType !== 1)
    return <Empty title="Internal model administration access is required" />;
  return <AccountForm key={user.id} user={user} />;
}
