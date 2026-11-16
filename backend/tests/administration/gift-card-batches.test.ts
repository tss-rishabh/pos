import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ZipReader, Uint8ArrayReader, TextWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  generateGiftCards,
  giftCardCsv,
  giftCardRecipient,
  sourceGiftCardPin,
} from '../../src/modules/gift-card-batches/generation.js';
import { giftCardArchive } from '../../src/modules/gift-card-batches/archives.js';
import { readGiftCardBatchOptions } from '../../src/modules/gift-card-batches/options.js';
import {
  newGiftCardSecrets,
  openGiftCardSecrets,
  sealGiftCardSecrets,
} from '../../src/modules/gift-card-batches/secrets.js';

const oracle = (cases: unknown[]) =>
  z
    .object({ sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), cases: z.array(z.unknown()) })
    .parse(
      JSON.parse(
        execFileSync(
          'uv',
          [
            'run',
            '--no-project',
            '--with',
            'hashids==1.3.1',
            'python',
            'tools/administration/gift-card-batch-oracle.py',
          ],
          { input: JSON.stringify({ cases }), encoding: 'utf8', timeout: 30000 },
        ),
      ) as unknown,
    ).cases;
describe('gift card batch source format and private archives', () => {
  it('matches actual pinned Python CSV/Hashids/PIN output for source random draws, including exact serials above2^53', () => {
    const inputs = ['1', '10', '123', '999999', '123456789', '999999999'].flatMap((collectionId) =>
      [1, 3, 123].map((size) => ({ operation: 'generate', collectionId, size, seed: size * 11 })),
    );
    const expected = oracle(inputs),
      projection = z.object({
        randomCalls: z.array(
          z.object({ minimum: z.number(), maximum: z.number(), value: z.number() }),
        ),
        cards: z.array(
          z.object({
            collectionId: z.string(),
            serial: z.string(),
            code: z.string(),
            pin: z.string(),
          }),
        ),
        csv: z.string(),
      });
    inputs.forEach((input, index) => {
      const value = projection.parse(expected[index]);
      let cursor = 0;
      const cards = generateGiftCards(
        input.collectionId,
        input.size,
        'fixture-gift-card-batch-salt',
        (minimum, maximum) => {
          const call = value.randomCalls[cursor++]!;
          expect({ minimum, maximum }).toEqual({ minimum: call.minimum, maximum: call.maximum });
          return call.value;
        },
      );
      expect(cards).toEqual(value.cards);
      expect(giftCardCsv(cards).toString('utf8')).toBe(value.csv);
      expect(cursor).toBe(value.randomCalls.length);
    });
    expect(
      projection
        .parse(expected.at(-1))
        .cards.some((card) => BigInt(card.serial) > BigInt(Number.MAX_SAFE_INTEGER)),
    ).toBe(true);
  });
  it('matches native legacy PINs and source recipient prefix/digit cleanup for valid delivery addresses', () => {
    const serials = [
      '990111',
      '990112',
      '9950123456789',
      '9007199254740993',
      '9223372036854775807',
    ];
    const emails = [
      'fixture@example.test',
      'pos.fixture@example.test',
      'emp.fixture@example.test',
      '123fixture@example.test',
      'pos.123fixture.4more@example.test',
      '１２３fixture@example.test',
      'pos.१२३fixture.४more@example.test',
    ];
    const expected = oracle([
      ...serials.map((serial) => ({ operation: 'pin', serial })),
      ...emails.map((email) => ({ operation: 'email', email })),
    ]);
    serials.forEach((serial, index) => expect(sourceGiftCardPin(serial)).toBe(expected[index]));
    emails.forEach((email, index) =>
      expect(giftCardRecipient(email)).toBe(expected[serials.length + index]),
    );
    for (const value of [null, '', 'pos.', 'invalid'])
      expect(() => giftCardRecipient(value)).toThrow();
  });
  it('writes an authenticated AES256 archive with no plaintext card data and rejects the wrong password', async () => {
    const cards = generateGiftCards('7', 3, 'fixture-gift-card-batch-salt'),
      csv = giftCardCsv(cards),
      password = randomBytes(32).toString('base64url'),
      archive = await giftCardArchive(csv, password);
    expect(archive.includes(csv)).toBe(false);
    expect(archive.includes(Buffer.from(cards[0]!.code))).toBe(false);
    const reader = new ZipReader(new Uint8ArrayReader(archive), { useWebWorkers: false });
    try {
      const entries = await reader.getEntries();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      if (entry.directory) throw new Error('Fixture archive does not contain a file.');
      expect(entry.filename).toBe('gift-cards.csv');
      expect(entry.encrypted).toBe(true);
      expect(entry.zipCrypto).not.toBe(true);
      if (!entry.getData) throw new Error('Encrypted archive entry is unavailable.');
      await expect(
        entry.getData(new TextWriter(), { password: 'incorrect-password' }),
      ).rejects.toThrow();
      expect(await entry.getData(new TextWriter(), { password })).toBe(csv.toString('utf8'));
    } finally {
      await reader.close();
    }
  });
  it('binds sealed artifact secrets to batch/key IDs and retains old keys during rotation', () => {
    const options = readGiftCardBatchOptions({
        GC_SALTKEY: 'fixture-gift-card-batch-salt',
        GIFT_CARD_BATCH_ACTIVE_KEY_ID: 'first',
        GIFT_CARD_BATCH_ENCRYPTION_KEYS: JSON.stringify({ first: 'ab'.repeat(32) }),
      }),
      sealed = newGiftCardSecrets(options, '7', 'fixture@example.test');
    expect(sealed).not.toContain('fixture@example.test');
    const first = openGiftCardSecrets(options, '7', sealed);
    expect(first.password).toHaveLength(43);
    expect(() => openGiftCardSecrets(options, '8', sealed)).toThrow();
    expect(() => openGiftCardSecrets(options, '7', sealed.slice(0, -3) + 'xxx')).toThrow();
    const rotated = {
      ...options,
      GIFT_CARD_BATCH_ACTIVE_KEY_ID: 'second',
      GIFT_CARD_BATCH_ENCRYPTION_KEYS: { first: 'ab'.repeat(32), second: 'cd'.repeat(32) },
    };
    expect(openGiftCardSecrets(rotated, '7', sealed)).toEqual(first);
    const resealed = sealGiftCardSecrets(rotated, first);
    expect(resealed.startsWith('second.')).toBe(true);
    expect(openGiftCardSecrets(rotated, '7', resealed)).toEqual(first);
    expect(() =>
      openGiftCardSecrets(
        { ...rotated, GIFT_CARD_BATCH_ENCRYPTION_KEYS: { second: 'cd'.repeat(32) } },
        '7',
        sealed,
      ),
    ).toThrow();
  });
  it('refuses malformed/oversized/undecodable batch formats and bounds generated archives', async () => {
    for (const [collectionId, size] of [
      ['01', 1],
      ['1000000000', 1],
      ['1', 0],
      ['1', 10001],
      ['1', 1.5],
    ] as const)
      expect(() => generateGiftCards(collectionId, size, 'fixture-salt')).toThrow();
    expect(() => generateGiftCards('1', 1, 'fixture-salt', () => 90)).toThrow();
    expect(generateGiftCards('1', 10000, 'fixture-salt')).toHaveLength(10000);
    await expect(giftCardArchive(Buffer.from('private'), 'short')).rejects.toMatchObject({
      code: 'GIFT_CARD_ARCHIVE_INVALID',
    });
    expect(() =>
      readGiftCardBatchOptions({ GIFT_CARD_BATCH_ENCRYPTION_KEYS: 'private-not-json' }),
    ).toThrow();
  });
});
