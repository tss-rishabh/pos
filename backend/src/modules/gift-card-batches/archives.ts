import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { AppError } from '../../domain/errors.js';
import { maxGiftCardArchiveBytes } from './generation.js';

/** AES AE-2 strength3 is256bit. External recipient archive-client support needs separate acceptance. */
export async function giftCardArchive(
  csv: Buffer,
  password: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (csv.length > maxGiftCardArchiveBytes || !/^[A-Za-z0-9_-]{43}$/.test(password))
    throw new AppError(503, 'GIFT_CARD_ARCHIVE_INVALID', 'Gift card archive is unavailable.');
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    password,
    encryptionStrength: 3,
    zipCrypto: false,
    useWebWorkers: false,
    level: 6,
  });
  try {
    await writer.add('gift-cards.csv', new Uint8ArrayReader(csv), {
      signal,
      lastModDate: new Date('2000-01-01T00:00:00Z'),
    });
    const bytes = Buffer.from(await writer.close());
    if (bytes.length > maxGiftCardArchiveBytes)
      throw new AppError(503, 'GIFT_CARD_BATCH_CAPACITY', 'Choose a smaller gift card batch.');
    return bytes;
  } catch {
    throw new AppError(
      503,
      'GIFT_CARD_ARCHIVE_UNAVAILABLE',
      'Gift card archive could not be prepared.',
    );
  }
}
