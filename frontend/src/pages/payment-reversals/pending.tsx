import { useEffect, useRef, useState } from 'react';
import { ApiError, captureOperatorScope } from '../../api/client';
import {
  pendingClaims,
  pendingReturns,
  resolveClaim,
  type CashReturnView,
  type ClaimView,
} from './intents-client';
import { RetainedCashReturnPanel } from './retained-panel';
import { CashReturnIntentPanel } from './intent-panel';
import { retainedDeviceReferences, readBoundCorrection, type CorrectionReceipt } from './client';
export function CashReturnPendingQueue({
  user,
  storeId,
  online,
}: {
  user: { id: string };
  storeId: string;
  online: boolean;
}) {
  return <Queue key={`${user.id}:${storeId}`} user={user} storeId={storeId} online={online} />;
}
function Queue({
  user,
  storeId,
  online,
}: {
  user: { id: string };
  storeId: string;
  online: boolean;
}) {
  const [open, setOpen] = useState(false),
    [items, setItems] = useState<CashReturnView[]>([]),
    [claims, setClaims] = useState<ClaimView[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [claimCursor, setClaimCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<CashReturnView | null>(null),
    [device, setDevice] = useState<ReturnType<typeof retainedDeviceReferences>>([]),
    [selectedDevice, setSelectedDevice] = useState<
      ReturnType<typeof retainedDeviceReferences>[number] | null
    >(null),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [receipt, setReceipt] = useState<CorrectionReceipt | null>(null),
    [unknown, setUnknown] = useState<ReadonlySet<string>>(new Set()),
    mounted = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load(more = false) {
    if (lock.current || !online) return;
    const signal = captureOperatorScope(user.id);
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      const [returns, retained] = await Promise.all([
        !more || cursor
          ? pendingReturns(user.id, storeId, more ? (cursor ?? undefined) : undefined, signal)
          : Promise.resolve(null),
        !more || claimCursor
          ? pendingClaims(user.id, storeId, more ? (claimCursor ?? undefined) : undefined, signal)
          : Promise.resolve(null),
      ]);
      if (!mounted.current || signal.aborted) return;
      if (returns) {
        if (returns.data.some((row) => row.storeId !== storeId))
          throw new Error('Cash-return queue scope changed.');
        setItems((old) => (more ? [...old, ...returns.data] : returns.data));
        setCursor(returns.nextCursor);
      }
      if (retained) {
        if (retained.data.some((row) => row.storeId !== storeId))
          throw new Error('Retained-return queue scope changed.');
        setClaims((old) => (more ? [...old, ...retained.data] : retained.data));
        setClaimCursor(retained.nextCursor);
      }
      setOpen(true);
      setDevice(retainedDeviceReferences(storeId));
    } catch (error) {
      if (mounted.current && !signal.aborted)
        setProblem(
          error instanceof Error ? error.message : 'The store cash-return queue is unavailable.',
        );
    } finally {
      lock.current = false;
      if (mounted.current && !signal.aborted) setBusy(false);
    }
  }
  async function reconcile(claim: ClaimView) {
    if (lock.current || !online) return;
    const signal = captureOperatorScope(user.id);
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      if (unknown.has(claim.id)) {
        try {
          const value = await readBoundCorrection(
            { ownerId: user.id, storeId, orderId: claim.orderId },
            claim.id,
            claim.originalPaymentId,
            signal,
          );
          if (!signal.aborted && mounted.current) {
            if (
              value.counterId !== claim.counterId ||
              value.cashReturnReceiptId !== claim.cashReturnReceiptId ||
              value.returnedCash !== claim.returnedCash
            )
              throw new Error('The original receipt does not match the retained cash claim.');
            setReceipt(value);
            setUnknown((old) => new Set([...old].filter((id) => id !== claim.id)));
            setProblem(
              'Original financial receipt found. Refresh the store queue; reconcile the same retained claim only if its server link is still pending.',
            );
          }
        } catch (error) {
          if (!(error instanceof ApiError && error.code === 'PAYMENT_REVERSAL_NOT_FOUND'))
            throw error;
          if (!signal.aborted && mounted.current) {
            setUnknown((old) => new Set([...old].filter((id) => id !== claim.id)));
            setProblem(
              'The original correction was not found. Its cash remains retained. Reconcile the same claim explicitly; do not return cash again.',
            );
          }
        }
        return;
      }
      setUnknown((old) => new Set([...old, claim.id]));
      const value = await resolveClaim(
        { ownerId: user.id, storeId, orderId: claim.orderId },
        claim.id,
      );
      if (signal.aborted || !mounted.current) return;
      if (
        value.id !== claim.id ||
        value.storeId !== storeId ||
        value.orderId !== claim.orderId ||
        value.originalPaymentId !== claim.originalPaymentId ||
        value.counterId !== claim.counterId ||
        value.cashReturnReceiptId !== claim.cashReturnReceiptId ||
        value.returnedCash !== claim.returnedCash
      )
        throw new Error('The retained-return receipt does not match its original reference.');
      setReceipt(value);
      setClaims((old) => old.filter((row) => row.id !== claim.id));
    } catch (error) {
      if (mounted.current && !signal.aborted)
        setProblem(
          error instanceof Error
            ? error.message
            : 'Read the original financial receipt before continuing.',
        );
    } finally {
      lock.current = false;
      if (mounted.current && !signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Store cash-return reconciliation">
      <h3>Store pending cash returns</h3>
      <p>
        Review pending preparations and cash already returned by authorized operators at this store,
        including other devices. Returned or uncertain cash cannot be cancelled.
      </p>
      <button disabled={busy || !online} onClick={() => void load()}>
        Review store cash returns
      </button>
      {problem && <p role="alert">{problem}</p>}
      {open && (
        <>
          {device.length > 0 && (
            <>
              <h4>Earlier cash returns retained on this device</h4>
              <p>
                Review each original reference and actual cash-return evidence before retaining it
                in the shared manager queue. No additional handback is authorized.
              </p>
              <ul>
                {device.map((row) => (
                  <li key={row.ownerId + ':' + row.original.operationId}>
                    Order {row.orderId} · original operator {row.ownerId} ·{' '}
                    {row.original.returnedCash} · original reference {row.original.operationId}{' '}
                    <button disabled={busy || !online} onClick={() => setSelectedDevice(row)}>
                      Review retained device claim {row.original.operationId}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                Order {item.orderId} · counter {item.counterId} · {item.phase} · {item.returnedCash}{' '}
                · operator {item.armed?.actorId ?? item.preparedBy}{' '}
                <button disabled={busy || !online} onClick={() => setSelected(item)}>
                  Review return {item.id}
                </button>
              </li>
            ))}
            {claims.map((claim) => (
              <li key={'claim:' + claim.id}>
                Retained original claim · order {claim.orderId} · counter {claim.counterId} ·{' '}
                {claim.returnedCash} returned on {claim.businessDate} by operator {claim.returnedBy}
                .{' '}
                <button disabled={busy || !online} onClick={() => void reconcile(claim)}>
                  {unknown.has(claim.id) ? 'Check original claim' : 'Reconcile original claim'}{' '}
                  {claim.id}
                </button>
              </li>
            ))}
          </ul>
          {!items.length && !claims.length && <p>No pending cash returns in this store queue.</p>}
          {(cursor || claimCursor) && (
            <button disabled={busy || !online} onClick={() => void load(true)}>
              Load more cash returns
            </button>
          )}
        </>
      )}
      {selectedDevice && (
        <RetainedCashReturnPanel
          key={selectedDevice.original.operationId}
          user={user}
          storeId={storeId}
          orderId={selectedDevice.orderId}
          online={online}
          original={selectedDevice.original}
          originalOwnerId={selectedDevice.ownerId}
          onRetained={async () => {
            await load();
          }}
          onCorrected={async (value) => {
            setReceipt(value);
            setSelectedDevice(null);
            await load();
          }}
        />
      )}
      {selected && (
        <CashReturnIntentPanel
          key={selected.id}
          user={user}
          storeId={storeId}
          orderId={selected.orderId}
          intentId={selected.id}
          online={online}
          onCorrected={async (value) => {
            setReceipt(value);
            setSelected(null);
            await load();
          }}
        />
      )}
      {receipt && (
        <p role="status">
          Original cash correction {receipt.id} is recorded. No additional cash handback is
          authorized.
        </p>
      )}
    </section>
  );
}
