import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { verifyProfileImage } from '../src/auth/profile-image-validation.js';

const check = (bytes: Buffer, contentType = 'image/png') =>
  verifyProfileImage(
    async () => ({ body: Readable.from([bytes]), contentType, size: bytes.length }),
    {
      contentType,
      size: bytes.length,
      checksum: createHash('sha256').update(bytes).digest('base64'),
    },
  );
it('fully decodes supported image formats and rejects truncated/header-only/mislabeled content', async () => {
  for (const [format, contentType] of [
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
  ] as const) {
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 4, background: '#db503f' },
    })
      .toFormat(format)
      .toBuffer();
    await expect(check(bytes, contentType)).resolves.toBeUndefined();
    await expect(check(bytes.subarray(0, 8), contentType)).rejects.toMatchObject({
      code: 'PROFILE_IMAGE_INVALID',
    });
  }
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  await expect(check(png, 'image/jpeg')).rejects.toMatchObject({ code: 'PROFILE_IMAGE_INVALID' });
  await expect(
    check(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png'),
  ).rejects.toMatchObject({ code: 'PROFILE_IMAGE_INVALID' });
});
it('bounds decoded pixel count and serializes validation before reading another object', async () => {
  const oversized = await sharp({
    create: { width: 4097, height: 4097, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  await expect(check(oversized)).rejects.toMatchObject({ code: 'PROFILE_IMAGE_INVALID' });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  const first = verifyProfileImage(
    async () => {
      await gate;
      return { body: Readable.from([bytes]), contentType: 'image/png', size: bytes.length };
    },
    {
      contentType: 'image/png',
      size: bytes.length,
      checksum: createHash('sha256').update(bytes).digest('base64'),
    },
  );
  await expect(check(bytes)).rejects.toMatchObject({ code: 'PROFILE_IMAGE_VALIDATION_BUSY' });
  release!();
  await first;
  await expect(check(bytes)).resolves.toBeUndefined();
});
