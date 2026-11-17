import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, captureOperatorScope } from '../../../api/client';
import type { Principal } from '../../../api/types';
import {
  checkedImportApproval,
  importApprovalReasonSchema,
  readImportApproval,
  requestImportApproval,
  type ImportApprovalReason,
  type ImportApprovalResponse,
  type ImportApprovalScope,
} from './approval-client';
import {
  clearImportApprovalIntent,
  orderImportActorScope,
  readImportApprovalIntent,
  saveImportApprovalIntent,
  type ImportApprovalIntent,
} from './approval-journal';

const reasons: Record<ImportApprovalReason, string> = {
  'late-recording': 'Late recording',
  'historical-correction': 'Historical correction',
  'source-reconciliation': 'Source reconciliation',
};
type Props = {
  user: Principal;
  scope: ImportApprovalScope;
  online: boolean;
  enabled: boolean;
  canCreate?: boolean;
  onPendingChanged: () => void;
};
export default function ImportApprovalActions(props: Props) {
  return (
    <ApprovalReview
      key={JSON.stringify([orderImportActorScope(props.user), props.scope])}
      {...props}
    />
  );
}
function ApprovalReview({
  user,
  scope,
  online,
  enabled,
  canCreate = true,
  onPendingChanged,
}: Props) {
  const identity = JSON.stringify([orderImportActorScope(user), scope]),
    currentIdentity = useRef(identity),
    mounted = useRef(true),
    locked = useRef(false),
    lifetime = useRef<AbortController | null>(null),
    run = useRef(0);
  currentIdentity.current = identity;
  const [initial] = useState(() => {
    try {
      return {
        intent: readImportApprovalIntent(user.id, scope.jobId, scope.operationId),
        error: '',
      };
    } catch {
      return {
        intent: null,
        error:
          'The saved approval references are unreadable. Keep this device for administrator recovery.',
      };
    }
  });
  const [intent, setIntent] = useState<ImportApprovalIntent | null>(initial.intent),
    [response, setResponse] = useState<ImportApprovalResponse | null>(null),
    [reason, setReason] = useState<ImportApprovalReason>(
      initial.intent?.reason ?? 'late-recording',
    ),
    [reviewed, setReviewed] = useState(false),
    [notRecorded, setNotRecorded] = useState(false),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [storageProblem, setStorageProblem] = useState(initial.error),
    [now, setNow] = useState(Date.now());
  const changed = useRef(onPendingChanged);
  changed.current = onPendingChanged;
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    lifetime.current = controller;
    locked.current = false;
    return () => {
      mounted.current = false;
      run.current++;
      locked.current = false;
      controller.abort();
    };
  }, []);
  function reviewSignal() {
    try {
      const owner = captureOperatorScope(user.id),
        local = lifetime.current?.signal;
      if (!local || local.aborted || !mounted.current) return null;
      return AbortSignal.any([owner, local]);
    } catch {
      return null;
    }
  }
  function assertCurrent(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!mounted.current || currentIdentity.current !== identity)
      throw new DOMException('The approval review scope changed.', 'AbortError');
  }
  function stored() {
    try {
      return readImportApprovalIntent(user.id, scope.jobId, scope.operationId);
    } catch (error) {
      if (mounted.current && currentIdentity.current === identity)
        setStorageProblem(
          'The saved approval references are unreadable. Keep this device for administrator recovery.',
        );
      throw error;
    }
  }
  async function confirm(
    pending: ImportApprovalIntent,
    value: ImportApprovalResponse,
    signal: AbortSignal,
  ) {
    assertCurrent(signal);
    checkedImportApproval(value, user.id, scope, pending.commandId, pending.reason);
    if (!value.approval)
      throw new Error('The original approval request is unconfirmed. Refresh its saved receipt.');
    await clearImportApprovalIntent(pending, signal);
    assertCurrent(signal);
    setIntent(null);
    setNotRecorded(false);
    changed.current();
  }
  const load = useCallback(async () => {
    if (!online || locked.current || initial.error) return;
    const signal = reviewSignal();
    if (!signal) return;
    const operation = ++run.current;
    locked.current = true;
    setBusy(true);
    setProblem('');
    setNotRecorded(false);
    setReviewed(false);
    try {
      const pending = stored();
      assertCurrent(signal);
      setIntent(pending);
      if (pending) setReason(pending.reason);
      const value = await readImportApproval(user.id, scope, pending?.commandId ?? null, signal);
      assertCurrent(signal);
      const latest = stored();
      assertCurrent(signal);
      if (pending) {
        if (latest && latest.commandId !== pending.commandId)
          throw new Error('The saved approval request changed. Refresh its original receipt.');
        checkedImportApproval(value, user.id, scope, pending.commandId, pending.reason);
        setResponse(value);
        if (value.approval) await confirm(pending, value, signal);
        else setNotRecorded(true);
      } else if (latest) {
        setIntent(latest);
        setResponse(null);
        setProblem(
          'A saved approval request needs its original receipt. Refresh before continuing.',
        );
      } else setResponse(value);
      setNow(Date.now());
    } catch (error: unknown) {
      if (mounted.current && !signal.aborted && currentIdentity.current === identity)
        setProblem(
          error instanceof ApiError
            ? `${error.message}${error.requestId ? ' (Reference ' + error.requestId + ')' : ''}`
            : error instanceof Error
              ? error.message
              : 'The original approval could not be confirmed.',
        );
    } finally {
      if (operation === run.current) {
        locked.current = false;
        if (mounted.current && !signal.aborted && currentIdentity.current === identity)
          setBusy(false);
      }
    }
  }, [online, identity, initial.error]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const expires = response?.approval?.expiresAt;
    if (expires === undefined || expires <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(expires - now, 3600000));
    return () => clearTimeout(timer);
  }, [response?.approval?.expiresAt, now]);
  async function grant() {
    if (
      !online ||
      !enabled ||
      locked.current ||
      storageProblem ||
      !response ||
      !reviewed ||
      (intent && !notRecorded) ||
      (!intent && !canCreate)
    )
      return;
    const signal = reviewSignal();
    if (!signal) return;
    const operation = ++run.current;
    locked.current = true;
    setBusy(true);
    setProblem('');
    try {
      assertCurrent(signal);
      const prior = stored();
      if (prior && (!intent || prior.commandId !== intent.commandId))
        throw new Error('Recover the original approval request before creating another.');
      const pending = await saveImportApprovalIntent(
        intent ?? {
          version: 1,
          operatorId: user.id,
          jobId: scope.jobId,
          operationId: scope.operationId,
          commandId: crypto.randomUUID(),
          reason: response.review.correction ? 'historical-correction' : reason,
        },
        signal,
      );
      assertCurrent(signal);
      setIntent(pending);
      setNotRecorded(false);
      changed.current();
      const review = JSON.stringify(response.review),
        value = await requestImportApproval(
          user.id,
          scope,
          { commandId: pending.commandId, reason: pending.reason },
          signal,
        );
      assertCurrent(signal);
      if (JSON.stringify(value.review) !== review)
        throw new Error('The original order review changed. Refresh the saved approval receipt.');
      setResponse(value);
      await confirm(pending, value, signal);
      setReviewed(false);
      setNow(Date.now());
    } catch (error: unknown) {
      if (mounted.current && !signal.aborted && currentIdentity.current === identity)
        setProblem(
          error instanceof ApiError
            ? `${error.message}${error.requestId ? ' (Reference ' + error.requestId + ')' : ''}`
            : error instanceof Error
              ? error.message
              : 'The original approval could not be confirmed.',
        );
    } finally {
      if (operation === run.current) {
        locked.current = false;
        if (mounted.current && !signal.aborted && currentIdentity.current === identity)
          setBusy(false);
      }
    }
  }
  const approval = response?.approval,
    expired = Boolean(approval && approval.expiresAt <= now),
    valid = approval?.status === 'approved' && !expired,
    canGrant = Boolean(response && (intent ? notRecorded : canCreate && !valid)),
    disabled = !online || busy || Boolean(storageProblem);
  return (
    <section aria-label="Financial approval review">
      <h3>Financial approval</h3>
      <p>
        Review the original order before approving its historical recording. Approval lasts one hour
        and does not create an order.
      </p>
      {storageProblem && <p role="alert">{storageProblem}</p>}
      {problem && <p role="alert">{problem}</p>}
      {busy && <p role="status">Confirming the original approval request…</p>}
      {intent && (
        <p role="status">
          Saved approval request: <code>{intent.commandId}</code>. Refresh its receipt before
          sending another request.
        </p>
      )}
      {response && (
        <>
          <dl>
            <dt>Original business date</dt>
            <dd>{response.review.businessDate}</dd>
            <dt>
              {response.review.correction ? 'Line-price declaration' : 'Original payment value'}
            </dt>
            <dd>
              {response.review.currency} {response.review.lineValue}
            </dd>
            {response.review.correction && (
              <>
                <dt>Correction reference</dt>
                <dd>
                  <code>{response.review.correction.id}</code>
                </dd>
                <dt>Independently attested historical tender</dt>
                <dd>
                  {response.review.currency} {response.review.correction.historicalTenderAmount}
                </dd>
                <dt>Qualified source bill</dt>
                <dd>
                  {response.review.currency} {response.review.correction.sourcePayable}
                </dd>
              </>
            )}
            <dt>Store / counter</dt>
            <dd>
              {response.review.storeId} / {response.review.counterId}
            </dd>
          </dl>
          <table aria-label="Original imported products">
            <thead>
              <tr>
                <th>Product ID</th>
                <th>Quantity</th>
                <th>Original unit price</th>
              </tr>
            </thead>
            <tbody>
              {response.review.lines.map((line) => (
                <tr key={line.productId}>
                  <td>{line.productId}</td>
                  <td>{line.quantity}</td>
                  <td>
                    {response.review.currency} {line.unitPrice}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {approval && (
            <div role="status">
              <p>
                Approval reference: <code>{approval.id}</code>
              </p>
              <p>
                {approval.status === 'stale'
                  ? 'Stale approval'
                  : expired
                    ? 'Expired approval'
                    : 'Approved'}{' '}
                · {reasons[approval.reason]}
              </p>
              {expired && approval.status === 'stale' && (
                <p>Expired approval. Its original expiry has passed.</p>
              )}
              <p>
                Original expiry:{' '}
                <time dateTime={new Date(approval.expiresAt).toISOString()}>
                  {new Date(approval.expiresAt).toLocaleString()}
                </time>
              </p>
              {!valid && (
                <p>
                  Current authority must be checked again. A new approval requires another explicit
                  review.
                </p>
              )}
            </div>
          )}
          {intent && notRecorded && (
            <p>
              The exact saved request has no approval receipt. You may explicitly retry that same
              request after reviewing this order.
            </p>
          )}
          {canGrant && (
            <>
              <label>
                Approval reason
                <select
                  aria-label="Approval reason"
                  value={
                    intent?.reason ??
                    (response.review.correction ? 'historical-correction' : reason)
                  }
                  disabled={
                    disabled || Boolean(intent) || !enabled || Boolean(response.review.correction)
                  }
                  onChange={(event) => {
                    const parsed = importApprovalReasonSchema.safeParse(event.target.value);
                    if (parsed.success) setReason(parsed.data);
                    setReviewed(false);
                  }}
                >
                  {Object.entries(reasons).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={disabled || !enabled}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                {response.review.correction
                  ? 'I reviewed the original date, independently attested tender, source bill and all products.'
                  : 'I reviewed the original date, payment value and all products.'}
              </label>
              <button
                type="button"
                disabled={disabled || !enabled || !reviewed}
                onClick={() => void grant()}
              >
                {intent ? 'Retry same approval request' : 'Grant financial approval'}
              </button>
            </>
          )}
        </>
      )}
      <button type="button" disabled={disabled} onClick={() => void load()}>
        {intent ? 'Refresh saved approval receipt' : 'Refresh approval status'}
      </button>
      {!online && <p>Reconnect to review or grant approval.</p>}
    </section>
  );
}
