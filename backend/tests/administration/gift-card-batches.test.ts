import { ZipReader, Uint8ArrayReader, TextWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  generateGiftCards,
  giftCardArchiveNames,
  giftCardArchivePassword,
  giftCardCsv,
  giftCardRecipient,
  sourceGiftCardPin,
} from '../../src/modules/gift-card-batches/generation.js';
import { giftCardArchive } from '../../src/modules/gift-card-batches/archives.js';
import { goldenStdout } from '../golden/load.js';

const oracle = (cases: unknown[]) =>
  z
    .object({ sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), cases: z.array(z.unknown()) })
    .parse(
      JSON.parse(
        goldenStdout('administration', 'gift-card-batches', JSON.stringify({ cases })),
      ) as unknown,
    ).cases;
describe('gift card batch source format and legacy archives', () => {
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
    // Legacy sends to whatever clean_email returns; an empty result means "not eligible".
    expect([null, '', 'pos.', 'invalid'].map(giftCardRecipient)).toEqual(['', '', '', 'invalid']);
  });
  it('derives the legacy archive password and file names (helpers/helpers.py:1323-1350)', () => {
    expect(giftCardArchivePassword('0123456789', '10')).toBe('45678910');
    expect(giftCardArchivePassword('98765', '7')).toBe('987657');
    expect(giftCardArchivePassword(null, '7')).toBe('1234567');
    expect(giftCardArchivePassword('', '42')).toBe('12345642');
    expect(giftCardArchiveNames(1731990000123450n, () => 7)).toEqual({
      entry: 'GFTCRDS-173199000012345777777.csv',
      key: 'uploads/csv/giftcards/GFTCRDS-173199000012345777777.zip',
    });
    expect(giftCardArchiveNames(1731990000000000n, () => 1).entry).toBe(
      'GFTCRDS-17319900000111111.csv',
    );
  });
  it('writes a ZipCrypto archive with one CSV entry named like the legacy file', async () => {
    const cards = generateGiftCards('7', 3, 'fixture-gift-card-batch-salt'),
      csv = giftCardCsv(cards),
      password = giftCardArchivePassword('9876543210', '7'),
      archive = await giftCardArchive(csv, 'GFTCRDS-17319900001.csv', password);
    expect(archive.includes(Buffer.from(cards[0]!.code))).toBe(false);
    const reader = new ZipReader(new Uint8ArrayReader(archive), { useWebWorkers: false });
    try {
      const entries = await reader.getEntries();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      if (entry.directory) throw new Error('Fixture archive does not contain a file.');
      expect(entry.filename).toBe('GFTCRDS-17319900001.csv');
      expect(entry.encrypted).toBe(true);
      expect(entry.zipCrypto).toBe(true);
      if (!entry.getData) throw new Error('Encrypted archive entry is unavailable.');
      await expect(
        entry.getData(new TextWriter(), { password: 'incorrect-password' }),
      ).rejects.toThrow();
      expect(await entry.getData(new TextWriter(), { password: '5432107' })).toBe(
        csv.toString('utf8'),
      );
    } finally {
      await reader.close();
    }
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
    await expect(
      giftCardArchive(Buffer.from('private'), 'gift-cards.csv', '1234561'),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_ARCHIVE_INVALID' });
  });
});
