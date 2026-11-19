import { describe, expect, it } from 'vitest';
import { readSettingsOptions } from '../../src/modules/administration/settings-options.js';

// W26: the legacy UAT env sets ECOM_DELIVERY_CHANGES_TIME=7200; a 3600 cap stopped API start-up.
describe('settings options: ECOM_DELIVERY_CHANGES_TIME', () => {
  it.each([
    [undefined, 180],
    ['180', 180],
    ['3600', 3600],
    ['7200', 7200],
    ['2592000', 2592000],
  ])('%j -> %d seconds', (raw, expected) => {
    expect(
      readSettingsOptions(raw === undefined ? {} : { ECOM_DELIVERY_CHANGES_TIME: raw })
        .ECOM_DELIVERY_CHANGES_TIME,
    ).toBe(expected);
  });
  it.each(['0', '-5', '2592001', 'abc'])('refuses %j', (raw) => {
    expect(() => readSettingsOptions({ ECOM_DELIVERY_CHANGES_TIME: raw })).toThrow();
  });
});

describe('settings service accepts the same cooldown range', () => {
  it('builds with a 7200-second cooldown and refuses one above 30 days', async () => {
    const { settingsService } = await import('../../src/modules/administration/settings.js');
    const config = { BUSINESS_TIMEZONE: 'Asia/Kolkata' } as Parameters<typeof settingsService>[0];
    const db = {} as Parameters<typeof settingsService>[1];
    expect(() => settingsService(config, db, { ecommerceCooldownSeconds: 7200 })).not.toThrow();
    expect(() => settingsService(config, db, { ecommerceCooldownSeconds: 2_592_001 })).toThrow();
  });
});
