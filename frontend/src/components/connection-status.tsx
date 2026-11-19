import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { CloudOff, CloudUpload, ShieldAlert } from 'lucide-react';
import { desktopOfflineBridge, offlineBillingClient } from '../offline/billing/bridge';
import type { OfflineStatus } from '../offline/billing/contracts';

/** Desktop offline-billing queue counts from the Electron bridge; null on the web. */
function useDesktopOfflineQueue() {
  const client = useMemo(() => {
    const bridge = desktopOfflineBridge();
    return bridge ? offlineBillingClient(bridge) : null;
  }, []);
  const [queue, setQueue] = useState<OfflineStatus['queue'] | null>(null);
  useEffect(() => {
    if (!client) return;
    let active = true;
    const refresh = () =>
      void client
        .call('offline:status', {})
        .then((status) => {
          if (active) setQueue(status.queue);
        })
        .catch(() => {
          if (active) setQueue(null);
        });
    refresh();
    const unsubscribe = client.onStatusChanged(refresh);
    const timer = setInterval(refresh, 30000);
    return () => {
      active = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, [client]);
  return queue;
}

/**
 * Compact header status (W27). Nothing is shown while online with nothing waiting. It appears
 * only when the device is offline, when saved sales wait to sync, or when offline sales need a
 * manager (desktop).
 */
export function ConnectionStatus({
  online,
  pendingOperations,
}: {
  online: boolean;
  pendingOperations: number;
}) {
  const queue = useDesktopOfflineQueue();
  const waiting = pendingOperations + (queue ? queue.queued + queue.syncing : 0);
  const needsManager = queue?.needsManager ?? 0;
  const desktopSales = queue !== null && queue.queued + queue.syncing + queue.needsManager > 0;
  const target = desktopSales ? '/offline-billing' : '/sync';
  return (
    <>
      {!online && (
        <NavLink
          to={queue ? '/offline-billing' : '/sync'}
          className="status-chip warning"
          title="You’re offline. Your carts stay on this device. Reconnect to confirm prices and sync saved sales."
          aria-label="Offline. Your carts stay on this device. Reconnect to confirm prices and sync saved sales."
        >
          <CloudOff size={14} aria-hidden="true" />
          <span>Offline</span>
        </NavLink>
      )}
      {waiting > 0 && (
        <NavLink
          to={target}
          className="status-chip"
          aria-label={`${waiting} ${waiting === 1 ? 'sale' : 'sales'} waiting to sync`}
        >
          <CloudUpload size={14} aria-hidden="true" />
          <span>{waiting} unsynced</span>
        </NavLink>
      )}
      {needsManager > 0 && (
        <NavLink
          to="/offline-billing"
          className="status-chip danger"
          aria-label={`${needsManager} offline ${needsManager === 1 ? 'sale needs' : 'sales need'} a manager`}
        >
          <ShieldAlert size={14} aria-hidden="true" />
          <span>{needsManager} need manager</span>
        </NavLink>
      )}
    </>
  );
}
