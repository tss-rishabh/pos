import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { Principal } from '../../../api/types';
import { captureOperatorScope } from '../../../api/client';
import { db } from '../../../offline/database';
import type { LocalCashSync } from '../../../offline/cash/storage-types';
import { currentCashScope, refreshOfflineCashReceipt } from '../../../offline/cash/sync';
import {
  retryOfflineCashOrderImport,
  startOfflineCashOrderImport,
} from '../../../offline/cash/order-import';

export function CashOrderSyncActions({
  user,
  storeId,
  receiptId,
  online,
}: {
  user: Principal;
  storeId: string;
  receiptId: string;
  online: boolean;
}) {
  const [job, setJob] = useState<LocalCashSync | null>(null),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [notice, setNotice] = useState(''),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const session = await db.sessions.get('current');
      if (
        !session ||
        !currentCashScope(session.user, user, storeId) ||
        session.expiresAt <= Date.now() ||
        localStorage.getItem('pos-pending-logout')
      )
        return null;
      const value = await db.offlineCashSync.get(receiptId);
      return value?.ownerId === user.id && value.storeId === storeId ? value : null;
    }).subscribe({
      next: setJob,
      error: () => setProblem('The saved order synchronization attempt could not be opened.'),
    });
    return () => subscription.unsubscribe();
  }, [user, storeId, receiptId, now]);

  async function perform(action: 'check' | 'start' | 'retry') {
    if (!online || busy) return;
    let signal: AbortSignal;
    try {
      signal = captureOperatorScope(user.id);
    } catch {
      return;
    }
    setBusy(true);
    setProblem('');
    setNotice('');
    try {
      const result =
        action === 'check'
          ? await refreshOfflineCashReceipt(user, storeId, receiptId, { signal })
          : await (action === 'retry' ? retryOfflineCashOrderImport : startOfflineCashOrderImport)(
              user,
              storeId,
              receiptId,
              { signal },
            );
      signal.throwIfAborted();
      setNotice(
        result?.status === 'imported'
          ? 'The saved cash receipt is linked to its synchronized order.'
          : result?.status === 'conflicted'
            ? 'The cash remains recorded. A manager must review the order reconciliation.'
            : 'Cash remains recorded. The order outcome is not yet confirmed.',
      );
    } catch (error) {
      if (!signal.aborted)
        setProblem(
          error instanceof Error ? error.message : 'The order outcome is not yet confirmed.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  if (!job || job.state !== 'accepted') return null;
  const intent = job.orderImport,
    canRetry =
      intent?.state === 'uncertain' ||
      (intent?.state === 'dispatching' && intent.dispatchedAt + 30_000 <= now);
  if (!intent && job.autoImportEligible === false) return null;
  return (
    <section aria-label="Cash order synchronization">
      <p role="status">
        {intent?.state === 'blocked'
          ? 'Cash remains recorded. This order requires manager review.'
          : intent?.state === 'uncertain' || canRetry
            ? 'Cash remains recorded. Check the order outcome before explicitly retrying the saved attempt.'
            : intent
              ? 'Cash remains recorded. Order synchronization is in progress.'
              : 'Cash remains recorded. The saved receipt is ready to synchronize its order.'}
      </p>
      {notice && <p role="status">{notice}</p>}
      {problem && (
        <p role="alert" className="inline-error">
          {problem}
        </p>
      )}
      <div className="cash-actions">
        <button
          className="button secondary"
          disabled={!online || busy}
          onClick={() => void perform('check')}
        >
          Check cash order status
        </button>
        {!intent && (
          <button
            className="button secondary"
            disabled={!online || busy}
            onClick={() => void perform('start')}
          >
            Synchronize saved cash order
          </button>
        )}
        {canRetry && (
          <button
            className="button secondary"
            disabled={!online || busy}
            onClick={() => void perform('retry')}
          >
            Retry saved order synchronization
          </button>
        )}
      </div>
    </section>
  );
}
