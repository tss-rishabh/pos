import { describe, expect, it } from 'vitest';
import { displayedMembershipBenefits } from '../../src/pages/checkout/membership';

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
