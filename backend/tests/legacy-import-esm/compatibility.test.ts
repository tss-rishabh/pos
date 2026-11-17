import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/domain/errors.js';
import * as compatibility from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import {
  equalImportHash,
  importFinancialError,
} from '../../src/modules/legacy-order-imports/financial-adapter-primitives.js';
import { benefitDigest } from '../../src/modules/legacy-order-imports/benefit-profile/crypto.js';

describe('schema-free financial primitives compatibility', () => {
  it('retains the existing public helper exports and exact AppError contract', () => {
    expect(compatibility.equalImportHash).toBe(equalImportHash);
    expect(compatibility.importFinancialError).toBe(importFinancialError);
    const error = importFinancialError('ORDER_IMPORT_FIXTURE');
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      name: 'AppError',
      status: 409,
      code: 'ORDER_IMPORT_FIXTURE',
      message:
        'The original import needs review. Keep its operation reference; no new order or payment should be dispatched.',
    });
    expect(importFinancialError('ORDER_IMPORT_FIXTURE', 503).status).toBe(503);
  });
  it('preserves canonical64-hex validation before constant-time comparison', () => {
    expect(equalImportHash('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    for (const value of [
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'z'.repeat(64),
      '',
      ' ' + 'a'.repeat(64),
    ])
      expect(equalImportHash('a'.repeat(64), value)).toBe(false);
    expect(equalImportHash('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });
  it('retains golden key/financial/source/benefit HMAC bytes captured before extraction', () => {
    const key = 'synthetic-esm-compatibility-key-'.repeat(2),
      value = {
        refundable: '45.00',
        refundInputHash: 'a'.repeat(64),
        id: '9007199254740993',
        quantities: [2, 1],
      };
    expect(compatibility.financialImportKey(key, 'proof').toString('hex')).toBe(
      '7c344186c586d92de4325e589b865ccd8ffd7c010127b1632b4301802391f093',
    );
    expect(compatibility.financialImportHash(key, 'fixture', value)).toBe(
      'a45e2c6139d2c07f4bd6292999928d2bb5a49c7323a697b6b027c00cb9c17a00',
    );
    expect(compatibility.financialSourceHash(key, 'coupon-history', value)).toBe(
      '8cd82d3174b173d79520a2a04286d6ab2a8f5e101d384547b101a9862ca2b54b',
    );
    expect(benefitDigest('coupon', value, key)).toBe(
      'e6c252086bf29b42fe823b1d2c13e6e98462305aacca1e3c81caae06c969b52d',
    );
  });
});
