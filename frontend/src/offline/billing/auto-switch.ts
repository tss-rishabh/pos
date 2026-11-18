import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { desktopOfflineBridge } from './bridge';

/** Desktop only: when the workspace loses the store service while the cashier
 * is on the counter, switch to offline billing; return to the counter once the
 * connection is back. Web clients have no bridge and stay where they are. */
export function useOfflineBillingAutoSwitch(online: boolean) {
  const navigate = useNavigate(),
    location = useLocation(),
    switched = useRef(false);
  useEffect(() => {
    if (!desktopOfflineBridge()) return;
    if (!online && location.pathname === '/') {
      switched.current = true;
      navigate('/offline-billing');
    } else if (online && switched.current && location.pathname === '/offline-billing') {
      switched.current = false;
      navigate('/');
    }
  }, [online, location.pathname, navigate]);
}
