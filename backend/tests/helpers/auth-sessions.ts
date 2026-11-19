import type { Config } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import { activeAccountReader, redisSessions } from '../../src/auth/sessions.js';
import { memoryRedisPort } from './memory-redis.js';

/**
 * One in-process auth Redis per test module. Pass it to `buildApp(config, { authRedis })`
 * so sessions created here are the ones the app validates against MySQL `pos_user`.
 */
export const testAuthRedis = memoryRedisPort();
export function testSessions(
  config: Pick<Config, 'SESSION_SECRET' | 'BUSINESS_TIMEZONE'>,
  db: Databases,
) {
  return redisSessions(config, activeAccountReader(db), testAuthRedis);
}
