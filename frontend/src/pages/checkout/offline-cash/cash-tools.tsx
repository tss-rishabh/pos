import { useEffect, useRef, useState } from 'react';
import Dexie, { liveQuery } from 'dexie';
import { Banknote, Printer, RefreshCw, X } from 'lucide-react';
import type { Principal } from '../../../api/types';
import { captureOperatorScope } from '../../../api/client';
import { db, type LocalDraft } from '../../../offline/database';
import { prepareReview } from '../../../offline/review-snapshot';
import { activateCashAuthorization, completeOfflineCash } from '../../../offline/cash/complete';
import { createCashDeviceKeys, verifyCashAuthorization } from '../../../offline/cash/crypto';
import { cashLines, cashTotals } from '../../../offline/cash/evidence';
import { MAX_CASH_CENTS } from '../../../offline/cash/contracts';
import { registerCashDevice, requestCashAuthorization } from '../../../offline/cash/client';
import { synchronizeOfflineCashScope } from '../../../offline/cash/runner';
import { useOfflineCashSync } from '../../../offline/cash/use-sync';
import { requireOfflineCashShell } from '../../../offline/shell-ready';
import receiptStylesUrl from './styles.css?url&no-inline';
import type { LocalCashAuthorization, LocalCashReceipt } from '../../../offline/cash/storage-types';
import { recoveryFor } from '../client';
import { CashReceiptDialog, cashCurrency } from './receipt';
import { CashManagerDialog } from './manager';
import { CashOrderSyncActions } from './order-sync-actions';

