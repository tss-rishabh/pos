import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { desktopOfflineBridge, offlineBillingClient } from './bridge';

/** Desktop only: when the workspace loses the store service while the cashier
 * is on the counter, switch to offline billing; return to the counter once the
 * connection is back. Web clients have no bridge and stay where they are.
 *
 * `online` is the browser's network flag, which stays true when the device is
 * still on a LAN/Wi-Fi without a working route to the store service. On desktop
 * the main process probes the store service itself, so its reachability decides. */
export function useOfflineBillingAutoSwitch(online: boolean) {
  const navigate = useNavigate(),
    location = useLocation(),
    switched = useRef(false),
    [reachable, setReachable] = useState<boolean | null>(null);
  useEffect(() => {
    const bridge = desktopOfflineBridge();
    if (!bridge) return;
    const client = offlineBillingClient(bridge);
    let active = true;
    const read = () =>
      void client
        .call('offline:status', {})
        .then((status) => {
          if (active)
            setReachable(status.available && status.reachabilityKnown ? status.online : null);
        })
        .catch(() => undefined);
    read();
    const unsubscribe = client.onStatusChanged(read);
    const timer = setInterval(read, 15000);
    return () => {
      active = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const connected = online && reachable !== false;
  useEffect(() => {
    if (!desktopOfflineBridge()) return;
    if (!connected && location.pathname === '/') {
      switched.current = true;
      navigate('/offline-billing');
    } else if (connected && switched.current && location.pathname === '/offline-billing') {
      switched.current = false;
      navigate('/');
    }
  }, [connected, location.pathname, navigate]);
}
