import { describe, expect, it } from 'vitest';
import { barcodeInteger } from '../../../src/modules/administration/barcodes/domain.js';
describe('source masked barcode integer normalization', () => {
  it('keeps exact large integers and source masked/leading-zero behavior without inventing a checksum restriction', () => {
    for (const [input, result] of [
      ['__000_123__', '123'],
      [' +00012 ', '12'],
      ['_ +0_0_12__ ', '12'],
      ['9007199254740993', '9007199254740993'],
      ['9223372036854775807', '9223372036854775807'],
      ['7', '7'],
    ])
      expect(barcodeInteger.parse(input)).toBe(result);
  });
  it('rejects missing/sentinel, negative, fractional, exponent and out-of-physical-range input before writes', () => {
    for (const value of [
      '',
      '_',
      '0',
      '000',
      '-1',
      '1.2',
      '1e3',
      'x',
      '9223372036854775808',
      '1'.repeat(65),
    ])
      expect(barcodeInteger.safeParse(value).success).toBe(false);
  });
});
