import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut } from 'lucide-react';
import { z } from 'zod';
import type { Counter, Principal, Store } from '../api/types';
import { request } from '../api/client';
import { checkInSchema } from '../pages/administration/api';
import { useCounters } from '../hooks/use-pos';
import { useWorkspace } from '../state/workspace';
import { ErrorState } from './common';
import { Modal } from './modal';
import { Spinner } from './loader';

const responseSchema = z.object({ data: checkInSchema.nullable() });
const freshSignInKey = 'pos-fresh-sign-in';

/** The login page marks an interactive sign-in so the workspace can ask for a check-in once. */
export function markFreshSignIn() {
  try {
    sessionStorage.setItem(freshSignInKey, '1');
  } catch {
    // Without session storage the operator checks in from the header instead.
  }
}
function readFreshSignIn(): boolean {
  try {
    return sessionStorage.getItem(freshSignInKey) === '1';
  } catch {
    return false;
  }
}
function clearFreshSignIn() {
  try {
    sessionStorage.removeItem(freshSignInKey);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The operator's server check-in (shared `my-check-in` query, as the notification and reminder
 * features read it) with the legacy check-in and check-out commands. The backend semantics are
 * unchanged: PUT /operators/me/check-in with the store and counter, DELETE to check out.
 */
export function useCheckIn(user: Principal, online: boolean) {
  const client = useQueryClient();
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const current = useQuery({
    queryKey: [user.id, 'administration', 'my-check-in'],
    enabled: online,
    queryFn: ({ signal }) =>
      request('/api/v1/operators/me/check-in', { operatorId: user.id, signal }, responseSchema),
    staleTime: 10000,
    retry: false,
  });
  const record = current.data?.data ?? null;
  const expiresAt = record ? Date.parse(record.expiresAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expiresAt)) return;
    const update = () => setNow(Date.now());
    const timer = window.setTimeout(
      update,
      Math.max(0, Math.min(2147483647, expiresAt - Date.now() + 1)),
    );
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [expiresAt]);
  const active = record && expiresAt > Math.max(now, Date.now()) ? record : null;
  async function run(work: () => Promise<z.infer<typeof checkInSchema> | null>) {
    setBusy(true);
    setError(null);
    try {
      const confirmed = await work();
      const key = [user.id, 'administration', 'my-check-in'];
      // Publish the new check-in before anything else refreshes, so features that exist only for
      // a checked-in store (notifications, expiry and day-close reminders) are switched off before
      // a check-out could refetch them (403), or start once from the server's own record.
      if (confirmed === null) client.setQueryData(key, { data: null });
      else await client.refetchQueries({ queryKey: key, exact: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Then refresh the operator's other reads once; reads already started are shared.
      await client.invalidateQueries(
        {
          queryKey: [user.id],
          predicate: (query) =>
            query.queryKey[1] !== 'administration' || query.queryKey[2] !== 'my-check-in',
        },
        { cancelRefetch: false },
      );
      return true;
    } catch (failure) {
      setError(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return {
    online,
    pending: online && current.isPending,
    failed: online && current.isError,
    loaded: online && current.isSuccess,
    checkIn: active,
    busy,
    error,
    clearError: () => setError(null),
    checkInAt: (storeId: string, counterId: string) =>
      run(() =>
        request(
          '/api/v1/operators/me/check-in',
          {
            operatorId: user.id,
            method: 'PUT',
            body: JSON.stringify({ storeId, counterId: counterId || null }),
          },
          checkInSchema,
        ),
      ),
    checkOut: () =>
      run(async () => {
        await request('/api/v1/operators/me/check-in', { operatorId: user.id, method: 'DELETE' });
        return null;
      }),
  };
}
export type CheckInState = ReturnType<typeof useCheckIn>;

/** Header check-in status and the check-in / check-out toggle for the selected store/counter. */
export function CheckInControl({
  state,
  stores,
  storeId,
  counterId,
}: {
  state: CheckInState;
  stores: readonly Store[];
  storeId: string;
  counterId: string;
}) {
  const record = state.checkIn;
  const here = Boolean(record && record.storeId === storeId);
  const storeName = (id: string) => stores.find((store) => store.id === id)?.name || `store ${id}`;
  let label: string,
    tone: 'ok' | 'warn' | 'muted' = 'muted';
  if (!state.online) label = 'Check-in unverified offline';
  else if (state.pending) label = 'Checking check-in…';
  else if (state.failed) label = 'Check-in unavailable';
  else if (record && here) {
    label = 'Checked in';
    tone = 'ok';
  } else if (record) {
    label = `Checked in at ${storeName(record.storeId)}`;
    tone = 'warn';
  } else {
    label = 'Not checked in';
    tone = 'warn';
  }
  const title = record
    ? `Checked in at ${storeName(record.storeId)}${record.counterId ? `, counter ${record.counterId}` : ''} until ${new Date(record.expiresAt).toLocaleString()}`
    : undefined;
  return (
    <div className="check-in-control">
      <span
        className={`check-in-status ${tone}`}
        title={title}
        aria-label={`Store check-in: ${label}`}
      >
        {state.pending ? <Spinner size={12} /> : <span className="status-dot" aria-hidden="true" />}
        <span>{label}</span>
      </span>
      {state.loaded && !here && (
        <button
          type="button"
          className="button secondary small"
          disabled={!storeId || state.busy}
          aria-busy={state.busy}
          onClick={() => void state.checkInAt(storeId, counterId)}
        >
          {!state.busy && <LogIn size={14} aria-hidden="true" />}
          {record ? 'Check in here' : 'Check in'}
        </button>
      )}
      {state.loaded && record && (
        <button
          type="button"
          className="button secondary small"
          disabled={state.busy}
          aria-busy={state.busy}
          onClick={() => void state.checkOut()}
        >
          {!state.busy && <LogOut size={14} aria-hidden="true" />}
          Check out
        </button>
      )}
      {state.error !== null && (
        <span
          role="alert"
          className="check-in-error"
          title={state.error instanceof Error ? state.error.message : undefined}
        >
          {state.error instanceof Error ? state.error.message : 'Check-in failed.'}
        </span>
      )}
    </div>
  );
}

/**
 * Right after an interactive sign-in without a current check-in, ask for the store and counter
 * from the operator's assigned stores. "Not now" keeps the legacy "Not at the store" choice; the
 * header control checks in later.
 */
export function CheckInPrompt({
  user,
  state,
  stores,
}: {
  user: Principal;
  state: CheckInState;
  stores: readonly Store[];
}) {
  const [fresh] = useState(readFreshSignIn);
  const [dismissed, setDismissed] = useState(false);
  const workspace = useWorkspace();
  const [storeId, setStoreId] = useState(() =>
    stores.some((store) => store.id === workspace.storeId)
      ? workspace.storeId
      : stores.length === 1
        ? stores[0]!.id
        : '',
  );
  const [counterId, setCounterId] = useState('');
  const [touched, setTouched] = useState(false);
  // Preselect the header's store once the workspace has chosen it.
  useEffect(() => {
    if (!touched && !storeId && stores.some((store) => store.id === workspace.storeId))
      setStoreId(workspace.storeId);
  }, [touched, storeId, stores, workspace.storeId]);
  const counters = useCounters(user.id, storeId);
  useEffect(() => {
    const list: readonly Counter[] | undefined = counters.data;
    if (list && !list.some((counter) => counter.id === counterId))
      setCounterId(
        storeId === workspace.storeId && list.some((counter) => counter.id === workspace.counterId)
          ? workspace.counterId
          : (list[0]?.id ?? ''),
      );
  }, [counters.data, counterId, storeId, workspace.storeId, workspace.counterId]);
  const resolved = !fresh || dismissed || (state.loaded && state.checkIn !== null);
  // The prompt belongs to one sign-in: once answered (or already checked in) it stays closed.
  useEffect(() => {
    if (resolved) clearFreshSignIn();
  }, [resolved]);
  if (resolved || !state.loaded || stores.length === 0) return null;
  async function submit() {
    if (!storeId) return;
    if (await state.checkInAt(storeId, counterId)) {
      workspace.setStore(storeId);
      if (counterId) workspace.setCounter(counterId);
      setDismissed(true);
    }
  }
  return (
    <Modal
      size="sm"
      title="Check in to your store"
      description="Choose the store and counter you are working at."
      closeLabel="Not now"
      onClose={() => {
        state.clearError();
        setDismissed(true);
      }}
      footer={
        <>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              state.clearError();
              setDismissed(true);
            }}
          >
            Not now
          </button>
          <button
            type="submit"
            form="check-in-prompt"
            className="button primary"
            disabled={!storeId || state.busy || counters.isFetching}
            aria-busy={state.busy}
          >
            Check in
          </button>
        </>
      }
    >
      <form
        id="check-in-prompt"
        className="form-grid single"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Store
          <select
            aria-label="Store"
            autoFocus
            required
            value={storeId}
            onChange={(event) => {
              setTouched(true);
              setStoreId(event.target.value);
              setCounterId('');
            }}
          >
            <option value="">Select a store</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Counter
          <select
            aria-label="Counter"
            value={counterId}
            disabled={!storeId || counters.isPending}
            onChange={(event) => setCounterId(event.target.value)}
          >
            {!counters.data?.length && (
              <option value="">
                {storeId && counters.isPending ? 'Loading counters…' : 'No counter'}
              </option>
            )}
            {counters.data?.map((counter) => (
              <option key={counter.id} value={counter.id}>
                {counter.name}
              </option>
            ))}
          </select>
        </label>
      </form>
      {state.error !== null && <ErrorState error={state.error} />}
    </Modal>
  );
}
