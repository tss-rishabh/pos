import { describe, expect, it } from 'vitest';
import { financeAlertOptions } from '../../src/modules/finance/alerts.js';

// Legacy settings.py:515 reads COMMON_GROUP_ALERT_ON with int(env, 0). Deployed legacy env files
// carry "1"/"0"; the backend must start with them (W26: UAT env "1" stopped API start-up).
describe('finance alert options: COMMON_GROUP_ALERT_ON', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['1', true],
    ['2', true],
    ['-1', true],
    ['true', true],
    ['false', false],
  ])('%j -> %s', (raw, expected) => {
    const env: NodeJS.ProcessEnv = raw === undefined ? {} : { COMMON_GROUP_ALERT_ON: raw };
    expect(financeAlertOptions(env).COMMON_GROUP_ALERT_ON).toBe(expected);
  });
  it('still refuses a non-integer, non-boolean value', () => {
    expect(() => financeAlertOptions({ COMMON_GROUP_ALERT_ON: 'yes' })).toThrow();
  });
});
