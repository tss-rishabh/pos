import { useEffect, useRef, useState } from 'react';
import { ApiError, captureOperatorScope } from '../../api/client';
import {
  clearCorrectionIntent,
  clearConfirmedDeviceReferences,
  readCorrection,
  type CorrectionInput,
  type CorrectionReceipt,
  type CorrectionScope,
} from './client';
import {
  getClaim,
  retainClaim,
  retainedClaimInputSchema,
  resolveClaim,
  type ClaimView,
  type RetainedClaimInput,
} from './intents-client';
const claimKey = (scope: CorrectionScope) =>
  `pos:retained-cash-return:v1:${scope.ownerId}:${scope.storeId}:${scope.orderId}`;
function savedClaim(scope: CorrectionScope) {
  const raw = localStorage.getItem(claimKey(scope));
  return raw === null ? null : retainedClaimInputSchema.parse(JSON.parse(raw) as unknown);
}
export function retainedOriginal(scope: CorrectionScope) {
  return savedClaim(scope)?.original ?? null;
}
export function hasRetainedClaim(scope: CorrectionScope) {
  return localStorage.getItem(claimKey(scope)) !== null;
}
export function RetainedCashReturnPanel({
  user,
  storeId,
  orderId,
  online,
  original,
  onCorrected,
  originalOwnerId,
  onRetained,
}: {
  user: { id: string };
  storeId: string;
  orderId: string;
  online: boolean;
  original: CorrectionInput;
  originalOwnerId?: string;
  onRetained?: (claim: ClaimView) => Promise<void>;
  onCorrected?: (receipt: CorrectionReceipt) => Promise<void>;
}) {
  const scope: CorrectionScope = { ownerId: user.id, storeId, orderId },
    [claim, setClaim] = useState<ClaimView | null>(null),
    [input, setInput] = useState<RetainedClaimInput | null>(null),
    [returnedBy, setReturnedBy] = useState(originalOwnerId ?? user.id),
    [actualTime, setActualTime] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [missing, setMissing] = useState(false),
    [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<CorrectionReceipt | null>(null),
    [problem, setProblem] = useState(''),
    mounted = useRef(true),
    lock = useRef(false);
  async function adopt(value: CorrectionReceipt, signal: AbortSignal) {
    if (signal.aborted || !mounted.current) return;
    setReceipt(value);
    clearCorrectionIntent(scope);
    clearConfirmedDeviceReferences(storeId, orderId, original.operationId);
    try {
      await onCorrected?.(value);
    } catch {
      if (!signal.aborted && mounted.current)
        setProblem(
          'Original cash correction is recorded. Refresh order details; do not return cash again.',
        );
    }
  }
  async function read(signal: AbortSignal) {
    setMissing(false);
    const saved = savedClaim(scope);
    if (saved) {
      setInput(saved);
      setReturnedBy(saved.returnedBy);
      setActualTime(saved.returnedAt.slice(0, -1));
    }
    try {
      await adopt(
        await readCorrection(scope, { ...original, claimId: original.operationId }, signal),
        signal,
      );
      return;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'PAYMENT_REVERSAL_NOT_FOUND')) throw error;
    }
    try {
      const value = await getClaim(scope, original.operationId, signal);
      if (!signal.aborted && mounted.current) setClaim(value);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'CASH_RETURN_CLAIM_NOT_FOUND')) throw error;
    }
    if (!signal.aborted && mounted.current) setMissing(true);
  }
  useEffect(() => {
    mounted.current = true;
    const signal = captureOperatorScope(user.id);
    if (online)
      void read(signal).catch((error) => {
        if (mounted.current && !signal.aborted)
          setProblem(
            error instanceof Error ? error.message : 'Read the original cash-return reference.',
          );
      });
    return () => {
      mounted.current = false;
    };
    // The parent remounts whenever actor/store/order changes.
  }, [user.id, storeId, orderId, online]);
  async function act(task: (signal: AbortSignal) => Promise<void>) {
    if (lock.current || !online) return;
    const signal = captureOperatorScope(user.id);
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task(signal);
    } catch (error) {
      if (mounted.current && !signal.aborted)
        setProblem(
          error instanceof Error ? error.message : 'Retain the original cash-return reference.',
        );
    } finally {
      lock.current = false;
      if (mounted.current && !signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Retained original cash return">
      <h3>Recover original cash return</h3>
      <p>
        Original correction {original.operationId}. Cash was attested in an earlier device journal.
        Never hand cash back again, replace this reference or discard an unknown outcome.
      </p>
      {problem && <p role="alert">{problem}</p>}
      {receipt ? (
        <p role="status">
          Original cash correction {receipt.id} is recorded · {receipt.returnedCash} returned ·{' '}
          {receipt.businessDate}.
        </p>
      ) : (
        <>
          <button disabled={busy || !online} onClick={() => void act(read)}>
            Check original cash correction
          </button>
          {claim ? (
            <>
              <p role="status">
                Original claim {claim.id} is retained by the server for store managers. Actual
                return date {claim.businessDate}; original handler {claim.returnedBy}. No new cash
                return is authorized.
              </p>
              <button
                disabled={busy || !online || !missing}
                onClick={() =>
                  void act(async (signal) => {
                    setMissing(false);
                    await adopt(await resolveClaim(scope, claim.id), signal);
                  })
                }
              >
                Reconcile retained original claim
              </button>
            </>
          ) : (
            missing && (
              <>
                <label>
                  Original cash handler operator ID
                  <input
                    value={returnedBy}
                    disabled={busy || !online || !!input}
                    onChange={(e) => setReturnedBy(e.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <label>
                  Actual original cash return time (UTC)
                  <input
                    type="datetime-local"
                    step="0.001"
                    value={actualTime}
                    disabled={busy || !online || !!input}
                    onChange={(e) => setActualTime(e.target.value)}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy || !online}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I reviewed evidence that this original cash was already returned.
                </label>
                <button
                  disabled={busy || !online || (!input && (!confirmed || !actualTime))}
                  onClick={() =>
                    void act(async (signal) => {
                      const value =
                        input ??
                        retainedClaimInputSchema.parse({
                          original,
                          returnedBy,
                          returnedAt: new Date(actualTime + 'Z').toISOString(),
                          confirmAlreadyReturned: true,
                          evidenceId: crypto.randomUUID(),
                        });
                      const serialized = JSON.stringify(value);
                      localStorage.setItem(claimKey(scope), serialized);
                      if (localStorage.getItem(claimKey(scope)) !== serialized)
                        throw new Error(
                          'Retain the original cash-return evidence before registering it.',
                        );
                      setInput(value);
                      const outcome = await retainClaim(scope, value);
                      if (signal.aborted || !mounted.current) return;
                      if (
                        outcome.id !== original.operationId ||
                        outcome.storeId !== storeId ||
                        outcome.orderId !== orderId
                      )
                        throw new Error('The retained claim does not match its original scope.');
                      setClaim(outcome);
                      await onRetained?.(outcome);
                    })
                  }
                >
                  {input
                    ? 'Retain the same original claim'
                    : 'Retain original claim for store managers'}
                </button>
              </>
            )
          )}
        </>
      )}
    </section>
  );
}
