import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import {
  bufferSeconds,
  orderBufferInput,
  thresholdInput,
  type SettingsEffect,
} from '../../src/modules/administration/settings-domain.js';
import {
  createSettingsDelivery,
  settingsNotice,
} from '../../src/modules/administration/settings-adapters.js';
import { readSettingsOptions } from '../../src/modules/administration/settings-options.js';
import { goldenStdout } from '../golden/load.js';

const oracle = <T>(operation: string, cases: unknown[]): T[] =>
  JSON.parse(
    goldenStdout('administration', 'settings', JSON.stringify({ operation, cases })),
  ) as T[];
describe('delivery settings source contracts', () => {
  it('preserves source hours:minutes arithmetic, including durations beyond one day', () => {
    const values = ['00:01', '01:30', '72:15', '999:59'];
    expect(values.map(bufferSeconds)).toEqual(
      oracle<number>(
        'order-buffer',
        values.map((value) => ({ value })),
      ),
    );
    const context = { operationId: randomUUID(), expectedVersion: 'a'.repeat(64) };
    expect(orderBufferInput.safeParse({ ...context, value: '00:00' }).success).toBe(false);
    expect(orderBufferInput.safeParse({ ...context, value: '12:99' }).success).toBe(false);
    expect(thresholdInput.safeParse({ ...context, value: 0 }).success).toBe(true);
    expect(thresholdInput.safeParse({ ...context, value: -1 }).success).toBe(false);
  });
  it('matches source timing, availability, buffer and ecommerce notice messages', () => {
    const base = { actorId: '1', requestId: null, occurredAt: '2026-11-16 00:00:00.000' };
    const effects: SettingsEffect[] = [
      { ...base, kind: 'buffer.notice', value: '01:30' },
      {
        ...base,
        kind: 'slot.timing.notice',
        storeId: '1',
        weekday: 'MON',
        previous: '09:00 - 22:00',
        current: '10:00 - 23:00',
      },
      { ...base, kind: 'slot.availability.notice', storeId: '1', weekday: null, active: false },
      { ...base, kind: 'slot.availability.notice', storeId: '1', weekday: 'MON', active: true },
      { ...base, kind: 'ecommerce.threshold.notice', storeId: '1', previous: 2, current: 4 },
      { ...base, kind: 'ecommerce.availability.notice', storeId: '1', active: true },
    ];
    const cases = effects.map((effect) => ({
      kind: effect.kind,
      firstName: 'Fixture',
      lastName: 'Person',
      variables: {
        today: '16 Nov 2026 05:30:00',
        red_flag: '🔺',
        store_name: 'Fixture Store',
        e_value: '01:30',
        weekday: 'MON',
        prev_value: '09:00 - 22:00',
        current_value: '10:00 - 23:00',
        which_slot:
          effect.kind === 'slot.availability.notice' && effect.weekday === null
            ? 'All slots'
            : 'MON slot',
        status: effect.kind === 'slot.availability.notice' && !effect.active ? 'Closed' : 'Open',
        prev: 2,
        value: 4,
      },
    }));
    expect(
      effects.map((effect) =>
        settingsNotice(effect, 'Fixture Person', 'Fixture Store', 'Asia/Kolkata'),
      ),
    ).toEqual(oracle<string>('settings-notice', cases));
    expect(settingsNotice(effects[1]!, '<@operator>', '<!channel>', 'Asia/Kolkata')).toContain(
      '&lt;!channel&gt;',
    );
  });
  it('uses the distinct common cache and validates webhook scope', async () => {
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'fixture-settings-secret-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_settings_unit',
    });
    const db = createDatabases(config),
      calls: [string, string][] = [];
    const delivery = createSettingsDelivery(config, db, readSettingsOptions({}), {
      cache: {
        async set(key, value) {
          calls.push([key, value]);
        },
        async close() {},
      },
    });
    await delivery.deliver({
      kind: 'setting.cache',
      key: 'HYPERLOCAL_STOCK_THRESHOLD',
      value: 0,
      actorId: '1',
      requestId: null,
      occurredAt: '2026-11-16 00:00:00.000',
    });
    expect(calls).toEqual([['HYPERLOCAL_STOCK_THRESHOLD', '0']]);
    expect(delivery.supports('buffer.notice')).toBe(false);
    expect(() =>
      createSettingsDelivery(
        config,
        db,
        readSettingsOptions({ SLACK_URL: 'https://internal.example.test/services/private' }),
      ),
    ).toThrow();
    const production = { ...config, NODE_ENV: 'production' as const };
    expect(() =>
      createSettingsDelivery(
        production,
        db,
        readSettingsOptions({ COMMON_REDIS_URL: 'redis://127.0.0.1:6379' }),
      ),
    ).toThrow();
    await delivery.close?.();
    await db.close();
  });
});
