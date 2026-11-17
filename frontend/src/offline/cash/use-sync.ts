import { useEffect } from 'react';
import type { Principal } from '../../api/types';
import { captureOperatorScope } from '../../api/client';
import { startOfflineCashRunner } from './runner';

/** enabled means online AND server-loaded store/counter selections are valid.
 * Neither a persisted selection nor an old principal can start recovery. */
export function useOfflineCashSync(
  user: Principal,
  storeId: string,
  counterId: string,
  enabled: boolean,
): void {
  const assignments = JSON.stringify([...user.storeIds].sort());
  useEffect(() => {
    if (!enabled || !storeId || !counterId) return;
    let runner: ReturnType<typeof startOfflineCashRunner> | undefined;
    const scope = new AbortController();
    try {
      runner = startOfflineCashRunner(user, storeId, counterId, {
        signal: AbortSignal.any([scope.signal, captureOperatorScope(user.id)]),
      });
    } catch {
      /* An uncommitted/stale operator cannot start background recovery. */
    }
    return () => {
      scope.abort();
      runner?.stop();
    };
  }, [user.id, user.role, user.userType, assignments, storeId, counterId, enabled]);
}
