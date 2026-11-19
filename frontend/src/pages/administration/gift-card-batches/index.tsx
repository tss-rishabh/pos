import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Principal } from '../../../api/types';
import { captureOperatorScope, request } from '../../../api/client';
import { Empty, ErrorState, PageTitle } from '../../../components/common';
import { useOnline } from '../../../hooks/use-pos';
import { batchBase, batchCapabilities, batchResult, validateBatchRequest } from './api';
import { GiftCardBatchHistory } from './history';
import { BatchConfirmationDialog, type BatchConfirmation } from './confirmation';
import '../styles.css';
import './styles.css';

/**
 * "Gift Card Management" (core/templates/gift_card/index.html). Access as legacy
 * `advance_permisson("[1,2]")` + `user_type_exempt("[2]")` (core/views.py:2169-2170).
 */
export function GiftCardBatchesPage({ user }: { user: Principal }) {
  return <GiftCardBatchWorkspace key={user.id} user={user} />;
}
function GiftCardBatchWorkspace({ user }: { user: Principal }) {
  const allowed = user.userType !== 2 && [1, 2].includes(user.role),
    online = useOnline(),
    client = useQueryClient(),
    lifetime = useRef(new AbortController()),
    pending = useRef<{ operationId: string; size: number; message: string } | null>(null);
  const [size, setSize] = useState('10'),
    [message, setMessage] = useState(''),
    [confirmation, setConfirmation] = useState<BatchConfirmation | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState<{ text: string; tone: 'success' | 'warning' } | null>(null);
  const meta = useQuery({
    queryKey: [user.id, 'gift-card-batches', 'capabilities'],
    enabled: allowed && online,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      request(
        batchBase + '/capabilities',
        { operatorId: user.id, signal, cache: 'no-store' },
        batchCapabilities,
      ),
  });
  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    const scope = lifetime.current;
    return () => scope.abort();
  }, []);
  const signal = () => AbortSignal.any([lifetime.current.signal, captureOperatorScope(user.id)]);
  const refresh = () => client.invalidateQueries({ queryKey: [user.id, 'gift-card-batches'] });
  async function generate() {
    if (busy || !online) return;
    const warning = validateBatchRequest(size, message);
    if (warning) {
      setNotice({ text: warning, tone: 'warning' });
      return;
    }
    const parsed = Number.parseFloat(size);
    // Reuse the operation id while the same request is retried after a lost response.
    if (!pending.current || pending.current.size !== parsed || pending.current.message !== message)
      pending.current = { operationId: crypto.randomUUID(), size: parsed, message };
    setBusy(true);
    setError(undefined);
    setNotice(null);
    try {
      const scope = signal(),
        result = await request(
          batchBase,
          {
            method: 'POST',
            operatorId: user.id,
            signal: scope,
            cache: 'no-store',
            body: JSON.stringify(pending.current),
          },
          batchResult,
        );
      scope.throwIfAborted();
      pending.current = null;
      setNotice({ text: result.message, tone: 'success' });
      await refresh();
    } catch (failure) {
      if (!lifetime.current.signal.aborted) {
        setError(failure);
        await refresh();
      }
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  async function commit() {
    if (!confirmation || busy || !online) return;
    setBusy(true);
    setError(undefined);
    try {
      const scope = signal(),
        base = batchBase + '/' + confirmation.batchId;
      const result = await request(
        base + (confirmation.action === 'print' ? '/print-status' : '/block-status'),
        {
          method: 'PUT',
          operatorId: user.id,
          signal: scope,
          cache: 'no-store',
          body: JSON.stringify(confirmation.action === 'print' ? {} : { opr: confirmation.action }),
        },
        batchResult,
      );
      scope.throwIfAborted();
      setNotice({ text: result.message, tone: 'success' });
      setConfirmation(null);
      await refresh();
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(failure);
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  if (!allowed) return <Empty title="Permission denied" />;
  return (
    <>
      <PageTitle title="Gift Card Management" />
      {!online && <p role="status">Reconnect to generate or change gift card collections.</p>}
      {error !== undefined && !confirmation && <ErrorState error={error} />}
      {notice && (
        <p role="status" className={notice.tone === 'warning' ? 'warning' : undefined}>
          {notice.text}
        </p>
      )}
      {meta.isError && <ErrorState error={meta.error} retry={() => void meta.refetch()} />}
      <section className="surface gift-card-batch-panel">
        <form
          className="gift-card-batch-form"
          onSubmit={(event) => {
            event.preventDefault();
            void generate();
          }}
        >
          <label>
            Collection Size: <small>(Maximum 10,000)</small>
            <input
              aria-label="Collection size"
              type="number"
              min="0"
              max="10000"
              placeholder="Collection size"
              value={size}
              disabled={busy}
              onChange={(event) => setSize(event.target.value)}
            />
          </label>
          <label>
            Message:
            <input
              aria-label="Message"
              placeholder="Enter message..."
              maxLength={255}
              value={message}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={!online || busy || meta.data?.generationAvailable === false}
          >
            {busy ? 'Working…' : 'Generate Gift Cards'}
          </button>
        </form>
        {meta.data?.generationAvailable === false && (
          <p>Gift card generation is not configured on this server.</p>
        )}
        <h3>File Access Instructions:</h3>
        <ul>
          <li>
            You will receive the file via email at your ID:{' '}
            <strong>({meta.data?.email ?? ''})</strong>.
          </li>
          <li>
            The password required to access the file will be a combination of the last 6 digits of
            the phone number of the user who generated the file, along with the collection number.
          </li>
          <li>
            For example, if the user&apos;s phone number is <strong>0123456789</strong> and the
            collection number is <strong>10</strong>, the password to access the file would be{' '}
            <strong>45678910</strong>.
          </li>
        </ul>
      </section>
      <GiftCardBatchHistory
        user={user}
        online={online}
        busy={busy}
        onAction={(batch, action) => {
          setError(undefined);
          setConfirmation({ batchId: batch.id, action });
        }}
      />
      {confirmation && (
        <BatchConfirmationDialog
          command={confirmation}
          busy={busy}
          online={online}
          error={error}
          onClose={() => {
            setConfirmation(null);
            setError(undefined);
          }}
          onConfirm={() => void commit()}
        />
      )}
    </>
  );
}
