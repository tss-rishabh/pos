import { useEffect, useRef, useState } from 'react';
import { ApiError, captureOperatorScope } from '../../api/client';
import {
  readCorrection,
  readCorrectionContext,
  type CorrectionContext,
  type CorrectionReceipt,
  type CorrectionScope,
} from './client';
import {
  armReturn,
  attestReturn,
  cancelReturn,
  getReturn,
  getReturnOperation,
  prepareReturn,
  resolveReturn,
  returnJournal,
  saveReturnJournal,
  removeReturnJournal,
  type CashReturnView,
  type ReturnJournal,
} from './intents-client';
export interface CashReturnPanelProps {
  user: { id: string };
  storeId: string;
  orderId: string;
  online: boolean;
  intentId?: string;
  onCorrected?: (receipt: CorrectionReceipt) => Promise<void>;
}
export function CashReturnIntentPanel(props: CashReturnPanelProps) {
  return (
    <IntentPanel
      key={`${props.user.id}:${props.storeId}:${props.orderId}:${props.intentId ?? ''}`}
      {...props}
    />
  );
}
function IntentPanel({
  user,
  storeId,
  orderId,
  online,
  intentId,
  onCorrected,
}: CashReturnPanelProps) {
  const scope: CorrectionScope = { ownerId: user.id, storeId, orderId },
    [context, setContext] = useState<CorrectionContext | null>(null),
    [view, setView] = useState<CashReturnView | null>(null),
    [journal, setJournal] = useState<ReturnJournal | null>(null),
    [receipt, setReceipt] = useState<CorrectionReceipt | null>(null),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [instruction, setInstruction] = useState(false),
    [noHandover, setNoHandover] = useState(false),
    [returned, setReturned] = useState(false),
    [actualTime, setActualTime] = useState(''),
    [notReturned, setNotReturned] = useState(false),
    [unrecordedAttestation, setUnrecordedAttestation] = useState(false),
    [reason, setReason] = useState<'incorrect-payment-record' | 'customer-payment-correction'>(
      'customer-payment-correction',
    );
  const mounted = useRef(true),
    lock = useRef(false),
    callback = useRef(onCorrected);
  callback.current = onCorrected;
  function persist(value: ReturnJournal) {
    saveReturnJournal(scope, value);
    setJournal(value);
    return value;
  }
  function adopt(value: CashReturnView, saved: ReturnJournal | null) {
    if (value.storeId !== storeId || value.orderId !== orderId)
      throw new Error('The return belongs to another order.');
    const next: ReturnJournal = saved ?? {
      version: 1,
      intentId: value.id,
      correctionId: value.correctionId,
      instructionConsumed: value.phase !== 'PREPARED',
      prepare: null,
      pending: null,
    };
    if (value.id !== next.intentId || value.correctionId !== next.correctionId)
      throw new Error('The original cash-return references changed.');
    setView(value);
    return next;
  }
  async function showReceipt(value: CorrectionReceipt, signal: AbortSignal, expectedId: string) {
    if (signal.aborted || !mounted.current) return;
    if (value.storeId !== storeId || value.orderId !== orderId || value.id !== expectedId)
      throw new Error('The financial receipt does not match the original return.');
    setReceipt(value);
    setInstruction(false);
    removeReturnJournal(scope);
    try {
      await callback.current?.(value);
    } catch {
      if (!signal.aborted && mounted.current)
        setProblem('Cash correction is recorded. Refresh order details; do not return cash again.');
    }
  }
  function correctionInput(value: CashReturnView) {
    return {
      operationId: value.correctionId,
      intentId: value.id,
      originalPaymentId: value.originalPaymentId,
      counterId: value.counterId,
      snapshotHash: '0'.repeat(64),
      cashReturnReceiptId: value.cashReturnReceiptId,
      returnedCash: value.returnedCash,
      confirmCashReturned: true as const,
      confirmNoHandover: true as const,
      reason: value.reason,
    };
  }
  async function recover(signal: AbortSignal, saved: ReturnJournal) {
    setInstruction(false);
    setUnrecordedAttestation(false);
    if (saved.pending?.kind === 'resolve') {
      // Possession of a saved UUID authorizes no new financial command.
      const current = await getReturn(scope, saved.intentId, signal);
      if (signal.aborted || !mounted.current) return;
      adopt(current, saved);
      try {
        await showReceipt(
          await readCorrection(scope, correctionInput(current), signal),
          signal,
          saved.correctionId,
        );
        return;
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'PAYMENT_REVERSAL_NOT_FOUND'))
          throw error;
      }
      if (current.phase === 'ATTESTED') persist({ ...saved, pending: null });
      setProblem(
        'The original correction is not recorded. Its returned cash remains pending; reconcile this same return. Do not hand cash back again.',
      );
      return;
    }
    if (saved.pending) {
      try {
        const outcome = await getReturnOperation(
          scope,
          saved.intentId,
          saved.pending.operationId,
          signal,
        );
        if (signal.aborted || !mounted.current) return;
        adopt(outcome.intent, saved);
        persist({
          ...saved,
          pending: null,
          instructionConsumed: saved.instructionConsumed || outcome.intent.phase !== 'PREPARED',
        });
        return;
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'CASH_RETURN_OPERATION_NOT_FOUND'))
          throw error;
      }
    }
    try {
      const current = await getReturn(scope, saved.intentId, signal);
      if (signal.aborted || !mounted.current) return;
      adopt(current, saved);
      if (saved.pending?.kind === 'attest' && current.phase === 'RETURN_PENDING')
        setUnrecordedAttestation(true);
      // Keep a missing original action: only an explicit replay can use its UUID.
      const progressed =
        current.phase === 'RECORDED' ||
        current.phase === 'CANCELLED' ||
        (saved.pending?.kind === 'attest' && current.phase === 'ATTESTED') ||
        (saved.pending?.kind === 'cancel' && current.phase !== 'PREPARED');
      if (!saved.pending || progressed)
        persist({
          ...saved,
          pending: progressed ? null : saved.pending,
          instructionConsumed: saved.instructionConsumed || current.phase !== 'PREPARED',
        });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'CASH_RETURN_INTENT_NOT_FOUND' &&
        saved.pending?.kind === 'prepare'
      ) {
        setProblem(
          'Original preparation was not found. Retry only this saved preparation before any cash handback.',
        );
        return;
      }
      throw error;
    }
  }
  useEffect(() => {
    mounted.current = true;
    const signal = captureOperatorScope(user.id);
    let active = true;
    async function load() {
      try {
        const saved = returnJournal(scope);
        if (active) setJournal(saved);
        if (!online) return;
        if (saved) {
          await recover(signal, saved);
          return;
        }
        if (intentId) {
          const current = await getReturn(scope, intentId, signal);
          if (active && !signal.aborted) {
            const next = adopt(current, null);
            persist(next);
          }
          return;
        }
        const value = await readCorrectionContext(scope, signal);
        if (!active || signal.aborted) return;
        setContext(value);
        if (value.activeIntent) {
          const next = adopt(value.activeIntent, null);
          persist(next);
        }
      } catch (error) {
        if (active && !signal.aborted)
          setProblem(error instanceof Error ? error.message : 'Cash-return review is unavailable.');
      }
    }
    void load();
    return () => {
      active = false;
      mounted.current = false;
    };
    // Scope changes remount the child, while reconnection refreshes server evidence.
  }, [user.id, storeId, orderId, intentId, online]);
  async function act(task: (signal: AbortSignal) => Promise<void>) {
    if (lock.current || !online) return;
    const signal = captureOperatorScope(user.id);
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task(signal);
    } catch (error) {
      setInstruction(false);
      if (mounted.current && !signal.aborted)
        setProblem(error instanceof Error ? error.message : 'Check the original return reference.');
    } finally {
      lock.current = false;
      if (mounted.current && !signal.aborted) setBusy(false);
    }
  }
  async function replay(saved: ReturnJournal, signal: AbortSignal) {
    const pending = saved.pending;
    if (!pending) return;
    const result =
      pending.kind === 'prepare' && saved.prepare
        ? await prepareReturn(scope, saved.prepare)
        : pending.kind === 'arm'
          ? await armReturn(scope, saved.intentId, pending.operationId)
          : pending.kind === 'attest'
            ? await attestReturn(scope, saved.intentId, pending.input)
            : pending.kind === 'cancel'
              ? await cancelReturn(scope, saved.intentId, pending.input)
              : null;
    if (!result || signal.aborted || !mounted.current) return;
    adopt(result.intent, saved);
    const canPresent = pending.kind === 'arm' && result.newlyArmed && !saved.instructionConsumed;
    persist({
      ...saved,
      pending: null,
      instructionConsumed: saved.instructionConsumed || canPresent,
    });
    setInstruction(canPresent);
  }
  return (
    <section aria-label="Durable cash return">
      <h3>Prepare and reconcile a cash return</h3>
      <p>
        The original payment and signed money history are retained. Prepare the return before
        handing back cash. Pending returns block final store financial figures.
      </p>
      {!online && <p>Reconnect to review the original server evidence.</p>}
      {problem && <p role="alert">{problem}</p>}
      {receipt ? (
        <>
          <p role="status">
            Cash correction recorded · {receipt.returnedCash} returned · {receipt.id}. Cash date{' '}
            {receipt.businessDate}; recorded by operator {receipt.operatorId}. Do not return cash
            again.
          </p>
          <button
            disabled={busy || !online}
            onClick={() => void act((signal) => showReceipt(receipt, signal, receipt.id))}
          >
            Refresh corrected order
          </button>
        </>
      ) : (
        <>
          {journal?.pending && (
            <>
              <p role="status">
                Original {journal.pending.kind} action {journal.pending.operationId} requires a
                status check. Do not return cash again.
              </p>
              <button
                disabled={busy || !online}
                onClick={() => void act((signal) => recover(signal, journal))}
              >
                Check original return action
              </button>
              {journal.pending.kind !== 'resolve' && (
                <button
                  disabled={busy || !online}
                  onClick={() => void act((signal) => replay(journal, signal))}
                >
                  Retry the same saved action
                </button>
              )}
              {unrecordedAttestation && journal.pending.kind === 'attest' && (
                <button
                  disabled={busy || !online}
                  onClick={() => {
                    const pending = journal.pending;
                    if (pending?.kind !== 'attest') return;
                    persist({
                      ...journal,
                      pending: null,
                      attestationRetryId: pending.operationId,
                      instructionConsumed: true,
                    });
                    setActualTime(pending.input.returnedAt.slice(0, -1));
                    setReturned(false);
                    setUnrecordedAttestation(false);
                  }}
                >
                  Review unrecorded return evidence
                </button>
              )}
            </>
          )}
          {view && (
            <p role="status">
              Return {view.id} · {view.phase} · {view.returnedCash} · counter {view.counterId}.
            </p>
          )}
          {!view && !journal && context?.eligible && (
            <>
              <label>
                Correction reason
                <select
                  value={reason}
                  disabled={busy || !online}
                  onChange={(e) =>
                    setReason(
                      e.target.value === 'incorrect-payment-record'
                        ? 'incorrect-payment-record'
                        : 'customer-payment-correction',
                    )
                  }
                >
                  <option value="customer-payment-correction">Customer payment correction</option>
                  <option value="incorrect-payment-record">Incorrect payment record</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={noHandover}
                  disabled={busy || !online}
                  onChange={(e) => setNoHandover(e.target.checked)}
                />
                Goods have not been handed over and remain at this counter.
              </label>
              <button
                disabled={busy || !online || !noHandover}
                onClick={() =>
                  void act(async (signal) => {
                    if (
                      !context.snapshotHash ||
                      !context.originalPaymentId ||
                      !context.returnedCash
                    )
                      return;
                    const prepare = {
                      operationId: crypto.randomUUID(),
                      correctionId: crypto.randomUUID(),
                      cashReturnReceiptId: crypto.randomUUID(),
                      originalPaymentId: context.originalPaymentId,
                      snapshotHash: context.snapshotHash,
                      counterId: context.counterId,
                      returnedCash: context.returnedCash,
                      reason,
                      confirmNoHandover: true as const,
                    };
                    const saved = persist({
                      version: 1,
                      intentId: prepare.operationId,
                      correctionId: prepare.correctionId,
                      instructionConsumed: false,
                      prepare,
                      pending: { kind: 'prepare', operationId: prepare.operationId },
                    });
                    await replay(saved, signal);
                  })
                }
              >
                Prepare return of {context.returnedCash}
              </button>
            </>
          )}
          {view?.phase === 'PREPARED' && !journal?.pending && (
            <>
              <p>No cash return has been authorized by this preparation.</p>
              <button
                disabled={busy || !online}
                onClick={() =>
                  void act(async (signal) => {
                    const saved = persist({
                      ...journal!,
                      pending: { kind: 'arm', operationId: crypto.randomUUID() },
                    });
                    await replay(saved, signal);
                  })
                }
              >
                Authorize one cash handback
              </button>
              <label>
                <input
                  type="checkbox"
                  checked={notReturned}
                  disabled={busy || !online}
                  onChange={(e) => setNotReturned(e.target.checked)}
                />
                I reviewed the evidence: no cash was returned for this preparation.
              </label>
              <button
                disabled={busy || !online || !notReturned}
                onClick={() =>
                  void act(async (signal) => {
                    const input = {
                      operationId: crypto.randomUUID(),
                      confirmCashNotReturned: true as const,
                      evidenceId: crypto.randomUUID(),
                      reason: 'correction-not-needed' as const,
                    };
                    const saved = persist({
                      ...journal!,
                      pending: { kind: 'cancel', operationId: input.operationId, input },
                    });
                    await replay(saved, signal);
                  })
                }
              >
                Cancel unperformed preparation
              </button>
            </>
          )}
          {view?.phase === 'RETURN_PENDING' && !journal?.pending && (
            <>
              {instruction ? (
                <p role="status">
                  One cash handback is authorized: return exactly {view.returnedCash} at counter{' '}
                  {view.counterId}, then attest the actual return below.
                </p>
              ) : (
                <p>
                  Cash may already have been handed back. Review its original evidence; this view
                  authorizes no additional cash handback.
                </p>
              )}
              <label>
                Actual cash return time (UTC)
                <input
                  type="datetime-local"
                  step="0.001"
                  value={actualTime}
                  disabled={busy || !online}
                  onChange={(e) => setActualTime(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={returned}
                  disabled={busy || !online}
                  onChange={(e) => {
                    setReturned(e.target.checked);
                    if (e.target.checked && instruction && !actualTime)
                      setActualTime(new Date().toISOString().slice(0, -1));
                  }}
                />
                I confirm this original cash was already returned, and goods remain at the counter.
              </label>
              <button
                disabled={busy || !online || !returned || !actualTime}
                onClick={() =>
                  void act(async (signal) => {
                    const input = {
                      operationId: journal?.attestationRetryId ?? crypto.randomUUID(),
                      returnedAt: new Date(actualTime + 'Z').toISOString(),
                      confirmAlreadyReturned: true as const,
                      confirmNoHandover: true as const,
                      basis:
                        instruction && view.armed?.actorId === user.id
                          ? ('own-return' as const)
                          : ('reviewed-original-return' as const),
                      evidenceId: crypto.randomUUID(),
                    };
                    const saved = persist({
                      ...journal!,
                      instructionConsumed: true,
                      pending: { kind: 'attest', operationId: input.operationId, input },
                    });
                    setInstruction(false);
                    await replay(saved, signal);
                  })
                }
              >
                Attest original cash return
              </button>
            </>
          )}
          {view?.phase === 'ATTESTED' && !journal?.pending && (
            <>
              <p>
                Cash already returned by operator {view.attestation?.evidence.returnedBy} on{' '}
                {view.attestation?.evidence.businessDate}. Record the financial correction for this
                same return.
              </p>
              <button
                disabled={busy || !online}
                onClick={() =>
                  void act(async (signal) => {
                    const saved = persist({
                      ...journal!,
                      pending: { kind: 'resolve', operationId: view.correctionId },
                    });
                    const value = await resolveReturn(scope, view.id, saved.correctionId);
                    await showReceipt(value, signal, saved.correctionId);
                  })
                }
              >
                Reconcile returned cash
              </button>
            </>
          )}
          {view?.phase === 'RECORDED' && (
            <button
              disabled={busy || !online}
              onClick={() =>
                void act(async (signal) => {
                  await showReceipt(
                    await readCorrection(scope, correctionInput(view), signal),
                    signal,
                    view.correctionId,
                  );
                })
              }
            >
              Read original financial receipt
            </button>
          )}
          {view?.phase === 'CANCELLED' && (
            <p>
              This unperformed preparation was cancelled with retained evidence. No cash movement
              was recorded.
            </p>
          )}
          {!view && !journal && !context?.eligible && (
            <p>
              {context?.blocker
                ? `This payment requires reconciliation (${context.blocker}).`
                : 'Loading original payment evidence…'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
