import sharp from 'sharp';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError } from '../../../domain/errors.js';
import { mediaMagicMatches } from '../media-domain.js';
import { z } from 'zod';

const pixelLimit = 16 * 1024 * 1024;
const imageContentType = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const formats: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
let active = false;
const invalid = (prefix: string) =>
  new AppError(
    400,
    `${prefix.replace(/_IMAGE$/, '')}_IMAGE_INVALID`,
    'Choose a complete JPEG, PNG, WebP or GIF image smaller than 10 MB and 16 megapixels.',
  );

/** Decode pixel data, with bounded bytes/pixels/frames/time, before publishing a personal image. */
export async function verifyPrivateImage(
  read: () => Promise<{ body: Readable; contentType: string; size?: number }>,
  expected: { contentType: string; size: number; checksum: string },
  prefix = 'PRIVATE',
): Promise<void> {
  if (active)
    throw new AppError(
      429,
      `${prefix.replace(/_IMAGE$/, '')}_IMAGE_VALIDATION_BUSY`,
      'Another image is being checked. Retry the attachment shortly.',
    );
  active = true;
  let body: Readable | undefined, image: ReturnType<typeof sharp> | undefined;
  try {
    const contentType = imageContentType.parse(expected.contentType);
    const object = await read();
    body = object.body;
    if (
      !formats[expected.contentType] ||
      object.contentType !== expected.contentType ||
      object.size !== expected.size ||
      expected.size < 1 ||
      expected.size > 10 * 1024 * 1024
    )
      throw invalid(prefix);
    const parts: Buffer[] = [];
    let size = 0;
    for await (const value of body) {
      const chunk: unknown = value;
      if (!(chunk instanceof Uint8Array) || size + chunk.byteLength > expected.size)
        throw invalid(prefix);
      size += chunk.byteLength;
      parts.push(Buffer.from(chunk));
    }
    if (size !== expected.size) throw invalid(prefix);
    const bytes = Buffer.concat(parts);
    if (createHash('sha256').update(bytes).digest('base64') !== expected.checksum)
      throw invalid(prefix);
    if (!mediaMagicMatches(contentType, bytes)) throw invalid(prefix);
    image = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: pixelLimit,
      animated: true,
    }).timeout({ seconds: 2 });
    image.on('warning', () => {});
    const metadata = await image.metadata();
    const width = metadata.width || 0,
      height = metadata.pageHeight || metadata.height || 0,
      pages = metadata.pages || 1;
    if (
      metadata.format !== formats[expected.contentType] ||
      width < 1 ||
      height < 1 ||
      width > 16384 ||
      height > 16384 ||
      pages > 120 ||
      width * height * pages > pixelLimit
    )
      throw invalid(prefix);
    await image.stats();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid(prefix); // Decoder/library messages can contain metadata and must not escape.
  } finally {
    body?.destroy();
    image?.destroy();
    active = false;
  }
}
