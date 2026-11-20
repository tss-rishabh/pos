import { NavLink } from 'react-router-dom';
import { CloudOff, CloudUpload, ShieldAlert } from 'lucide-react';
import { useOfflineStatus } from '../offline/billing/status-store';

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
  // Desktop offline-billing status (reachability and queue), shared with the other consumers;
  // null on the web, and while the last read failed.
  const shared = useOfflineStatus();
  const desktop = shared.error ? null : shared.status;
  const queue = desktop?.queue ?? null;
  // The desktop also knows when the store service is unreachable while the OS reports a network.
  const offline = !online || desktop?.online === false;
  const waiting = pendingOperations + (queue ? queue.queued + queue.syncing : 0);
  const needsManager = queue?.needsManager ?? 0;
  const desktopSales = queue !== null && queue.queued + queue.syncing + queue.needsManager > 0;
  const target = desktopSales ? '/offline-billing' : '/sync';
  return (
    <>
      {offline && (
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
