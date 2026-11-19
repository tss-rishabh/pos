import { describe, it, expect } from 'vitest';
import { cartCopyHash, copyManifest } from '../../src/modules/checkout/order-copy/domain.js';

describe('order copy cart manifest', () => {
  it('rejects unsafe numbers and invalid quantities', () => {
    expect(() =>
      copyManifest({ products: { items: [{ prod_id: 9007199254740992, quantity: 1 }] } }),
    ).toThrow();
    expect(() =>
      copyManifest({ products: { items: [{ prod_id: 10, quantity: true }] } }),
    ).toThrow();
  });
  it('keeps gift-card instances apart and hashes metadata with the lines', () => {
    const cart = {
      products: { items: [{ prod_id: 10, quantity: 2, price: 100 }] },
      giftvouchers: {
        items: [
          { prod_id: 80, gv_id: '9007199254740993', quantity: 1, price: 500 },
          { prod_id: 80, gv_id: '9007199254740994', quantity: 1, price: 500 },
        ],
      },
    };
    expect(copyManifest(cart).map((line) => [line.kind, line.productId, line.identity])).toEqual([
      ['gift-card', '80', '9007199254740993'],
      ['gift-card', '80', '9007199254740994'],
      ['product', '10', null],
    ]);
    const secret = 'order-copy-secret-'.repeat(3);
    expect(cartCopyHash(cart, secret)).toBe(cartCopyHash(structuredClone(cart), secret));
    expect(cartCopyHash({ ...cart, meta: { coupon: 'X' } }, secret)).not.toBe(
      cartCopyHash(cart, secret),
    );
  });
});
