import { principalSchema } from '../../api/schemas';
import type { Principal } from '../../api/types';
import { db } from '../database';
import { offlineCashReadyEvent } from './events';
import { currentCashScope, replayOfflineCash, refreshOfflineCash } from './sync';
import { startOfflineCashOrderImports } from './order-import';

let cashFlight: Promise<void> = Promise.resolve();
function scopeKey(user: Principal, storeId: string, counterId: string) {
  return JSON.stringify([
    user.id,
    user.role,
    user.userType,
    [...user.storeIds].sort(),
    storeId,
    counterId,
  ]);
}
async function current(user: Principal, storeId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const saved = await db.sessions.get('current'),
    now = Date.now();
  signal.throwIfAborted();
  const parsed = principalSchema.safeParse(saved?.user);
  if (
    !saved ||
    !parsed.success ||
    !Number.isSafeInteger(saved.expiresAt) ||
    saved.expiresAt <= now ||
    !currentCashScope(parsed.data, user, storeId) ||
    localStorage.getItem('pos-pending-logout')
  )
    throw new Error('Sign in with a current session before synchronizing saved cash.');
}
/** One in-process pass at a time, including after a scope is aborted. Native
 * receipt claims retain cross-tab authority. Already collected cash is uploaded
 * independently of the original grant expiry; no new cash completion occurs. */
export function synchronizeOfflineCashScope(
  user: Principal,
  storeId: string,
  counterId: string,
  options: { signal: AbortSignal },
) {
  const actor = Object.freeze(principalSchema.parse(user));
  if (!/^[1-9]\d{0,19}$/.test(storeId) || !/^[1-9]\d{0,19}$/.test(counterId))
    return Promise.reject(
      new Error('Choose the current store and counter before synchronizing cash.'),
    );
  const execute = async () => {
    const { signal } = options;
    await current(actor, storeId, signal);
    await replayOfflineCash(actor, storeId, { signal, counterId });
    await current(actor, storeId, signal);
    await refreshOfflineCash(actor, storeId, { signal, counterId });
    await current(actor, storeId, signal);
    await startOfflineCashOrderImports(actor, storeId, { signal, counterId });
  };
  const pass = cashFlight.then(execute, execute);
  cashFlight = pass.catch(() => undefined);
  return pass;
}
interface SharedRunner {
  retain(signal: AbortSignal): () => void;
}
const runners = new Map<string, SharedRunner>();
/** Workspace and Counter share this single runner. Closing Counter releases its
 * reference without stopping the Workspace's reconnect recovery. */
export function startOfflineCashRunner(
  user: Principal,
  storeId: string,
  counterId: string,
  options: { signal: AbortSignal },
) {
  options.signal.throwIfAborted();
  const actor = Object.freeze(principalSchema.parse(user)),
    key = scopeKey(actor, storeId, counterId);
  let runner = runners.get(key);
  if (!runner) {
    const controller = new AbortController(),
      signal = controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined,
      pending: Promise<void> | null = null,
      references = 0,
      again = false,
      stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener(offlineCashReadyEvent, flush);
      window.removeEventListener('online', flush);
      runners.delete(key);
    };
    function flush() {
      if (stopped || signal.aborted || !navigator.onLine) return;
      if (pending) {
        again = true;
        return;
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = synchronizeOfflineCashScope(actor, storeId, counterId, { signal }).catch(() => {
        // Durable pending/conflict state is the recovery UI; no cash/payment
        // state is inferred from an unavailable background request.
      });
      void pending.finally(() => {
        pending = null;
        if (stopped || signal.aborted) return;
        if (again) {
          again = false;
          flush();
        } else timer = setTimeout(flush, 30000);
      });
    }
    runner = {
      retain(ownerSignal) {
        if (ownerSignal.aborted || stopped) return () => undefined;
        references++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          ownerSignal.removeEventListener('abort', release);
          references--;
          if (!references) stop();
        };
        ownerSignal.addEventListener('abort', release, { once: true });
        flush();
        return release;
      },
    };
    runners.set(key, runner);
    window.addEventListener(offlineCashReadyEvent, flush);
    window.addEventListener('online', flush);
  }
  return { stop: runner.retain(options.signal) };
}
