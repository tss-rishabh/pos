import { describe, expect, it } from 'vitest';
import { cashierShortcutKey } from '../../src/pages/cashier-shortcuts/shortcuts';
import { displayedMembershipBenefits } from '../../src/pages/cashier-shortcuts/membership';

const event = (key: string) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  repeat: false,
  defaultPrevented: false,
});
describe('cashier keyboard boundaries', () => {
  it('maps the original R/P/F/N/E/B/S/T keys in either case', () => {
    const expected = {
      r: 'refresh',
      p: 'proceed',
      f: 'fast-cash',
      n: 'toggle-nps',
      e: 'toggle-exclusive',
      b: 'barcode',
      s: 'salesperson',
      t: 'new-sale',
    };
    for (const [key, action] of Object.entries(expected)) {
      expect(cashierShortcutKey(event(key))).toBe(action);
      expect(cashierShortcutKey(event(key.toUpperCase()))).toBe(action);
    }
  });
  it.each(['altKey', 'ctrlKey', 'metaKey', 'isComposing', 'repeat', 'defaultPrevented'] as const)(
    'does not intercept %s events',
    (flag) => {
      expect(cashierShortcutKey({ ...event('p'), [flag]: true })).toBeNull();
    },
  );
  it('does not turn browser keys or object-prototype property names into actions', () => {
    for (const key of [
      'Enter',
      'Escape',
      'Tab',
      'Shift',
      'constructor',
      '__proto__',
      'toString',
      'pp',
      '💳',
    ])
      expect(cashierShortcutKey(event(key))).toBeNull();
  });
});
describe('native cart membership display', () => {
  const cart = (items: unknown[]) => ({ meta: { items } });
  it('uses the source exclusive_user active boolean and treats a missing entry as unchecked', () => {
    expect(displayedMembershipBenefits(cart([{ name: 'exclusive_user', active: true }]))).toBe(
      true,
    );
    expect(displayedMembershipBenefits(cart([{ name: 'exclusive_user', active: false }]))).toBe(
      false,
    );
    expect(displayedMembershipBenefits(cart([{ name: 'calculations', total: 20 }]))).toBe(false);
  });
  it('refuses ambiguous, malformed and unproved metadata rather than guessing eligibility', () => {
    for (const input of [
      null,
      {},
      cart([{ name: 'exclusive_user', active: 'true' }]),
      cart([{ name: 'exclusive_user', active: 1 }]),
      cart([
        { name: 'exclusive_user', active: true },
        { name: 'exclusive_user', active: false },
      ]),
    ])
      expect(displayedMembershipBenefits(input)).toBeNull();
  });
});
