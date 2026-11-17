import { useEffect, useRef, useState } from 'react';
import type { Principal } from '../../../api/types';
import { ApiError, captureOperatorScope } from '../../../api/client';
import { currency } from '../../../lib/format';
import { orderImportActorScope } from './approval-journal';
import {
  createCorrection,
  historicalTender,
  readCorrection,
  readCorrectionReview,
  type CorrectionReceipt,
  type CorrectionReview,
  type CorrectionScope,
  type CorrectionFence,
} from './correction-client';
import {
  clearCorrectionIntent,
  correctionInputHash,
  listCorrectionIntents,
  readCorrectionIntent,
  saveCorrectionIntent,
  type CorrectionIntent,
} from './correction-journal';

const blockers: Record<NonNullable<CorrectionReview['blocker']>, string> = {
  ORDER_IMPORT_CORRECTION_DISABLED:
    'Manager correction is not enabled. The original row remains unchanged.',
  ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED:
    'The original financial outcome is unconfirmed. Recover that original operation; do not reimport it.',
  ORDER_IMPORT_CORRECTION_CALCULATION_REQUIRED:
    'A verified source calculation is unavailable. The row remains paused for review.',
  ORDER_IMPORT_CORRECTION_PROFILE_UNQUALIFIED:
    'This automatic benefit or source profile needs a qualified calculation. Do not remove benefits to force matching amounts.',
  ORDER_IMPORT_CORRECTION_ALREADY_CREATED:
    'This row already has a linked correction. Recover its original successor reference.',
  ORDER_IMPORT_CORRECTION_KIND_UNSUPPORTED:
    'This correction policy supports offline CSV rows only.',
  ORDER_IMPORT_CORRECTION_DEPTH_LIMIT:
    'The correction chain needs administrator reconciliation before any further import.',
};
type Props = {
  user: Principal;
  scope: CorrectionScope;
  online: boolean;
  enabled: boolean;
  canCreate: boolean;
  onRecorded: (receipt: CorrectionReceipt) => void;
  onFenced: (value: CorrectionFence) => void;
  knownReceipt?: CorrectionReceipt | null;
  knownFence?: CorrectionFence | null;
  showReceipt?: boolean;
};
export function CorrectionReceiptView({
  receipt,
  onOpen,
}: {
  receipt: CorrectionReceipt;
  onOpen?: () => void;
}) {
  return (
    <div role="status" aria-label="Recorded correction receipt">
      <p>
        Correction reference: <code>{receipt.id}</code>
      </p>
      <p>
        Successor import: <code>{receipt.successorJobId}</code> · operation{' '}
        <code>{receipt.successorOperationId}</code>
      </p>
      <p>
        Verified historical tender: {currency(receipt.historicalTenderAmount)}. Financial approval
        is still required; this receipt does not confirm an imported order or a new payment.
      </p>
      {onOpen && (
        <button type="button" onClick={onOpen}>
          Open successor for approval
        </button>
      )}
    </div>
  );
}
export default function ImportCorrectionPanel(props: Props) {
  return (
    <CorrectionReviewPanel
      key={JSON.stringify([orderImportActorScope(props.user), props.scope])}
      {...props}
    />
  );
}
function CorrectionReviewPanel({
  user,
  scope,
  online,
  enabled,
  canCreate,
  onRecorded,
  onFenced,
  knownReceipt,
  knownFence,
  showReceipt = true,
}: Props) {
  const [review, setReview] = useState<CorrectionReview | null>(null),
    [intent, setIntent] = useState<CorrectionIntent | null>(null),
    [receipt, setReceipt] = useState<CorrectionReceipt | null>(null),
    [fence, setFence] = useState<CorrectionFence | null>(null),
    [tender, setTender] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [storageProblem, setStorageProblem] = useState('');
  const locked = useRef(false),
    lifetime = useRef<AbortController | null>(null),
    recorded = useRef(onRecorded);
  const displayed =
    knownReceipt?.managerId === user.id &&
    knownReceipt.originalJobId === scope.jobId &&
    knownReceipt.originalOperationId === scope.operationId
      ? knownReceipt
      : receipt;
  const candidateFence =
    knownFence?.managerId === user.id &&
    knownFence.originalJobId === scope.jobId &&
    knownFence.originalOperationId === scope.operationId
      ? knownFence
      : fence;
  const displayedFence =
    candidateFence && (!intent || candidateFence.id === intent.id) ? candidateFence : null;
  recorded.current = onRecorded;
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    try {
      setIntent(readCorrectionIntent(user.id, scope));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        setStorageProblem(
          'Saved correction references are unreadable. Keep this device for manager recovery.',
        );
    }
    return () => {
      controller.abort();
      lifetime.current = null;
    };
  }, [user.id, scope.jobId, scope.operationId]);
  function signal() {
    const local = lifetime.current?.signal;
    if (!local) throw new DOMException('The manager scope changed.', 'AbortError');
    return AbortSignal.any([local, captureOperatorScope(user.id)]);
  }
  async function act(task: (active: AbortSignal) => Promise<void>) {
    if (locked.current || !online || storageProblem) return;
    const active = signal();
    active.throwIfAborted();
    locked.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task(active);
      active.throwIfAborted();
    } catch (error) {
      if (!active.aborted)
        setProblem(
          error instanceof ApiError
            ? `${error.message}${error.requestId ? ' (Reference ' + error.requestId + ')' : ''}`
            : error instanceof Error
              ? error.message
              : 'The original correction could not be confirmed.',
        );
    } finally {
      locked.current = false;
      if (!active.aborted) setBusy(false);
    }
  }
  async function keepKnown(
    value: CorrectionReceipt,
    pending: CorrectionIntent | null,
    active: AbortSignal,
  ) {
    active.throwIfAborted();
    setReceipt(value); // Keep the immutable receipt even if storage or a later job refresh fails.
    recorded.current(value);
    if (pending) {
      await clearCorrectionIntent(pending, active);
      active.throwIfAborted();
      setIntent(null);
    }
  }
  async function load(active: AbortSignal) {
    const pending = readCorrectionIntent(user.id, scope) ?? intent;
    if (pending) {
      setIntent(pending);
      const value = await readCorrection(user.id, scope, pending, active);
      active.throwIfAborted();
      if (value.status === 'accepted') await keepKnown(value.receipt, pending, active);
      else {
        setFence(value);
        onFenced(value);
      }
      return;
    }
    const value = await readCorrectionReview(user.id, scope, active);
    active.throwIfAborted();
    setReview(value);
    setConfirmed(false);
    if (value.successor) await keepKnown(value.successor, null, active);
  }
  async function freshReview(active: AbortSignal) {
    const pending = readCorrectionIntent(user.id, scope) ?? intent;
    if (!pending || !displayedFence || pending.id !== displayedFence.id)
      throw new Error('Recover the exact original correction before starting a fresh review.');
    const outcome = await readCorrection(user.id, scope, pending, active);
    active.throwIfAborted();
    if (outcome.status === 'accepted') {
      await keepKnown(outcome.receipt, pending, active);
      return;
    }
    setFence(outcome);
    onFenced(outcome);
    await clearCorrectionIntent(pending, active);
    active.throwIfAborted();
    setIntent(null);
    setConfirmed(false);
    setTender('');
    setReview(null);
    const value = await readCorrectionReview(user.id, scope, active);
    active.throwIfAborted();
    setReview(value);
    if (value.successor) await keepKnown(value.successor, null, active);
  }
  async function prepare(active: AbortSignal) {
    if (
      !enabled ||
      !canCreate ||
      !confirmed ||
      !review?.eligible ||
      !review.reviewHash ||
      !review.calculation?.profileQualified ||
      displayed
    )
      return;
    const saved = readCorrectionIntent(user.id, scope) ?? intent;
    if (saved) {
      setIntent(saved);
      throw new Error('Recover the original correction reference; no replacement was sent.');
    }
    if (listCorrectionIntents(user.id).length)
      throw new Error('Recover the pending correction before preparing another.');
    const amount = historicalTender(tender);
    if (amount !== review.calculation.payable)
      throw new Error(
        'The verified historical tender must match the qualified source bill. If the sale record differs, leave this row paused for reconciliation.',
      );
    const input = {
        id: crypto.randomUUID(),
        successorJobId: crypto.randomUUID(),
        successorOperationId: crypto.randomUUID(),
        reviewHash: review.reviewHash,
        historicalTenderAmount: amount,
        evidenceId: crypto.randomUUID(),
        confirmHistoricalTender: true as const,
        lines: review.original.lines.map((line) => ({ row: line.row, unitPrice: line.unitPrice })),
      },
      inputHash = await correctionInputHash(input);
    active.throwIfAborted();
    const pending = await saveCorrectionIntent(
      {
        version: 1,
        operatorId: user.id,
        ...scope,
        id: input.id,
        successorJobId: input.successorJobId,
        successorOperationId: input.successorOperationId,
        evidenceId: input.evidenceId,
        inputHash,
      },
      active,
    );
    active.throwIfAborted();
    setIntent(pending);
    const value = await createCorrection(user.id, scope, input, active);
    active.throwIfAborted();
    await keepKnown(value, pending, active);
    setConfirmed(false);
    setTender('');
  }
  const disabled = busy || !online || Boolean(storageProblem);
  return (
    <section aria-label="Manager correction review" className="surface">
      <h3>Correct a paused import row</h3>
      <p>
        Review the original declaration and source bill. Enter the tender verified from the
        historical sale record. No payment, change or refund is inferred from the CSV.
      </p>
      {storageProblem && <p role="alert">{storageProblem}</p>}
      {problem && <p role="alert">{problem}</p>}
      {intent && !displayed && !displayedFence && (
        <p role="status">
          Original correction reference: <code>{intent.id}</code>. Its outcome is unconfirmed. Check
          this reference; do not send a replacement.
        </p>
      )}
      {displayedFence && !displayed && (
        <div role="status" aria-label="Fenced correction command">
          <p>
            Correction <code>{displayedFence.id}</code> did not queue a successor. Late submissions
            of that correction reference are blocked.
          </p>
          <p>The original source import still requires its own verified review.</p>
          {intent && (
            <button type="button" disabled={disabled} onClick={() => void act(freshReview)}>
              Begin fresh review after this fence
            </button>
          )}
        </div>
      )}
      {displayed &&
        (showReceipt ? (
          <CorrectionReceiptView receipt={displayed} />
        ) : (
          <p role="status">
            The linked successor is recorded in the correction receipt above. Approval is still
            required.
          </p>
        ))}
      {review && (
        <>
          <dl>
            <dt>Original CSV row</dt>
            <dd>{review.original.firstRow}</dd>
            <dt>Store / counter</dt>
            <dd>
              {review.original.storeId} / {review.original.counterId}
            </dd>
            <dt>Historical business date</dt>
            <dd>{review.original.businessDateTime}</dd>
            <dt>Original line-price declaration</dt>
            <dd>{currency(review.original.lineValue)}</dd>
            <dt>Payment channel</dt>
            <dd>{review.original.payment}</dd>
            <dt>Verified source bill at original prices</dt>
            <dd>{review.calculation ? currency(review.calculation.payable) : 'Unavailable'}</dd>
          </dl>
          <table aria-label="Original CSV correction rows">
            <thead>
              <tr>
                <th>CSV row</th>
                <th>Product ID</th>
                <th>Quantity</th>
                <th>Original unit price</th>
              </tr>
            </thead>
            <tbody>
              {review.original.lines.map((line) => (
                <tr key={line.row}>
                  <td>{line.row}</td>
                  <td>{line.productId}</td>
                  <td>{line.quantity}</td>
                  <td>{currency(line.unitPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Prices, products, quantities, customer, date and channel stay unchanged. Changing prices
            requires a fresh verified source calculation. A permanent percentage discount cannot be
            fixed by copying the old bill into the price.
          </p>
          {review.blocker && <p role="status">{blockers[review.blocker]}</p>}
          {review.eligible && !displayed && !intent && (
            <fieldset disabled={disabled || !enabled || !canCreate}>
              <legend>Verified historical tender</legend>
              <label>
                Historical tender amount
                <input
                  inputMode="decimal"
                  maxLength={13}
                  value={tender}
                  onChange={(event) => {
                    setTender(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I verified this tender against the original sale record, including an explicit zero
                only when the qualified source bill is zero.
              </label>
              <button
                type="button"
                disabled={!confirmed || !tender}
                onClick={() => void act(prepare)}
              >
                Save linked correction for approval
              </button>
            </fieldset>
          )}
        </>
      )}
      <button type="button" disabled={disabled} onClick={() => void act(load)}>
        {intent && !displayed ? 'Check original correction status' : 'Refresh original row review'}
      </button>
    </section>
  );
}
