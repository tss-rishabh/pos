import { describe, expect, it } from 'vitest';
import { positiveId, nonnegativeId } from '../../src/modules/order-history/contracts.js';

describe('order identifiers reject malformed input without coercion exceptions', () => {
  it.each(['1e3', '1.5', 'not-an-id', '0x10', '0b10', '', ' 1', '-1', '9'.repeat(10000)])(
    'returns a validation result for malformed string #%#',
    (value) => {
      expect(positiveId.safeParse(value).success).toBe(false);
      expect(nonnegativeId.safeParse(value).success).toBe(false);
    },
  );
  it('preserves exact signed 64-bit bounds and the separate zero contract', () => {
    const largest = '9223372036854775807';
    expect(positiveId.parse(largest)).toBe(largest);
    expect(nonnegativeId.parse(largest)).toBe(largest);
    expect(positiveId.safeParse('9223372036854775808').success).toBe(false);
    expect(nonnegativeId.safeParse('9223372036854775808').success).toBe(false);
    expect(positiveId.safeParse('0').success).toBe(false);
    expect(nonnegativeId.parse('0')).toBe('0');
  });
});
