import { describe, expect, it } from 'vitest';
import {
  MAX_REFERENCE_LENGTH,
  deviceShortCode,
  parseProvisionalReference,
  provisionalReference,
} from '../../src/offline/billing/reference';
import { formatMoney, parseMoney, saleTotals } from '../../src/offline/billing/money';

describe('provisional reference', () => {
  it('formats OFF-<storeId>-<counterId>-<deviceShort>-<seq>', () => {
    expect(
      provisionalReference({ storeId: '12', counterId: '3', deviceShort: 'A1B2C3D4', sequence: 7 }),
    ).toBe('OFF-12-3-A1B2C3D4-7');
  });
  it('round-trips through the parser', () => {
    const value = provisionalReference({
      storeId: '4021',
      counterId: '88',
      deviceShort: 'FFFF0000',
      sequence: 123456,
    });
    expect(parseProvisionalReference(value)).toEqual({
      storeId: '4021',
      counterId: '88',
      deviceShort: 'FFFF0000',
      sequence: 123456,
    });
  });
  it('never exceeds the 55-character order_ref_no budget', () => {
    const longest = provisionalReference({
      storeId: '9999999999',
      counterId: '9999999999',
      deviceShort: 'ZZZZZZZZ',
      sequence: 999_999_999,
    });
    expect(longest.length).toBeLessThanOrEqual(MAX_REFERENCE_LENGTH);
    expect(() =>
      provisionalReference({
        storeId: '1'.repeat(20),
        counterId: '1'.repeat(20),
        deviceShort: 'AAAAAAAA',
        sequence: 1,
      }),
    ).toThrow(RangeError);
  });
  it('rejects malformed parts', () => {
    const base = { storeId: '1', counterId: '2', deviceShort: 'ABCDEF12', sequence: 1 };
    expect(() => provisionalReference({ ...base, storeId: '0' })).toThrow();
    expect(() => provisionalReference({ ...base, counterId: '2a' })).toThrow();
    expect(() => provisionalReference({ ...base, deviceShort: 'abcdef12' })).toThrow();
    expect(() => provisionalReference({ ...base, sequence: 0 })).toThrow();
    expect(() => provisionalReference({ ...base, sequence: 1.5 })).toThrow();
    expect(parseProvisionalReference('OFF-1-2-ABCDEF12-0')).toBeNull();
    expect(parseProvisionalReference('OFF-1-2-ABCDEF12-1 ')).toBeNull();
    expect(parseProvisionalReference('INV-1-2-ABCDEF12-1')).toBeNull();
  });
  it('derives the device short code from the random device id', () => {
    expect(deviceShortCode('0123456789abcdef0123456789abcdef')).toBe('01234567');
    expect(() => deviceShortCode('xyz')).toThrow();
  });
});

describe('exact money', () => {
  it('parses decimal strings into integer paise', () => {
    expect(parseMoney('499')).toBe(49900);
    expect(parseMoney('499.5')).toBe(49950);
    expect(parseMoney('499.000')).toBe(49900);
    expect(parseMoney('0.1')).toBe(10);
    expect(parseMoney('499.005')).toBeNull();
    expect(parseMoney('-1')).toBeNull();
    expect(parseMoney('1e3')).toBeNull();
    expect(formatMoney(49950)).toBe('499.50');
  });
  it('floors the payable to whole rupees like the legacy calculator', () => {
    expect(
      saleTotals([
        { unitPricePaise: 49950, quantity: 2 },
        { unitPricePaise: 1999, quantity: 1 },
      ]),
    ).toEqual({ grossPaise: 101899, roundingPaise: 99, payablePaise: 101800 });
  });
});
