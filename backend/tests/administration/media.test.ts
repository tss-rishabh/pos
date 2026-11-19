import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetPublicAccessBlockCommand,
} from '@aws-sdk/client-s3';
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDocumentationMediaStore,
  createScopedMediaStore,
  readDocumentationMediaOptions,
} from '../../src/modules/administration/media-storage.js';
import {
  parseLegacyAssetList,
  sanitizeDocumentationHtml,
  uploadInput,
  utcMediaTimestamp,
} from '../../src/modules/administration/media-domain.js';
import { assertPrivateBucket } from '../../src/modules/administration/private-s3-client.js';
import { goldenStdout } from '../golden/load.js';

describe('private documentation media boundaries', () => {
  it('fails closed before new uploads when any bucket public-access protection or metadata verification is absent', async () => {
    const client = new S3Client({
      region: 'ap-south-1',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' },
    });
    const flags = {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    };
    const send = vi.spyOn(client, 'send');
    try {
      for (const name of Object.keys(flags)) {
        send.mockResolvedValueOnce({
          PublicAccessBlockConfiguration: { ...flags, [name]: false },
          $metadata: {},
        });
        await expect(
          assertPrivateBucket(client, 'fixture-bucket', undefined, '123456789012'),
        ).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_NOT_PRIVATE' });
      }
      send.mockRejectedValueOnce(new Error('private-canary@example.test'));
      await expect(assertPrivateBucket(client, 'fixture-bucket')).rejects.toMatchObject({
        code: 'PRIVATE_STORAGE_UNAVAILABLE',
        message: 'Private storage could not be verified.',
      });
      send.mockResolvedValueOnce({ PublicAccessBlockConfiguration: flags, $metadata: {} });
      await assertPrivateBucket(client, 'fixture-bucket', undefined, '123456789012');
      const command = send.mock.calls.at(-1)?.[0];
      expect(
        command instanceof GetPublicAccessBlockCommand && command.input.ExpectedBucketOwner,
      ).toBe('123456789012');
    } finally {
      send.mockRestore();
      client.destroy();
    }
  });
  it('reuses private media mechanics with exact profile/cover scope and rejects unsupported kinds', () => {
    const client = new S3Client({
      region: 'ap-south-1',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' },
    });
    const media = createScopedMediaStore(
      { NODE_ENV: 'test' },
      readDocumentationMediaOptions({ AWS_STORAGE_BUCKET_NAME: 'fixture-bucket' }),
      'uploads/users',
      { image: 'profile_image', 'cover-image': 'cover_image' },
      client,
    )!;
    const base = uploadInput.parse({
      id: randomUUID(),
      kind: 'image',
      name: 'Fixture.png',
      contentType: 'image/png',
      size: 8,
      checksum: createHash('sha256').update('fixture').digest('base64'),
    });
    expect(media.keyFor(base)).toBe(`uploads/users/profile_image/${base.id}.png`);
    expect(media.keyFor({ ...base, kind: 'cover-image' })).toBe(
      `uploads/users/cover_image/${base.id}.png`,
    );
    expect(() => media.keyFor({ ...base, kind: 'video' })).toThrow();
    expect(() => media.assertKey('uploads/other/private.png')).toThrow();
    expect(() =>
      createScopedMediaStore(
        { NODE_ENV: 'test' },
        readDocumentationMediaOptions({ AWS_STORAGE_BUCKET_NAME: 'fixture-bucket' }),
        '../users',
        { image: 'profile_image' },
        client,
      ),
    ).toThrow();
    media.close();
  });
  it('parses source Python asset lists without evaluating expressions', () => {
    const values = [
      "['folder/one.png', 'folder/two.png']",
      '["folder/O\'Brien.pdf", "folder/a\\\\b.pdf"]',
      "['folder/é.png', 'folder/escaped\\\'name.png']",
      '[]',
    ];
    const expected: unknown = JSON.parse(
      goldenStdout(
        'administration',
        'media',
        JSON.stringify({
          operation: 'asset-list',
          cases: values.map((value) => ({ value })),
        }),
      ),
    ) as unknown;
    expect(values.map(parseLegacyAssetList)).toEqual(expected);
    for (const value of ["[__import__('os').system('whoami')]", '{}', '[1]', '["unterminated]'])
      expect(() => parseLegacyAssetList(value)).toThrow();
  });
  it('keeps useful formatting while removing scripts, handlers, external images and unsafe links', () => {
    const html = sanitizeDocumentationHtml(
      '<h2>Guide</h2><p onclick="bad()">Steps <strong>one</strong><script>private-canary</script><img src="https://tracker.invalid/image"><a href="javascript:bad()">bad</a><a href="https://example.test/guide">guide</a></p>',
    );
    expect(html).toContain('<strong>one</strong>');
    expect(html).toContain('https://example.test/guide');
    for (const value of ['private-canary', 'onclick', 'javascript:', '<img'])
      expect(html).not.toContain(value);
  });
  it('validates category, size, filename and SHA-256 before reserving uploads', () => {
    const base = {
      id: randomUUID(),
      kind: 'image',
      name: 'Fixture.png',
      contentType: 'image/png',
      size: 8,
      checksum: createHash('sha256').update('fixture').digest('base64'),
    };
    expect(uploadInput.safeParse(base).success).toBe(true);
    for (const change of [
      { name: '../private.png' },
      { name: 'fixture\n.png' },
      { contentType: 'image/svg+xml' },
      { size: 11 * 1024 * 1024 },
      { kind: 'video' },
      { checksum: 'not-a-checksum' },
    ])
      expect(uploadInput.safeParse({ ...base, ...change }).success).toBe(false);
  });
  it('builds exact private POST policies and verifies uploaded bytes through mocked SDK commands', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      checksum = createHash('sha256').update(bytes).digest('base64');
    const client = new S3Client({
      region: 'ap-south-1',
      credentials: { accessKeyId: 'fixture-access-key', secretAccessKey: 'fixture-secret-key' },
    });
    const send = vi.spyOn(client, 'send').mockImplementation(async (command) => {
      if (command instanceof GetPublicAccessBlockCommand)
        return {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
          $metadata: {},
        };
      if (command instanceof HeadObjectCommand)
        return {
          ContentLength: bytes.length,
          ContentType: 'image/png',
          ChecksumSHA256: checksum,
          $metadata: {},
        };
      if (command instanceof GetObjectCommand)
        return { Body: Readable.from([bytes]), ContentLength: bytes.length, $metadata: {} };
      if (command instanceof DeleteObjectCommand) return { $metadata: {} };
      throw new Error('Unexpected fixture command');
    });
    const options = readDocumentationMediaOptions({
      AWS_STORAGE_BUCKET_NAME: 'fixture-bucket',
      S3_TUTORIAL_FOLDER_PATH: 'fixtures/tutorials',
    });
    const media = createDocumentationMediaStore({ NODE_ENV: 'test' }, options, client)!;
    try {
      const input = uploadInput.parse({
          id: randomUUID(),
          kind: 'cover-image',
          name: 'Private fixture.png',
          contentType: 'image/png',
          size: bytes.length,
          checksum,
        }),
        objectKey = media.keyFor(input),
        specification = {
          ...input,
          objectKey,
          expiresAt: utcMediaTimestamp(Temporal.Now.instant().add({ hours: 1 })),
        };
      expect(objectKey).not.toContain('Private fixture');
      expect(objectKey).toContain('/cover_images/');
      const post = await media.upload(specification);
      const policy = z
        .object({ conditions: z.array(z.unknown()) })
        .parse(JSON.parse(Buffer.from(post.fields.Policy!, 'base64').toString('utf8')) as unknown);
      expect(policy.conditions).toContainEqual([
        'content-length-range',
        bytes.length,
        bytes.length,
      ]);
      expect(policy.conditions).toContainEqual({ 'x-amz-checksum-sha256': checksum });
      expect(post.fields['Content-Type']).toBe('image/png');
      expect(post.fields['x-amz-server-side-encryption']).toBe('AES256');
      expect(post.fields).not.toHaveProperty('acl');
      await media.verify(specification);
      expect(
        send.mock.calls.some(
          ([command]) =>
            command instanceof GetObjectCommand && command.input.Range === 'bytes=0-31',
        ),
      ).toBe(true);
      const streamed = await media.stream(objectKey, 'cover-image');
      expect(streamed.contentType).toBe('image/png');
      streamed.body.destroy();
      await media.remove(objectKey);
      expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(
        true,
      );
      expect(() => media.assertKey('other-prefix/private.pdf')).toThrow(
        'outside the guide media location',
      );
    } finally {
      media.close();
    }
  });
});
