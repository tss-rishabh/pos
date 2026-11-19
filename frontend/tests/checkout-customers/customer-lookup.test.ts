import { describe, expect, it } from 'vitest';
import {
  cashbackText,
  customerLookupResultSchema,
  exclusiveText,
} from '../../src/pages/checkout/CustomerLookup';

/** Legacy `create_order.html:2931-2948` wording for the fetched customer. */
const result = customerLookupResultSchema.parse({
  customer: {
    id: '42',
    name: 'Fixture Customer',
    telephone: '9876500001',
    email: 'fixture@example.com',
    customerType: 'B2C',
    gstin: '',
  },
  message: 'User Found',
  exclusive: { member: true, expiry: '2027-03-05T00:00:00', message: '' },
  discountEligible: true,
});
describe('customer lookup display', () => {
  it('uses the legacy exclusive and cashback texts', () => {
    expect(exclusiveText(result)).toBe('Exclusive User Till  March 5, 2027');
    expect(cashbackText(result)).toBe('User Is Eligible For Cashback');
    const other = {
      ...result,
      exclusive: { member: false, expiry: null, message: "User's Membership is deactivated." },
      discountEligible: false,
    };
    expect(exclusiveText(other)).toBe('Non Exclusive User');
    expect(cashbackText(other)).toBe('User is not eligible for cashback');
  });
});
