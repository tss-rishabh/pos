import { describe, expect, it } from 'vitest';
import {
  legacyEmailPattern,
  updateEmailInput,
  updateTelephoneInput,
} from '../../src/modules/customer-contacts/contracts.js';

/** Legacy create_order.html:7952, evaluated as the browser did. */
const legacy = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
describe('legacy contact input rules', () => {
  it('accepts exactly the legacy 10-digit mobile', () => {
    expect(updateTelephoneInput.safeParse({ phoneNumber: '9876543210' }).success).toBe(true);
    for (const value of ['987654321', '98765432100', '+919876543210', '98765 43210'])
      expect(updateTelephoneInput.safeParse({ phoneNumber: value }).success).toBe(false);
  });
  it('matches the legacy email expression on representative inputs without backtracking blow-up', () => {
    for (const value of [
      'a@b.co',
      'first.last@example.com',
      'first-last@sub.example.in',
      'a_b@c-d.org',
      'a..b@c.com',
      'a@b',
      'a@b.c',
      'a@b.comm',
      '@b.com',
      'a b@c.com',
      'a.@b.com',
      'a@b..com',
    ])
      expect([value, legacyEmailPattern.test(value)]).toEqual([value, legacy.test(value)]);
    const started = performance.now();
    legacyEmailPattern.test('a'.repeat(90) + '!');
    expect(performance.now() - started).toBeLessThan(100);
    expect(updateEmailInput.safeParse({ email: 'x'.repeat(97) }).success).toBe(false);
  });
});