export interface CashToolsProps {
  user: Principal;
  storeId: string;
  counterId: string;
  draft: LocalDraft | undefined;
  online: boolean;
  reviewBusy: boolean;
  onlineReviewRequired?: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: (snapshot: LocalDraft, receipt: LocalCashReceipt) => void;
}
function operatorSignal(ownerId: string) {
  try {
    return captureOperatorScope(ownerId);
  } catch {
    return null;
  }
}
function cashInput(value: string) {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value))
    throw new Error('Enter cash received with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.'),
    cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(MAX_CASH_CENTS)) throw new Error('Cash received exceeds the supported limit.');
  return Number(cents);
}
function CashTender({
  snapshot,
  authorization,
  onClose,
  onCompleted,
}: {
  snapshot: LocalDraft;
  authorization: LocalCashAuthorization;
  onClose: () => void;
  onCompleted: (value: LocalCashReceipt) => void;
}) {
  const [cash, setCash] = useState(''),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [verified, setVerified] = useState(false);
  useEffect(() => {
    let active = true;
    void verifyCashAuthorization(
      authorization.envelope,
      authorization.snapshot,
      authorization.serverKey,
    )
      .then(() => {
        if (active) setVerified(true);
      })
      .catch(() => {
        if (active)
          setProblem(
            'The saved cash prices could not be verified. Reconnect before accepting cash.',
          );
      });
    return () => {
      active = false;
    };
  }, [authorization]);
  let lines: ReturnType<typeof cashLines> = [],
    total = 0,
    received: number | null = null;
  try {
    lines = cashLines(authorization.snapshot, snapshot.lines);
    total = cashTotals(lines).payableCents;
    received = cash ? cashInput(cash) : null;
  } catch {
    /* Invalid input keeps completion disabled until corrected. */
  }
  async function complete() {
    if (busy || !verified) return;
    const signal = operatorSignal(snapshot.ownerId);
    if (!signal) return;
    setBusy(true);
    setProblem('');
    try {
      const amount = cashInput(cash),
        result = await completeOfflineCash(snapshot, authorization.id, amount, signal);
      if (!signal.aborted) onCompleted(result.value);
    } catch (error) {
      if (!signal.aborted)
        setProblem(
          error instanceof Error
            ? error.message
            : 'Cash could not be recorded. Keep this sale open.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal cash-tender-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cash-tender-title"
      >
        <button
          className="icon-button modal-close"
          aria-label="Close cash sale"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <div className="eyebrow">CASH SALE</div>
        <h2 id="cash-tender-title">Complete cash sale</h2>
        <p>
          Walk-in sale with saved prices. Cash completion and its receipt are saved on this device.
        </p>
        {problem && (
          <p role="alert" className="inline-error">
            {problem}
          </p>
        )}
        <ul className="cash-tender-lines">
          {lines.map((line) => (
            <li key={line.productId}>
              <span>
                {line.name} × {line.quantity}
              </span>
              <strong>{cashCurrency(line.taxableCents + line.taxCents)}</strong>
            </li>
          ))}
        </ul>
        <h3>Total {cashCurrency(total)}</h3>
        <label>
          Cash received
          <input
            aria-label="Offline cash received"
            inputMode="decimal"
            autoComplete="off"
            value={cash}
            disabled={busy || !verified}
            onChange={(event) => setCash(event.target.value)}
          />
        </label>
        <p>
          Change {received !== null && received >= total ? cashCurrency(received - total) : '—'}
        </p>
        <button
          className="button primary full"
          disabled={busy || !verified || received === null || received < total || total <= 0}
          onClick={() => void complete()}
        >
          <Banknote size={18} />
          {busy ? 'Recording cash…' : 'Record cash and complete sale'}
        </button>
        <p className="caption">
          Customer benefits need online checkout. Stock differences found after reconnecting are
          sent to a manager.
        </p>
      </section>
    </div>
  );
}

export function CashTools({
  user,
  storeId,
  counterId,
  draft,
  online,
  reviewBusy,
  onlineReviewRequired = false,
  onOpenChange,
  onCompleted,
}: CashToolsProps) {
  useOfflineCashSync(user, storeId, counterId, online);
  const [authorization, setAuthorization] = useState<LocalCashAuthorization | null>(null),
    [receipts, setReceipts] = useState<LocalCashReceipt[]>([]),
    [snapshot, setSnapshot] = useState<LocalDraft | null>(null),
    [frozenAuthorization, setFrozenAuthorization] = useState<LocalCashAuthorization | null>(null),
    [selected, setSelected] = useState<LocalCashReceipt | null>(null),
    [busy, setBusy] = useState(false),
    [syncing, setSyncing] = useState(false),
    [pending, setPending] = useState(0),
    [historyLimit, setHistoryLimit] = useState(10),
    [managerOpen, setManagerOpen] = useState(false),
    [problem, setProblem] = useState('');
  const [tick, setTick] = useState(0);
  const syncLock = useRef(false);
  useEffect(() => {
    if (managerOpen && ![1, 2, 3, 4].includes(user.role)) {
      setManagerOpen(false);
      onOpenChange(false);
    }
  }, [managerOpen, user.role, onOpenChange]);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const current = await db.sessions.get('current');
      if (
        !current ||
        current.user.id !== user.id ||
        current.expiresAt <= Date.now() ||
        localStorage.getItem('pos-pending-logout')
      )
        return { authorization: null, receipts: [], pending: 0 };
      const grants = await db.offlineCashAuthorizations
        .where('[ownerId+storeId+counterId+expiresAt]')
        .between(
          [user.id, storeId, counterId, Date.now()],
          [user.id, storeId, counterId, Dexie.maxKey],
          true,
          true,
        )
        .filter((row) => row.revokedAt === null)
        .toArray();
      const values = await db.offlineCashReceipts
        .where('[ownerId+storeId+completedAt]')
        .between([user.id, storeId, Dexie.minKey], [user.id, storeId, Dexie.maxKey])
        .reverse()
        .limit(historyLimit)
        .toArray();
      const pending = await db.offlineCashSync
        .where('[ownerId+state]')
        .anyOf(['pending', 'retry', 'sending', 'accepted'].map((state) => [user.id, state]))
        .filter((job) => job.storeId === storeId)
        .count();
      return {
        authorization: grants.sort((a, b) => b.issuedAt - a.issuedAt)[0] || null,
        receipts: values.sort((a, b) => b.completedAt - a.completedAt),
        pending,
      };
    }).subscribe({
      next: (value) => {
        setAuthorization(value.authorization);
        setReceipts(value.receipts);
        setPending(value.pending);
      },
      error: () => setProblem('The saved cash workspace could not be opened.'),
    });
    return () => subscription.unsubscribe();
  }, [user.id, storeId, counterId, tick, historyLimit]);
  async function synchronize() {
    if (!online || syncLock.current) return;
    const signal = operatorSignal(user.id);
    if (!signal) return;
    setSyncing(true);
    syncLock.current = true;
    try {
      await synchronizeOfflineCashScope(user, storeId, counterId, { signal });
    } catch (error) {
      if (!signal.aborted)
        setProblem(error instanceof Error ? error.message : 'Cash synchronization is pending.');
    } finally {
      syncLock.current = false;
      if (!signal.aborted) setSyncing(false);
    }
  }
  async function enable() {
    if (!online || busy || authorization) return;
    const signal = operatorSignal(user.id);
    if (!signal) return;
    setBusy(true);
    setProblem('');
    try {
      await requireOfflineCashShell(signal, [receiptStylesUrl]);
      signal.throwIfAborted();
      let device = await db.offlineCashDevices
        .where('[ownerId+storeId+counterId]')
        .equals([user.id, storeId, counterId])
        .first();
      if (!device) {
        const keys = await createCashDeviceKeys();
        signal.throwIfAborted();
        device = {
          ownerId: user.id,
          deviceId: crypto.randomUUID(),
          storeId,
          counterId,
          ...keys,
          createdAt: Date.now(),
        };
        await db.transaction('rw', [db.sessions, db.offlineCashDevices], async () => {
          signal.throwIfAborted();
          const current = await db.sessions.get('current');
          if (
            !current ||
            current.user.id !== user.id ||
            current.expiresAt <= Date.now() ||
            localStorage.getItem('pos-pending-logout')
          )
            throw new Error('Sign in again before enabling offline cash.');
          const existing = await db.offlineCashDevices
            .where('[ownerId+storeId+counterId]')
            .equals([user.id, storeId, counterId])
            .first();
          if (existing) device = existing;
          else await db.offlineCashDevices.add(device!);
        });
      }
      await registerCashDevice(user.id, storeId, counterId, device.deviceId, device.publicKey);
      const cached = await db.catalog
        .where('[ownerId+storeId]')
        .equals([user.id, storeId])
        .filter((product) => product.type === '1' && product.stock > 0)
        .limit(1000)
        .toArray();
      const productIds = [
        ...new Set([
          ...(draft?.lines.map((line) => line.productId) || []),
          ...cached.map((product) => product.id),
        ]),
      ].slice(0, 1000);
      if (!productIds.length)
        throw new Error('Load the store catalog while online before enabling offline cash.');
      const reply = await requestCashAuthorization(
        user.id,
        storeId,
        counterId,
        device.deviceId,
        productIds,
      );
      await activateCashAuthorization(
        user.id,
        reply.envelope,
        reply.snapshot,
        reply.serverKey,
        signal,
      );
    } catch (error) {
      if (!signal.aborted)
        setProblem(error instanceof Error ? error.message : 'Offline cash could not be enabled.');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  async function open() {
    if (!draft?.lines.length || !authorization || busy || reviewBusy) return;
    const signal = operatorSignal(user.id);
    if (!signal) return;
    setBusy(true);
    setProblem('');
    try {
      if (onlineReviewRequired)
        throw new Error(
          'This copied sale must be completed or cleared online before separate cash can be recorded.',
        );
      await requireOfflineCashShell(signal, [receiptStylesUrl]);
      signal.throwIfAborted();
      const prepared = await prepareReview(draft, recoveryFor(user.id, draft.id));
      const record = await db.reviewSnapshots.get([user.id, draft.id]);
      if (record?.checkoutId)
        throw new Error(
          'This sale has an online checkout. Finish or clear that checkout before recording separate cash.',
        );
      cashLines(authorization.snapshot, prepared.snapshot.lines);
      signal.throwIfAborted();
      setSnapshot(prepared.snapshot);
      setFrozenAuthorization(structuredClone(authorization));
      onOpenChange(true);
    } catch (error) {
      if (!signal.aborted)
        setProblem(
          error instanceof Error ? error.message : 'The saved cash sale could not be opened.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  function close() {
    setSnapshot(null);
    setFrozenAuthorization(null);
    onOpenChange(false);
  }
  const shown = selected
    ? receipts.find((receipt) => receipt.receiptId === selected.receiptId) || selected
    : null;
  return (
    <section className="cash-tools" aria-label="Offline cash">
      <div className="cash-actions">
        {[1, 2, 3, 4].includes(user.role) && (
          <button
            className="button secondary"
            disabled={busy || reviewBusy || !!snapshot || managerOpen || !storeId}
            onClick={() => {
              setManagerOpen(true);
              onOpenChange(true);
            }}
          >
            Review offline cash
          </button>
        )}
        <button
          className="button secondary"
          disabled={!online || busy || !!authorization || !storeId || !counterId}
          onClick={() => void enable()}
        >
          {busy
            ? 'Preparing cash prices…'
            : authorization
              ? 'Offline cash enabled'
              : 'Enable offline cash'}
        </button>
        <button
          className="button secondary"
          disabled={
            busy || reviewBusy || onlineReviewRequired || !authorization || !draft?.lines.length
          }
          onClick={() => void open()}
        >
          <Banknote size={17} /> Complete cash offline
        </button>
      </div>
      {onlineReviewRequired && (
        <p role="status">Finish or clear the copied sale online before recording separate cash.</p>
      )}
      <p className="cash-status">
        {authorization
          ? `Saved cash prices for ${authorization.snapshot.products.length} items, valid until ${new Date(authorization.expiresAt).toLocaleTimeString()}.`
          : 'Enable while connected to save verified cash prices and a protected receipt sequence.'}
      </p>
      {problem && (
        <p role="alert" className="inline-error">
          {problem}
        </p>
      )}
      {receipts.length > 0 && (
        <details>
          <summary>
            Saved cash receipts{pending ? ` · ${pending} pending reconciliation` : ''}
          </summary>
          <div className="cash-actions">
            <button
              className="button secondary"
              disabled={!online || syncing}
              onClick={() => void synchronize()}
            >
              <RefreshCw size={16} />{' '}
              {syncing ? 'Synchronizing cash…' : 'Synchronize cash receipts'}
            </button>
          </div>
          <div className="cash-history">
            {receipts.map((receipt) => (
              <button
                className="button secondary"
                key={receipt.receiptId}
                onClick={() => setSelected(receipt)}
              >
                <span>
                  {cashCurrency(receipt.envelope.receipt.payableCents)} ·{' '}
                  {receipt.envelope.receipt.businessDate}
                </span>
                <Printer size={16} />
              </button>
            ))}
          </div>
          {receipts.length === historyLimit && (
            <button
              className="button secondary"
              onClick={() => setHistoryLimit((value) => value + 10)}
            >
              Show earlier cash receipts
            </button>
          )}
        </details>
      )}
      {snapshot && frozenAuthorization && (
        <CashTender
          snapshot={snapshot}
          authorization={frozenAuthorization}
          onClose={close}
          onCompleted={(value) => {
            const original = snapshot;
            close();
            onCompleted(original, value);
            setSelected(value);
            if (online) void synchronize();
          }}
        />
      )}
      {shown && (
        <CashReceiptDialog
          key={shown.receiptId}
          value={shown}
          operatorId={user.id}
          online={online}
          actions={
            <CashOrderSyncActions
              user={user}
              storeId={storeId}
              receiptId={shown.receiptId}
              online={online}
            />
          }
          onClose={() => setSelected(null)}
        />
      )}
      {managerOpen && (
        <CashManagerDialog
          user={user}
          storeId={storeId}
          online={online}
          onClose={() => {
            setManagerOpen(false);
            onOpenChange(false);
          }}
        />
      )}
    </section>
  );
}
