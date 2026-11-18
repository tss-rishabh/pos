import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { AppError } from '../../domain/errors.js';
import { maxGiftCardArchiveBytes } from './generation.js';

/**
 * `pyminizip.compress(input_file, None, output_file, password, 5)` (helpers/helpers.py:1351-1353):
 * one entry named after the CSV file, deflate level 5, traditional PKWARE (ZipCrypto) encryption.
 */
export async function giftCardArchive(
  csv: Buffer,
  entryName: string,
  password: string,
  modified: Date = new Date(),
  signal?: AbortSignal,
): Promise<Buffer> {
  if (csv.length > maxGiftCardArchiveBytes || !/^GFTCRDS-\d+\.csv$/.test(entryName) || !password)
    throw new AppError(503, 'GIFT_CARD_ARCHIVE_INVALID', 'Gift card archive is unavailable.');
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    password,
    zipCrypto: true,
    useWebWorkers: false,
    level: 5,
  });
  try {
    await writer.add(entryName, new Uint8ArrayReader(csv), { signal, lastModDate: modified });
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
