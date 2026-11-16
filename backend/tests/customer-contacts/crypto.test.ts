import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openContact, sealContact } from '../../src/modules/customer-contacts/crypto.js';

describe('bounded purpose-bound contact storage encryption', () => {
  const key = 'synthetic-purpose-specific-contact-key-'.repeat(2);
  it('round-trips a full1000-refund obligation beyond the cookie8KiB bound without plaintext contact/code storage', () => {
    const id = randomUUID(),
      value = {
        email: 'fixture@example.test',
        code: '123456',
        refundRemails: Array.from({ length: 1000 }, (_, index) => ({
          orderId: String(index + 1),
          refundRequestId: String(index + 2000),
        })),
      };
    const sealed = sealContact(key, id, value);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(8192);
    expect(sealed).not.toContain(value.email);
    expect(sealed).not.toContain(value.code);
    expect(
      openContact(
        key,
        id,
        sealed,
        z.object({
          email: z.string(),
          code: z.string(),
          refundRemails: z.array(z.object({ orderId: z.string(), refundRequestId: z.string() })),
        }),
      ),
    ).toEqual(value);
  });
  it('rejects a swapped owner, wrong key, authentication-tag mutation and oversized ciphertext', () => {
    const id = randomUUID(),
      sealed = sealContact(key, id, { purpose: 'synthetic' }),
      schema = z.object({ purpose: z.literal('synthetic') });
    expect(() => openContact(key, randomUUID(), sealed, schema)).toThrow();
    expect(() => openContact(key + 'changed', id, sealed, schema)).toThrow();
    const bytes = Buffer.from(sealed, 'base64url');
    bytes[20] = bytes[20]! ^ 1;
    expect(() => openContact(key, id, bytes.toString('base64url'), schema)).toThrow();
    expect(() => sealContact(key, id, { value: 'x'.repeat(256000) })).toThrow();
    expect(() => openContact(key, id, 'a'.repeat(342001), schema)).toThrow();
  });
});
