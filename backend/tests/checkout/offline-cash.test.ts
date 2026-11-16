import { generateKeyPairSync, sign } from 'node:crypto';
import { offlineCashFixture as fixture } from './offline-cash-fixtures.js';
import { describe, expect, it } from 'vitest';
import { canonicalCashJson } from '../../src/modules/checkout/offline-cash/canonical.js';
import {
  offlineCashSigner,
  verifyDeviceCashReceipt,
} from '../../src/modules/checkout/offline-cash/crypto.js';
import { assertCashReceipt, cashLines } from '../../src/modules/checkout/offline-cash/domain.js';
import {
  devicePublicKeySchema,
  type CashReceipt,
} from '../../src/modules/checkout/offline-cash/contracts.js';

describe('offline cash immutable pricing and signatures', () => {
  it('uses exact source quantity prices and source rupee-flooring, preserving precise identifiers', () => {
    const { authorization, snapshot, receipt } = fixture();
    expect(receipt.taxCents).toBe(1905);
    expect(receipt.lines[0]!.taxCents).not.toBe(snapshot.products[0]!.quantities[0]!.taxCents * 2);
    expect(receipt.payableCents).toBe(39900);
    expect(receipt.roundingCents).toBe(98);
    expect(assertCashReceipt(authorization, snapshot, receipt)).toEqual([]);
    expect(cashLines(snapshot, receipt.lines)[0]!.productId).toBe('9007199254740993');
  });
  it('rejects mutated amounts, quantity, sequence, price snapshot, date and account scope', () => {
    const { authorization, snapshot, receipt } = fixture();
    const changes: Partial<CashReceipt>[] = [
      { changeCents: 0 },
      { payableCents: 39901 },
      { sequence: 101 },
      { receiptNumber: 'OC-0123456789ABCDEF-0002' },
      { operatorId: '45' },
      { storeId: '3' },
      { businessDate: '2026-11-17' },
      { snapshotHash: '0'.repeat(64) },
      { lines: [{ ...receipt.lines[0]!, quantity: 3 }] },
      { lines: [{ ...receipt.lines[0]!, name: 'Changed name' }] },
    ];
    for (const change of changes)
      expect(() => assertCashReceipt(authorization, snapshot, { ...receipt, ...change })).toThrow();
    expect(() =>
      assertCashReceipt(
        authorization,
        { ...snapshot, products: [{ ...snapshot.products[0]!, cachedStock: 99 }] },
        receipt,
      ),
    ).toThrow();
  });
  it('retains valid immutable money evidence while marking an invalid device clock for manager review', () => {
    const { authorization, snapshot, receipt } = fixture();
    expect(
      assertCashReceipt(authorization, snapshot, {
        ...receipt,
        completedAt: authorization.expiresAt + 1,
      }),
    ).toEqual(['clock-outside-authorization', 'price-snapshot-expired']);
    expect(receipt.payableCents).toBe(receipt.cashReceivedCents - receipt.changeCents);
  });
  it('separates server authorization from device receipt signatures and rejects forged evidence', () => {
    const { authorization, receipt } = fixture(),
      server = generateKeyPairSync('ed25519'),
      device = generateKeyPairSync('ed25519');
    const signer = offlineCashSigner(
        server.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ),
      envelope = signer.authorize(authorization),
      publicKey = devicePublicKeySchema.parse(device.publicKey.export({ format: 'jwk' }));
    expect(signer.verify(envelope)).toBe(true);
    expect(
      signer.verify({ ...envelope, authorization: { ...authorization, operatorId: '2' } }),
    ).toBe(false);
    const signedReceipt = {
      receipt,
      signature: sign(null, Buffer.from(canonicalCashJson(receipt)), device.privateKey).toString(
        'base64url',
      ),
    };
    expect(verifyDeviceCashReceipt(publicKey, signedReceipt)).toBe(true);
    expect(verifyDeviceCashReceipt(signer.publicKey, signedReceipt)).toBe(false);
    expect(
      verifyDeviceCashReceipt(publicKey, {
        ...signedReceipt,
        receipt: { ...receipt, cashReceivedCents: 100000 },
      }),
    ).toBe(false);
    expect(() => offlineCashSigner('not-a-key')).toThrow('not configured');
  });
  it('canonicalizes only explicit integer/string JSON and excludes runtime/private values', () => {
    expect(canonicalCashJson({ b: 'x', a: [1, null] })).toBe('{"a":[1,null],"b":"x"}');
    for (const value of [1.1, Number.NaN, BigInt(1), undefined, new Date(), { key: undefined }])
      expect(() => canonicalCashJson(value)).toThrow();
  });
});
