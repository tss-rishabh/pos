import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { ErrorState, Loading } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { pendingSlackConnection } from './slack-return';

const viewSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
const attemptSchema = z.object({
  id: z.uuid(),
  storeId: z.string().regex(/^[1-9]\d*$/),
  state: z.enum(['PENDING', 'EXCHANGING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']),
  errorCode: z.string().nullable(),
  channel: z.string().nullable(),
  expiresAt: z.number(),
});
const startSchema = z.object({
  id: z.uuid(),
  expiresAt: z.number(),
  authorizationUrl: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value),
      redirect = url.searchParams.get('redirect_uri');
    if (
      url.origin !== 'https://slack.com' ||
      url.pathname !== '/oauth/v2/authorize' ||
      url.hash ||
      url.username ||
      url.password ||
      url.searchParams.get('scope') !== 'incoming-webhook' ||
      !/^\d+\.\d+$/.test(url.searchParams.get('client_id') || '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') || '') ||
      !redirect ||
      !URL.canParse(redirect)
    )
      return false;
    const target = new URL(redirect);
    return (
      target.origin === window.location.origin &&
      target.pathname === '/api/v1/admin/slack/oauth/callback' &&
      !target.search &&
      !target.hash &&
      !target.username &&
      !target.password &&
      [...url.searchParams.keys()].every((key) =>
        ['scope', 'client_id', 'redirect_uri', 'state'].includes(key),
      )
    );
  }),
});
function clearReturn() {
  const url = new URL(window.location.href);
  if (url.searchParams.has('slackConnection')) {
    url.searchParams.delete('slackConnection');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
}
function SlackDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="administration-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="administration-dialog-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close Slack connection" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function ConnectionEditor({
  user,
  storeId,
  storeName,
  onClose,
}: {
  user: Principal;
  storeId: string;
  storeName: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    operation = useRef(crypto.randomUUID()),
    controller = useRef(new AbortController()),
    online = useOnline();
  const path = `/api/v1/admin/stores/${storeId}`;
  const view = useQuery({
    queryKey: [user.id, 'administration', 'slack-connection', storeId],
    queryFn: ({ signal }) =>
      request(
        `${path}/slack-connection`,
        { operatorId: user.id, cache: 'no-store', signal },
        viewSchema,
      ),
    retry: false,
  });
  useEffect(() => () => controller.current.abort(), []);
  async function connect() {
    if (!view.data || busy || !online) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request(
        `${path}/slack-connections`,
        {
          method: 'POST',
          operatorId: user.id,
          cache: 'no-store',
          signal: controller.current.signal,
          body: JSON.stringify({
            operationId: operation.current,
            expectedVersion: view.data.version,
          }),
        },
        startSchema,
      );
      controller.current.signal.throwIfAborted();
      window.location.assign(result.authorizationUrl);
    } catch (failure) {
      if (!controller.current.signal.aborted) {
        setError(failure);
        setBusy(false);
      }
    }
  }
  return (
    <SlackDialog title={`Slack connection for ${storeName}`} onClose={onClose}>
      {view.isPending ? (
        <Loading />
      ) : view.isError ? (
        <ErrorState error={view.error} retry={() => void view.refetch()} />
      ) : (
        <>
          <p>
            {view.data.configured
              ? 'A Slack connection is configured. Authorize a new channel to replace it.'
              : 'Connect a Slack channel for this store’s notifications.'}
          </p>
          <p className="administration-notice">
            Continue to Slack in this window and choose the channel. The connection is saved when
            authorization completes.
          </p>
          {!view.data.enabled && <p>Slack connection setup is currently unavailable.</p>}
          <button
            className="button primary"
            disabled={!online || !view.data.enabled || busy}
            onClick={() => void connect()}
          >
            {busy ? 'Opening Slack…' : 'Continue to Slack'}
          </button>
          {error !== null && <ErrorState error={error} />}
        </>
      )}
    </SlackDialog>
  );
}
export function StoreSlackButton({
  user,
  storeId,
  storeName,
}: {
  user: Principal;
  storeId: string;
  storeName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="button secondary" onClick={() => setOpen(true)}>
        Slack
      </button>
      {open && (
        <ConnectionEditor
          user={user}
          storeId={storeId}
          storeName={storeName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function SlackConnectionReturn({ user }: { user: Principal }) {
  const [id, setId] = useState<string | null>(() => pendingSlackConnection()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    online = useOnline(),
    client = useQueryClient();
  useEffect(clearReturn, []);
  const view = useQuery({
    queryKey: [user.id, 'administration', 'slack-result', id],
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      request(
        `/api/v1/admin/slack/connections/${id}`,
        { operatorId: user.id, cache: 'no-store', signal },
        attemptSchema,
      ),
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === 'EXCHANGING' ? 1000 : false),
  });
  useEffect(() => {
    if (view.data?.state === 'COMPLETED')
      void client.invalidateQueries({
        queryKey: [user.id, 'administration', '/api/v1/admin/stores'],
      });
  }, [client, user.id, view.data?.state]);
  if (!id) return null;
  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await request(
        `/api/v1/admin/slack/connections/${id}/cancellation`,
        { method: 'POST', operatorId: user.id, body: '{}' },
        attemptSchema,
      );
      await view.refetch({ throwOnError: true });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const state = view.data?.state;
  return (
    <SlackDialog title="Slack connection result" onClose={() => setId(null)}>
      {view.isPending ? (
        <Loading />
      ) : view.isError ? (
        <ErrorState error={view.error} />
      ) : (
        <>
          {state === 'COMPLETED' ? (
            <p role="status">
              Slack channel {view.data.channel || ''} connected to store {view.data.storeId}.
            </p>
          ) : state === 'PENDING' || state === 'EXCHANGING' ? (
            <p role="status">
              {state === 'EXCHANGING'
                ? 'Completing Slack authorization…'
                : 'Slack authorization has not completed.'}
            </p>
          ) : (
            <p role="status">
              {state === 'CANCELLED'
                ? 'Slack connection cancelled.'
                : state === 'EXPIRED'
                  ? 'This Slack authorization expired. Start a new connection.'
                  : 'Slack connection was not saved. Reload the store and start a new connection.'}
            </p>
          )}
          {(state === 'PENDING' || state === 'EXCHANGING') && (
            <button
              className="button secondary"
              disabled={busy || !online}
              onClick={() => void cancel()}
            >
              Cancel pending connection
            </button>
          )}
          {error !== null && <ErrorState error={error} />}
        </>
      )}
    </SlackDialog>
  );
}
