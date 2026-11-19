import { describe, expect, it } from 'vitest';
import { storedEnumValue } from '../../src/db/legacy-columns.js';
import { hasProductStatuses } from '../../src/db/legacy-enums.js';

// MySQL ENUM assignment under the legacy _ci / PAD SPACE collations (W26: legacy writes the
// order_status name 'Delivered' into has_products.status, which MySQL stores as 'DELIVERED').
describe('storedEnumValue follows MySQL ENUM matching', () => {
  it.each([
    ['DELIVERED', 'DELIVERED'],
    ['Delivered', 'DELIVERED'],
    ['delivered', 'DELIVERED'],
    ['Delivered  ', 'DELIVERED'],
    ['Cancelled', 'CANCELLED'],
    ['Order Placed', ''],
    ['', ''],
    [' DELIVERED', ''],
  ])('%j -> %j', (input, stored) => {
    expect(storedEnumValue(hasProductStatuses, input)).toBe(stored);
  });
});
