import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Principal } from '../../../api/types';
import { ApiError, captureOperatorScope } from '../../../api/client';
import { currency } from '../../../lib/format';
import { orderImportActorScope } from './approval-journal';
import {
  authorityReasonSchema,
  reviewImportAuthority,
  approveImportAuthority,
  readImportAuthorityApproval,
  continueImportAuthority,
  readImportAuthorityContinuation,
  type AuthorityReview,
  type AuthorityGrant,
  type AuthorityContinuation,
} from './authority-succession-client';
import {
  readAuthorityIntent,
  saveAuthorityIntent,
  retireCompletedAuthorityScope,
  listAuthorityIntents,
  type AuthorityIntent,
} from './authority-succession-journal';
const reasons: Record<z.infer<typeof authorityReasonSchema>, string> = {
  'actor-changed': 'Original operator access changed',
  'contact-changed': 'Customer contact changed',
  'authority-recovery': 'Reconcile current authority',
};
export function ImportAuthorityRecovery(props: {
  user: Principal;
  online: boolean;
  disabled?: boolean;
  onPending?: (value: boolean) => void;
}) {
  return <Recovery key={orderImportActorScope(props.user)} {...props} />;
}
function Recovery({
  user,
  online,
  disabled,
  onPending,
}: Parameters<typeof ImportAuthorityRecovery>[0]) {
  const [initial] = useState(() => {
      try {
        return { intent: readAuthorityIntent(user), error: '' };
      } catch {
        return {
          intent: null,
          error:
            'The saved recovery action is unreadable. Keep this device for manager reconciliation.',
        };
      }
    }),
    [intent, setIntent] = useState<AuthorityIntent | null>(initial.intent),
    [savedActions, setSavedActions] = useState<AuthorityIntent[]>(() => {
      try {
        return listAuthorityIntents(user);
      } catch {
        return [];
      }
    }),
    [jobId, setJobId] = useState(initial.intent?.jobId ?? ''),
    [operationId, setOperationId] = useState(initial.intent?.operationId ?? ''),
    [review, setReview] = useState<AuthorityReview | null>(null),
    [grant, setGrant] = useState<AuthorityGrant | null>(null),
    [result, setResult] = useState<AuthorityContinuation | null>(null),
    [reason, setReason] = useState<z.infer<typeof authorityReasonSchema>>('authority-recovery'),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(initial.error),
    [notice, setNotice] = useState('');
  const alive = useRef(true),
    locked = useRef(false),
    scopeRevision = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      scopeRevision.current++;
    };
  }, []);
  useEffect(() => {
    onPending?.(savedActions.length > 0 || busy);
    return () => onPending?.(false);
  }, [savedActions, busy, onPending]);
  async function act(task: (signal: AbortSignal, revision: number) => Promise<void>) {
    if (locked.current || !online || initial.error) return;
    const signal = captureOperatorScope(user.id),
      revision = scopeRevision.current;
    locked.current = true;
    setBusy(true);
    setProblem('');
    setNotice('');
    try {
      await task(signal, revision);
      signal.throwIfAborted();
    } catch (error) {
      if (alive.current && !signal.aborted && scopeRevision.current === revision)
        setProblem(
          error instanceof ApiError
            ? error.message + (error.requestId ? ' (Reference ' + error.requestId + ')' : '')
            : error instanceof Error
              ? error.message
              : 'The original action remains unconfirmed.',
        );
    } finally {
      locked.current = false;
      if (alive.current && !signal.aborted) setBusy(false);
    }
  }
  const current = (signal: AbortSignal, revision: number) => {
    signal.throwIfAborted();
    if (!alive.current || revision !== scopeRevision.current)
      throw new DOMException('Scope changed', 'AbortError');
  };
  function scope() {
    return { jobId: z.uuid().parse(jobId), operationId: z.uuid().parse(operationId) };
  }
  async function refresh(signal: AbortSignal, revision: number) {
    const input = scope(),
      value = await reviewImportAuthority(user.id, input);
    current(signal, revision);
    setReview(value);
    setGrant(value.grant?.managerId === user.id ? value.grant : null);
    setConfirmed(false);
  }
  async function recover(signal: AbortSignal, revision: number, chosen?: AuthorityIntent) {
    const saved = chosen ?? intent ?? readAuthorityIntent(user);
    if (!saved) return;
    const input = { jobId: saved.jobId, operationId: saved.operationId };
    if (saved.kind === 'approve') {
      const value = await readImportAuthorityApproval(user.id, input, saved.commandId);
      current(signal, revision);
      if (!value) {
        setNotice('The original approval is not recorded yet. Keep its reference and check again.');
        return;
      }
      if (value.managerId !== user.id)
        throw Error('This saved approval belongs to another manager.');
      setGrant(value);
      setNotice(
        'Original approval confirmed. Review the remaining original order before continuing.',
      );
    } else {
      const value = await readImportAuthorityContinuation(user.id, input, saved.commandId);
      current(signal, revision);
      if (!value) {
        setNotice(
          'The original continuation is not recorded yet. Keep its reference and check again.',
        );
        return;
      }
      setResult(value);
      if (value.status === 'completed') {
        await retireCompletedAuthorityScope(
          user,
          { jobId: saved.jobId, operationId: saved.operationId },
          signal,
        );
        current(signal, revision);
        setSavedActions(listAuthorityIntents(user));
        setIntent(null);
      }
      setNotice(
        value.status === 'completed'
          ? 'The original imported order is complete.'
          : 'The original continuation is recorded. Refresh its outcome; do not import the order again.',
      );
    }
  }
  useEffect(() => {
    if (!online || !initial.intent || initial.error) return;
    void act(recover);
  }, [online]);
  function changed(change: () => void) {
    scopeRevision.current++;
    change();
    setReview(null);
    setGrant(null);
    setResult(null);
    setConfirmed(false);
    setProblem('');
    setNotice('');
  }
  return (
    <section className="surface" aria-label="Existing imported order authority recovery">
      <h2>Recover authority for an existing imported order</h2>
      <p>
        Use the original import and operation references when operator access or customer contact
        changed. Check in to its store and counter. Keep the original order; do not upload it again.
      </p>
      <fieldset disabled={busy || Boolean(initial.error)}>
        <label>
          Original import reference
          <input
            value={jobId}
            onChange={(e) => changed(() => setJobId(e.target.value))}
            autoComplete="off"
          />
        </label>
        <label>
          Original order operation reference
          <input
            value={operationId}
            onChange={(e) => changed(() => setOperationId(e.target.value))}
            autoComplete="off"
          />
        </label>
      </fieldset>
      <button
        type="button"
        disabled={busy || !online || Boolean(initial.error)}
        onClick={() => void act(refresh)}
      >
        Review original order authority
      </button>
      {intent && (
        <p role="status">
          Saved {intent.kind === 'approve' ? 'approval' : 'continuation'} reference:{' '}
          <code>{intent.commandId}</code>. Its original outcome must be recovered.
        </p>
      )}
      {savedActions.length > 0 && (
        <details>
          <summary>Saved original authority actions ({savedActions.length})</summary>
          {savedActions.map((saved) => (
            <p key={saved.commandId}>
              <code>{saved.commandId}</code> · {saved.kind}
              <button
                type="button"
                disabled={busy || !online}
                onClick={() => void act((signal, revision) => recover(signal, revision, saved))}
              >
                Check this original action
              </button>
            </p>
          ))}
        </details>
      )}
      {intent && (
        <button type="button" disabled={busy || !online} onClick={() => void act(recover)}>
          Check original authority action
        </button>
      )}
      {problem && <p role="alert">{problem}</p>}
      {notice && <p role="status">{notice}</p>}
      {review && (
        <div role="region" aria-label="Original order authority review">
          <p>
            Order <code>{review.orderId}</code> · store {review.storeId} · counter{' '}
            {review.counterId} · {review.businessDate} · {currency(review.payable)}
          </p>
          <p>
            Original operator {review.originalActorId}; current manager {review.currentManagerId}.
            Approval preserves the recorded prices, original customer and completed benefits.
          </p>
          {review.status === 'blocked' && (
            <p role="alert">
              An original effect remains unconfirmed ({review.code}). Reconcile that reference
              before any further action.
            </p>
          )}
          {review.status === 'completed' && (
            <p role="status">This original order already has a verified completion.</p>
          )}
          {review.status === 'ready' && (
            <>
              <label>
                Reason
                <select
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(authorityReasonSchema.parse(e.target.value))}
                >
                  {Object.entries(reasons).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I have reviewed the original tender and remaining settlement. Approve my current
                authority for this order.
              </label>
              <button
                type="button"
                disabled={disabled || busy || !online || !confirmed}
                onClick={() =>
                  void act(async (signal, revision) => {
                    if (!review || review.jobId !== jobId || review.operationId !== operationId)
                      return;
                    const saved: AuthorityIntent = {
                      version: 1,
                      operatorId: user.id,
                      actorScope: orderImportActorScope(user),
                      jobId,
                      operationId,
                      kind: 'approve',
                      commandId: crypto.randomUUID(),
                      reviewHash: review.reviewHash,
                      reason,
                    };
                    await saveAuthorityIntent(user, saved, signal);
                    current(signal, revision);
                    setIntent(saved);
                    setSavedActions(listAuthorityIntents(user));
                    const value = await approveImportAuthority(
                      user.id,
                      { jobId, operationId },
                      {
                        commandId: saved.commandId,
                        reviewHash: saved.reviewHash,
                        reason: saved.reason,
                      },
                    );
                    current(signal, revision);
                    setGrant(value);
                    setResult(null);
                    setNotice(
                      'Current authority approved. Continue only the remaining original order stages.',
                    );
                  })
                }
              >
                Approve current authority
              </button>
            </>
          )}
        </div>
      )}
      {grant && grant.jobId === jobId && grant.operationId === operationId && (
        <div aria-label="Confirmed authority approval">
          <p>
            Approval <code>{grant.id}</code> · manager {grant.managerId}. The server rechecks
            current access and customer contact before each new action.
          </p>
          <button
            type="button"
            disabled={
              disabled ||
              busy ||
              !online ||
              !review ||
              review.status !== 'ready' ||
              savedActions.some((v) => v.kind === 'continue' && v.grantId === grant.id)
            }
            onClick={() =>
              void act(async (signal, revision) => {
                const saved: AuthorityIntent = {
                  version: 1,
                  operatorId: user.id,
                  actorScope: orderImportActorScope(user),
                  jobId,
                  operationId,
                  kind: 'continue',
                  commandId: crypto.randomUUID(),
                  grantId: grant.id,
                };
                await saveAuthorityIntent(user, saved, signal);
                current(signal, revision);
                setIntent(saved);
                setSavedActions(listAuthorityIntents(user));
                const value = await continueImportAuthority(
                  user.id,
                  { jobId, operationId },
                  { commandId: saved.commandId, grantId: saved.grantId },
                );
                current(signal, revision);
                setResult(value);
                if (value.status === 'completed') {
                  await retireCompletedAuthorityScope(
                    user,
                    { jobId: saved.jobId, operationId: saved.operationId },
                    signal,
                  );
                  current(signal, revision);
                  setSavedActions(listAuthorityIntents(user));
                  setIntent(null);
                }
                setNotice(
                  value.status === 'completed'
                    ? 'Original order completed.'
                    : 'The original result needs reconciliation; refresh it without starting another import.',
                );
              })
            }
          >
            Continue remaining original order
          </button>
        </div>
      )}
      {result && (
        <div aria-label="Original continuation outcome">
          <p>
            Continuation <code>{result.commandId}</code> · {result.status} · order{' '}
            <code>{result.orderId}</code>.
          </p>
          {result.result && (
            <p>
              Verified receipt <code>{result.result.receiptId}</code> for{' '}
              {result.result.businessDate}.
            </p>
          )}
          <button
            type="button"
            disabled={busy || !online}
            onClick={() =>
              void act(async (signal, revision) => {
                const value = await readImportAuthorityContinuation(
                  user.id,
                  { jobId: result.jobId, operationId: result.operationId },
                  result.commandId,
                );
                current(signal, revision);
                if (value) setResult(value);
              })
            }
          >
            Refresh original continuation outcome
          </button>
        </div>
      )}
    </section>
  );
}
