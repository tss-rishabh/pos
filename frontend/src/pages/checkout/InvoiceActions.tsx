import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { FileText } from 'lucide-react';
import type { Principal } from '../../api/types';
import { captureOperatorScope } from '../../api/client';
import { db } from '../../offline/database';
import { cachedOperatorForStore } from '../../offline/operator-session';
import { useOnline } from '../../hooks/use-pos';
import { InvoiceDocumentAction } from '../invoice-documents';
/** Existing call sites retain their explicit protected invoice action. */
export function InvoiceActions({
  storeId,
  orderId,
  ownerId,
}: {
  storeId: string;
  orderId: string;
  ownerId?: string;
}) {
  const online = useOnline(),
    [user, setUser] = useState<Principal | null>(null);
  useEffect(() => {
    let active = true;
    const subscription = liveQuery(async () => {
      const session = await db.sessions.get('current'),
        expected = ownerId ?? session?.user.id;
      if (!expected || localStorage.getItem('pos-pending-logout')) return null;
      const signal = captureOperatorScope(expected),
        principal = cachedOperatorForStore(session, expected, storeId, Date.now());
      signal.throwIfAborted();
      return principal;
    }).subscribe({
      next: (value) => {
        if (active) setUser(value);
      },
      error: () => {
        if (active) setUser(null);
      },
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [ownerId, storeId]);
  if (!user)
    return (
      <button className="button secondary" disabled>
        <FileText size={16} /> Tax invoice
      </button>
    );
  return (
    <InvoiceDocumentAction
      key={user.id + ':' + storeId + ':' + orderId}
      user={user}
      storeId={storeId}
      orderId={orderId}
      online={online}
    />
  );
}
