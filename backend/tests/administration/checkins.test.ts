import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { loginCheckIns, type CheckInStoreDirectory } from '../../src/auth/checkin.js';
import { checkInSeconds, parseCheckInValue } from '../../src/modules/administration/checkins.js';
import { memoryRedisPort } from '../../src/redis/memory.js';

/** Store names by id; every store is eligible (eligibility is covered by the auth tests). */
const directory = (names: Record<string, string>): CheckInStoreDirectory => ({
  eligible: async () => true,
  name: async (storeId) => names[storeId] ?? '',
});

describe('legacy Redis check-in keys (helpers/helpers.py:794-824, :1235-1240)', () => {
  it('writes check_in_{uid} as Python json.dumps text with the end-of-day TTL', async () => {
    const port = memoryRedisPort();
    await loginCheckIns(directory({ '12': 'Bandra Café' }), port).record('7', '12', 100);
    expect(await port.get('check_in_7')).toBe('[12, "Bandra Caf\\u00e9"]');
    expect(await port.pTtl('check_in_7')).toBeGreaterThan(99_000);
    expect(await port.lRange('check_in_list_12', 0, -1)).toEqual(['7']);
    expect(await port.pTtl('check_in_list_12')).toBeGreaterThan(99_000);
    expect(parseCheckInValue(await port.get('check_in_7'))).toBe('12');
    expect(await port.exists('pos:checkin_counter:7')).toBe(false);
  });
  it('moves the operator between store lists and treats store 0 as checked out', async () => {
    const port = memoryRedisPort(),
      checkIns = loginCheckIns(directory({ '12': 'A', '13': 'B' }), port);
    await checkIns.record('7', '12', 50);
    await checkIns.record('8', '12', 50);
    await checkIns.record('7', '13', 50);
    expect(await port.lRange('check_in_list_12', 0, -1)).toEqual(['8']);
    expect(await port.lRange('check_in_list_13', 0, -1)).toEqual(['7']);
    await checkIns.record('7', '0', 50);
    expect(await port.get('check_in_7')).toBe('[0, ""]');
    expect(parseCheckInValue(await port.get('check_in_7'))).toBeNull();
    expect(await port.lRange('check_in_list_13', 0, -1)).toEqual([]);
  });
  it('reads values written by the legacy app and ignores malformed ones', () => {
    expect(parseCheckInValue('[44, "Legacy store"]')).toBe('44');
    expect(parseCheckInValue('not json')).toBeNull();
    expect(parseCheckInValue(null)).toBeNull();
  });
  it('computes time_until_end_of_day() - 1 in the business time zone', () => {
    const at = (local: string) =>
      Temporal.PlainDateTime.from(local).toZonedDateTime('Asia/Kolkata').toInstant();
    expect(checkInSeconds(at('2026-11-16T23:59:00'))).toBe(59);
    expect(checkInSeconds(at('2026-11-16T00:00:00'))).toBe(86399);
  });
});
