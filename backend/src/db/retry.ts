import { setTimeout } from 'node:timers/promises';

export async function retryTransaction<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const cause =
        typeof error === 'object' && error !== null && 'cause' in error ? error.cause : error;
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
      if (attempt >= 2 || !['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(String(code)))
        throw error;
      // Safe for DB-only transactions. Never retry an external payment here.
      await setTimeout(20 * (attempt + 1) + Math.floor(Math.random() * 15));
    }
  }
}
