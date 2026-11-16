import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { Principal } from '../../../api/types';
import { ApiError, captureOperatorScope, request } from '../../../api/client';
import { Empty, ErrorState, Loading, PageTitle } from '../../../components/common';
import { useOnline } from '../../../hooks/use-pos';
import {
  batchBase,
  batchCapabilities,
  batchDetails,
  batchPhaseLabels,
  batchReceipt,
  batchSecret,
  downloadBatchArchive,
  saveBatchArchive,
  type BatchDetails,
} from './api';
import { GiftCardBatchHistory } from './history';
import { BatchConfirmationDialog, type BatchConfirmation } from './confirmation';
import '../styles.css';
import './styles.css';

type PendingCreation = { operationId: string; size: number; message: string };
const pendingPhases = new Set(['QUEUED', 'GENERATED', 'STORED', 'SENDING']);
export function GiftCardBatchesPage({ user }: { user: Principal }) {
  return <GiftCardBatchWorkspace key={user.id} user={user} />;
}
function GiftCardBatchWorkspace({ user }: { user: Principal }) {
  const allowed = user.userType === 1 && [1, 2].includes(user.role),
    online = useOnline(),
    client = useQueryClient(),
    lifetime = useRef(new AbortController());
  const [size, setSize] = useState(''),
    [message, setMessage] = useState(''),
    [creation, setCreation] = useState<PendingCreation | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [confirmation, setConfirmation] = useState<BatchConfirmation | null>(null),
    [resend, setResend] = useState(false),
    [password, setPassword] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState('');
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
  const jobs = useQuery({
    queryKey: [user.id, 'gift-card-batches', 'current-jobs'],
    enabled: allowed && online,
    gcTime: 0,
    retry: false,
    refetchInterval: 10000,
    queryFn: ({ signal }) =>
      request(
        batchBase + '/current-jobs',
        { operatorId: user.id, signal, cache: 'no-store' },
        z.object({ data: z.array(batchDetails).max(25) }),
      ),
  });
  const detail = useQuery<BatchDetails>({
    queryKey: [user.id, 'gift-card-batches', 'detail', selected],
    enabled: allowed && online && selected !== null,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.job && pendingPhases.has(query.state.data.job.phase) ? 5000 : false,
    queryFn: ({ signal }) =>
      request(
        batchBase + '/' + selected,
        { operatorId: user.id, signal, cache: 'no-store' },
        batchDetails,
      ),
  });
  const batch = detail.data;
  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    const scope = lifetime.current;
    return () => scope.abort();
  }, []);
  useEffect(() => {
    setPassword(null);
    setConfirmation(null);
  }, [selected]);
  function selectBatch(id: string | null) {
    setPassword(null);
    setConfirmation(null);
    setSelected(id);
  }
  function signal() {
    return AbortSignal.any([lifetime.current.signal, captureOperatorScope(user.id)]);
  }
  async function refresh() {
    await client.invalidateQueries({ queryKey: [user.id, 'gift-card-batches'] });
  }
  async function generate() {
    if (busy || !online || !meta.data?.generationAvailable) return;
    const parsed = Number(size);
    if (
      !creation &&
      (!Number.isInteger(parsed) || parsed < 1 || parsed > 10000 || !message.trim())
    ) {
      setError(new Error('Enter 1 to 10,000 cards and a batch message.'));
      return;
    }
    const command = creation || {
      operationId: crypto.randomUUID(),
      size: parsed,
      message: message.trim(),
    };
    setCreation(command);
    setBusy(true);
    setError(undefined);
    setNotice('');
    try {
      const scope = signal(),
        result = await request(
          batchBase,
          {
            method: 'POST',
            operatorId: user.id,
            signal: scope,
            cache: 'no-store',
            body: JSON.stringify(command),
          },
          batchReceipt,
        );
      scope.throwIfAborted();
      selectBatch(result.batchId);
      setCreation(null);
      setSize('');
      setMessage('');
      setNotice(result.message);
      await refresh();
    } catch (failure) {
      if (!lifetime.current.signal.aborted) {
        if (failure instanceof ApiError && [400, 401, 403, 422, 503].includes(failure.status))
          setCreation(null);
        setError(failure);
      }
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  function confirm(action: BatchConfirmation['action'], batch: BatchDetails) {
    setPassword(null);
    setError(undefined);
    setResend(false);
    setConfirmation({
      operationId: crypto.randomUUID(),
      batchId: batch.id,
      expectedVersion: action === 'retry' ? batch.job!.version : batch.version,
      action,
      requiresResend: action === 'retry' && ['UNCERTAIN', 'DELIVERED'].includes(batch.job!.phase),
    });
  }
  async function commit() {
    if (!confirmation || busy || !online || (confirmation.requiresResend && !resend)) return;
    setBusy(true);
    setError(undefined);
    const command = confirmation;
    try {
      const scope = signal(),
        base = batchBase + '/' + command.batchId,
        payload = { operationId: command.operationId, expectedVersion: command.expectedVersion };
      const result = await request(
        base +
          (command.action === 'print'
            ? '/print-status'
            : command.action === 'retry'
              ? '/retries'
              : '/block-status'),
        {
          method: command.action === 'retry' ? 'POST' : 'PUT',
          operatorId: user.id,
          signal: scope,
          cache: 'no-store',
          body: JSON.stringify({
            ...payload,
            ...(command.action === 'print'
              ? { printed: true }
              : command.action === 'retry'
                ? { confirmResend: resend }
                : { blocked: command.action === 'block' }),
          }),
        },
        batchReceipt,
      );
      scope.throwIfAborted();
      setNotice(result.message);
      setConfirmation(null);
      await refresh();
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(failure);
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  async function reveal() {
    if (!selected || busy || !online) return;
    setBusy(true);
    setError(undefined);
    try {
      const scope = signal(),
        value = await request(
          batchBase + '/' + selected + '/artifact-access',
          { method: 'POST', operatorId: user.id, signal: scope, cache: 'no-store', body: '{}' },
          batchSecret,
        );
      scope.throwIfAborted();
      setPassword(value.password);
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(failure);
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  async function download() {
    if (!selected || busy || !online) return;
    setBusy(true);
    setError(undefined);
    try {
      const scope = signal(),
        blob = await downloadBatchArchive(user.id, selected, scope);
      scope.throwIfAborted();
      saveBatchArchive(blob, selected);
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(failure);
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  if (!allowed) return <Empty title="Internal gift card administration access is required" />;
  return (
    <>
      <PageTitle eyebrow="ADMINISTRATION" title="Gift card batches" />
      {!online && (
        <p role="status">Reconnect to generate cards, view private files, or change a batch.</p>
      )}
      {error !== undefined && <ErrorState error={error} />}
      {notice && <p role="status">{notice}</p>}
      {meta.isError && <ErrorState error={meta.error} retry={() => void meta.refetch()} />}
      <div className="gift-card-batch-grid">
        <section className="surface gift-card-batch-panel">
          <h2>Generate cards</h2>
          <p>
            Create an encrypted CSV archive. Generating a batch does not load money onto the cards.
          </p>
          {!meta.data?.generationAvailable && (
            <p>
              Batch generation is unavailable until private storage, delivery, and your email are
              configured.
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void generate();
            }}
          >
            <label>
              Number of cards
              <input
                aria-label="Number of gift cards"
                type="number"
                min="1"
                max="10000"
                step="1"
                required
                value={size}
                disabled={busy || creation !== null}
                onChange={(event) => setSize(event.target.value)}
              />
            </label>
            <label>
              Batch message
              <input
                aria-label="Gift card batch message"
                maxLength={255}
                required
                value={message}
                disabled={busy || creation !== null}
                onChange={(event) => setMessage(event.target.value)}
              />
            </label>
            {meta.data?.recipient && <p>Email: {meta.data.recipient}</p>}
            {creation && (
              <p role="status">
                Keep this page open. Retry the same request if its result was lost; cards will not
                be generated twice.
              </p>
            )}
            <button
              className="button primary"
              disabled={!online || busy || !meta.data?.generationAvailable}
            >
              {busy ? 'Working…' : creation ? 'Retry generation request' : 'Generate gift cards'}
            </button>
          </form>
        </section>
        <section className="surface gift-card-batch-panel">
          <h2>Your current batches</h2>
          <p>Recover a queued request or review a recent archive here.</p>
          {jobs.isError && <ErrorState error={jobs.error} retry={() => void jobs.refetch()} />}
          {jobs.isPending && online && <Loading />}
          {jobs.data?.data.length === 0 && <p>No current batches.</p>}
          <ul className="gift-card-batch-jobs">
            {jobs.data?.data.map((batch) => (
              <li key={batch.id}>
                <button
                  className="button secondary"
                  disabled={!online || busy}
                  onClick={() => selectBatch(batch.id)}
                >
                  Batch {batch.id}
                </button>
                <span>
                  {batch.size.toLocaleString()} cards ·{' '}
                  {batch.job ? batchPhaseLabels[batch.job.phase] : 'Legacy batch'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {selected && (
        <section className="surface gift-card-batch-panel" aria-label="Selected gift card batch">
          <div className="gift-card-batch-heading">
            <h2>Batch {selected}</h2>
            <button
              className="button secondary"
              disabled={!online || busy}
              onClick={() => {
                setPassword(null);
                setConfirmation(null);
                void detail.refetch();
              }}
            >
              Reload batch
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setPassword(null);
              }}
            >
              Close batch
            </button>
          </div>
          {detail.isPending && <Loading />}
          {detail.isError && (
            <ErrorState error={detail.error} retry={() => void detail.refetch()} />
          )}
          {batch && (
            <>
              <p>
                {batch.message || 'No batch message'} · {batch.size.toLocaleString()} cards
              </p>
              <p role="status">
                {batch.job
                  ? batchPhaseLabels[batch.job.phase]
                  : batch.completed
                    ? 'Archive generated'
                    : 'Generation incomplete'}{' '}
                · {batch.blocked ? 'Blocked' : 'Active'} ·{' '}
                {batch.printed ? 'Printed' : 'Not marked printed'}
              </p>
              {batch.job?.phase === 'UNCERTAIN' && (
                <p>
                  We could not confirm whether the email was accepted. Check the inbox before
                  choosing to send the same file again.
                </p>
              )}
              {batch.job?.phase === 'DELIVERED' && (
                <p>The email provider accepted this file. Inbox delivery has not been verified.</p>
              )}
              <div className="administration-actions">
                {batch.completed && !batch.printed && (
                  <button
                    className="button secondary"
                    disabled={!online || busy}
                    onClick={() => confirm('print', batch)}
                  >
                    Mark as printed
                  </button>
                )}
                <button
                  className="button secondary"
                  disabled={!online || busy}
                  onClick={() => confirm(batch.blocked ? 'unblock' : 'block', batch)}
                >
                  {batch.blocked ? 'Unblock batch' : 'Block batch'}
                </button>
                {batch.job?.canRetry && (
                  <button
                    className="button secondary"
                    disabled={!online || busy}
                    onClick={() => confirm('retry', batch)}
                  >
                    Retry batch delivery
                  </button>
                )}
                {batch.artifactAvailable && (
                  <>
                    <button
                      className="button secondary"
                      disabled={!online || busy}
                      onClick={() => void download()}
                    >
                      Download encrypted CSV
                    </button>
                    <button
                      className="button secondary"
                      disabled={!online || busy}
                      onClick={() => (password ? setPassword(null) : void reveal())}
                    >
                      {password ? 'Hide archive password' : 'Show archive password'}
                    </button>
                  </>
                )}
              </div>
              {password && (
                <div className="gift-card-batch-secret">
                  <p>
                    Open the ZIP with an AES256 compatible archive application. Keep this password
                    private.
                  </p>
                  <output aria-label="Gift card archive password">{password}</output>
                </div>
              )}
            </>
          )}
        </section>
      )}
      <GiftCardBatchHistory
        user={user}
        online={online}
        today={meta.data?.today}
        busy={busy}
        onSelect={selectBatch}
      />
      {confirmation && (
        <BatchConfirmationDialog
          command={confirmation}
          busy={busy}
          online={online}
          resend={resend}
          error={error}
          onResend={setResend}
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
