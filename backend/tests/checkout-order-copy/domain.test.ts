import { describe, it, expect } from 'vitest';
import {
  assertCopiedStep,
  copyManifest,
  copySteps,
  draftOriginHash,
} from '../../src/modules/checkout/order-copy/domain.js';
import { copyFactsSchema } from '../../src/modules/checkout/order-copy/contracts.js';

const facts = copyFactsSchema.parse({
  orderId: '9007199254740993',
  sourceCustomerId: '9',
  sourceStoreId: '1',
  createdAt: '2026-11-17 10:00:00',
  reader: 'bigquery',
  fetchedAt: '2026-11-17T10:00:00Z',
  generationId: 'fixture',
  complete: true,
  lines: [
    { lineId: '9007199254740994', productId: '10' },
    { lineId: '9007199254740995', productId: '10' },
    { lineId: '9007199254740996', productId: '11' },
  ],
});
describe('order copy manifest protocol', () => {
  it('adds one unit per HP identity and retains long IDs and duplicate SKUs', () => {
    const before = copyManifest({
      products: { items: [{ prod_id: 10, quantity: 3, price: 100 }] },
    });
    const steps = copySteps(facts, before);
    expect(
      steps.map((row) => ({
        productId: row.productId,
        target: row.targetQuantity,
        source: row.sourceLineIds,
      })),
    ).toEqual([
      { productId: '10', target: 5, source: ['9007199254740994', '9007199254740995'] },
      { productId: '11', target: 1, source: ['9007199254740996'] },
    ]);
  });
  it('rejects duplicate HP identities, unsafe numbers and quantity overflow', () => {
    expect(() =>
      copyFactsSchema.parse({ ...facts, lines: [facts.lines[0], facts.lines[0]] }),
    ).toThrow();
    expect(() =>
      copyManifest({ products: { items: [{ prod_id: 9007199254740992, quantity: 1 }] } }),
    ).toThrow();
    expect(() =>
      copyManifest({ products: { items: [{ prod_id: 10, quantity: true }] } }),
    ).toThrow();
    expect(() =>
      copySteps(facts, copyManifest({ products: { items: [{ prod_id: 10, quantity: 999 }] } })),
    ).toThrow();
  });
  it('checks the full postcondition and preserves earlier gift-card instances', () => {
    const before = {
      products: { items: [{ prod_id: 10, quantity: 1 }] },
      giftvouchers: {
        items: [{ prod_id: 80, gv_id: '9007199254740993', quantity: 1, price: 500 }],
      },
    };
    expect(() =>
      assertCopiedStep(
        before,
        { ...before, products: { items: [{ prod_id: 10, quantity: 3 }] } },
        '10',
        3,
      ),
    ).not.toThrow();
    expect(() =>
      assertCopiedStep(
        before,
        {
          ...before,
          products: {
            items: [
              { prod_id: 10, quantity: 3 },
              { prod_id: 11, quantity: 1 },
            ],
          },
        },
        '10',
        3,
      ),
    ).toThrow();
    expect(() =>
      assertCopiedStep(
        before,
        {
          ...before,
          products: { items: [{ prod_id: 10, quantity: 3 }] },
          giftvouchers: { items: [{ prod_id: 80, gv_id: '9007199254740994', quantity: 1 }] },
        },
        '10',
        3,
      ),
    ).toThrow();
  });
  it('requires a complete immutable draft manifest before origin binding', () => {
    const original = {
        draftId: '11111111-1111-4111-8111-111111111111',
        draftVersion: 42,
        draftImport: {
          lineItems: [{ productId: '10', quantity: 2 }],
          completedProductIds: ['10'],
          status: 'complete' as const,
        },
      },
      secret = 'fixture-secret-'.repeat(4);
    const before = draftOriginHash(original, secret);
    expect(draftOriginHash(structuredClone(original), secret)).toBe(before);
    expect(draftOriginHash({ ...original, draftVersion: 43 }, secret)).not.toBe(before);
    expect(() =>
      draftOriginHash(
        { ...original, draftImport: { ...original.draftImport, status: 'pending' } },
        secret,
      ),
    ).toThrow();
  });
});
