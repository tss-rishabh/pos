import { useEffect, useState } from 'react';

const changed = 'pos-cashier-shortcut-preference-changed';
const keyFor = (operatorId: string) => `pos-letter-shortcuts:${operatorId}`;

function readPreference(operatorId: string) {
  try {
    return localStorage.getItem(keyFor(operatorId)) !== 'off';
  } catch {
    return true;
  }
}

/** Only the authenticated operator owns this preference; legacy unowned values
 * are deliberately not assigned to whichever person signs in next. */
export function useCashierShortcutPreference(operatorId: string) {
  const [state, setState] = useState(() => ({
    operatorId,
    enabled: readPreference(operatorId),
  }));
  const enabled = state.operatorId === operatorId ? state.enabled : readPreference(operatorId);

  useEffect(() => {
    setState({ operatorId, enabled: readPreference(operatorId) });
    const synchronize = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key === keyFor(operatorId) || event.key === null)
          setState({ operatorId, enabled: readPreference(operatorId) });
        return;
      }
      if (!(event instanceof CustomEvent)) return;
      const value: unknown = event.detail;
      if (
        typeof value === 'object' &&
        value !== null &&
        'operatorId' in value &&
        value.operatorId === operatorId &&
        'enabled' in value &&
        typeof value.enabled === 'boolean'
      )
        setState({ operatorId, enabled: value.enabled });
    };
    window.addEventListener('storage', synchronize);
    window.addEventListener(changed, synchronize);
    return () => {
      window.removeEventListener('storage', synchronize);
      window.removeEventListener(changed, synchronize);
    };
  }, [operatorId]);

  function setEnabled(value: boolean) {
    setState({ operatorId, enabled: value });
    try {
      localStorage.setItem(keyFor(operatorId), value ? 'on' : 'off');
    } catch {
      // The current view still honors the choice when browser storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(changed, { detail: { operatorId, enabled: value } }));
  }
  return [enabled, setEnabled] as const;
}
