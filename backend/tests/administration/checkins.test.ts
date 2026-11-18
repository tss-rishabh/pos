import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import {
  checkInCounterKey,
  checkInSeconds,
  legacyCheckedInUsers,
  readLegacyCheckIn,
  writeLegacyCheckIn,
} from '../../src/modules/administration/checkins.js';

describe('legacy Redis check-in keys (helpers/helpers.py:794-824, :1235-1240)', () => {
  it('writes check_in_{uid} as Python json.dumps text with the end-of-day TTL', async () => {
    const store = memoryEphemeralStore();
    await writeLegacyCheckIn(store, '7', '12', 'Bandra Café', 100);
    expect(await store.get('check_in_7')).toBe('[12, "Bandra Caf\\u00e9"]');
    expect(await store.ttl('check_in_7')).toBe(100);
    expect(await store.lRange('check_in_list_12', 0, -1)).toEqual(['7']);
    expect(await store.ttl('check_in_list_12')).toBe(100);
    expect(await readLegacyCheckIn(store, '7')).toEqual({
      storeId: '12',
      storeName: 'Bandra Café',
      ttlSeconds: 100,
    });
  });
  it('moves the operator between store lists and treats store 0 as checked out', async () => {
    const store = memoryEphemeralStore();
    await writeLegacyCheckIn(store, '7', '12', 'A', 50, '3');
    await writeLegacyCheckIn(store, '8', '12', 'A', 50);
    expect(await store.get(checkInCounterKey('7'))).toBe('3');
    await writeLegacyCheckIn(store, '7', '13', 'B', 50);
    expect(await legacyCheckedInUsers(store, '12')).toEqual(['8']);
    expect(await legacyCheckedInUsers(store, '13')).toEqual(['7']);
    expect(await store.get(checkInCounterKey('7'))).toBeNull();
    await writeLegacyCheckIn(store, '7', '0', '', 50);
    expect(await store.get('check_in_7')).toBe('[0, ""]');
    expect(await readLegacyCheckIn(store, '7')).toBeNull();
    expect(await legacyCheckedInUsers(store, '13')).toEqual([]);
    expect(await legacyCheckedInUsers(store, '0')).toEqual([]);
  });
  it('reads values written by the legacy app and ignores malformed ones', async () => {
    const store = memoryEphemeralStore();
    await store.set('check_in_9', '[44, "Legacy store"]', { EX: 30 });
    expect((await readLegacyCheckIn(store, '9'))?.storeId).toBe('44');
    await store.set('check_in_9', 'not json', { EX: 30 });
    expect(await readLegacyCheckIn(store, '9')).toBeNull();
  });
  it('computes time_until_end_of_day() - 1 in the business time zone', () => {
    const at = (local: string) =>
      Temporal.PlainDateTime.from(local).toZonedDateTime('Asia/Kolkata').toInstant();
    expect(checkInSeconds(at('2026-11-16T23:59:00'))).toBe(59);
    expect(checkInSeconds(at('2026-11-16T00:00:00'))).toBe(86399);
  });
});
