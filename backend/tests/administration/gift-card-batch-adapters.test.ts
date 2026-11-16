import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createGiftCardBatchStorage } from '../../src/modules/gift-card-batches/storage.js';
import { createGiftCardBatchDelivery } from '../../src/modules/gift-card-batches/delivery.js';
import { readGiftCardBatchOptions } from '../../src/modules/gift-card-batches/options.js';

const config = { NODE_ENV: 'test' as const, DEMO_MODE: false };
const options = () =>
  readGiftCardBatchOptions({
    GIFT_CARD_BATCHES_ENABLED: 'true',
    AWS_STORAGE_BUCKET_NAME: 'private-pos-fixture',
    AWS_S3_REGION_NAME: 'ap-south-1',
    AWS_S3_EXPECTED_BUCKET_OWNER: '123456789012',
    S3_GIFT_CARD_BATCH_FOLDER_PATH: 'uploads/csv/giftcards',
    NETCORE_EMAIL_URL: 'https://mail.example.test/send',
    NETCORE_API_KEY: 'private-mail-fixture-key',
  });
describe('gift card private storage and acknowledged delivery adapters', () => {
  it('conditionally uploads immutable bytes, reconciles an unknown PUT and consumes bounded downloads', async () => {
    const client = new S3Client({
      region: 'ap-south-1',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
      requestHandler: {
        handle: async () => {
          throw new Error('Unexpected real network call');
        },
      },
    });
    const commands: { name: string; input: unknown }[] = [],
      bytes = Buffer.from('synthetic-encrypted-archive');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    let readable: Readable | undefined;
    client.middlewareStack.add(
      (_next, context) => async (args) => {
        if (!context.commandName) throw new Error('Fixture command metadata is unavailable.');
        commands.push({ name: context.commandName, input: args.input });
        if (context.commandName === 'GetPublicAccessBlockCommand')
          return {
            response: {},
            output: {
              $metadata: {},
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                IgnorePublicAcls: true,
                BlockPublicPolicy: true,
                RestrictPublicBuckets: true,
              },
            },
          };
        if (context.commandName === 'PutObjectCommand')
          throw new Error('private-unknown-provider-error@example.test');
        if (context.commandName === 'HeadObjectCommand')
          return {
            response: {},
            output: {
              $metadata: {},
              ContentLength: bytes.length,
              ContentType: 'application/zip',
              ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
              ServerSideEncryption: 'AES256',
            },
          };
        if (context.commandName === 'GetObjectCommand') {
          readable = Readable.from([bytes]);
          return { response: {}, output: { $metadata: {}, Body: readable } };
        }
        throw new Error('Unexpected fixture SDK command');
      },
      { step: 'initialize', name: 'giftCardBatchFixture', priority: 'high' },
    );
    const storage = createGiftCardBatchStorage(config, options(), client)!;
    const manifest = { key: storage.keyFor(randomUUID()), checksum, size: bytes.length };
    await storage.put(manifest, bytes);
    expect(commands.map((command) => command.name)).toEqual([
      'GetPublicAccessBlockCommand',
      'PutObjectCommand',
      'HeadObjectCommand',
    ]);
    expect(commands[1]!.input).toMatchObject({
      ExpectedBucketOwner: '123456789012',
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
      ContentType: 'application/zip',
    });
    expect(await storage.get(manifest)).toEqual(bytes);
    expect(readable?.destroyed).toBe(true);
    expect(
      commands.filter((command) => command.name === 'GetPublicAccessBlockCommand'),
    ).toHaveLength(2);
    storage.close();
  });
  it('fails closed for public buckets, wrong checksums, unsafe keys and oversized streams with static errors', async () => {
    const client = new S3Client({
      region: 'ap-south-1',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
      requestHandler: {
        handle: async () => {
          throw new Error('Unexpected real network call');
        },
      },
    });
    let ready = false,
      wrongChecksum = false,
      oversized = false,
      readable: Readable | undefined;
    const bytes = Buffer.from('fixture');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    client.middlewareStack.add(
      (_next, context) => async () => {
        if (context.commandName === 'GetPublicAccessBlockCommand')
          return {
            response: {},
            output: {
              $metadata: {},
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                IgnorePublicAcls: true,
                BlockPublicPolicy: ready,
                RestrictPublicBuckets: true,
              },
            },
          };
        if (context.commandName === 'HeadObjectCommand')
          return {
            response: {},
            output: {
              $metadata: {},
              ContentLength: bytes.length,
              ContentType: 'application/zip',
              ChecksumSHA256: wrongChecksum
                ? 'wrong'
                : Buffer.from(checksum, 'hex').toString('base64'),
              ServerSideEncryption: 'AES256',
            },
          };
        if (context.commandName === 'GetObjectCommand') {
          readable = Readable.from([oversized ? Buffer.alloc(100) : bytes]);
          return { response: {}, output: { $metadata: {}, Body: readable } };
        }
        return { response: {}, output: { $metadata: {} } };
      },
      { step: 'initialize', name: 'giftCardBatchInvalidFixture', priority: 'high' },
    );
    const storage = createGiftCardBatchStorage(config, options(), client)!,
      manifest = { key: storage.keyFor(randomUUID()), checksum, size: bytes.length };
    await expect(storage.put(manifest, bytes)).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_STORAGE_UNAVAILABLE',
    });
    ready = true;
    wrongChecksum = true;
    await expect(storage.get(manifest)).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_STORAGE_UNAVAILABLE',
    });
    wrongChecksum = false;
    oversized = true;
    await expect(storage.get(manifest)).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_STORAGE_UNAVAILABLE',
    });
    expect(readable?.destroyed).toBe(true);
    await expect(
      storage.get({ ...manifest, key: 'uploads/csv/giftcards/../../private.zip' }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_BATCH_STORAGE_UNAVAILABLE' });
    storage.close();
  });
  it('requires a definitive provider acceptance and retains exact attachment fields without emailing its password', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'success' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const delivery = createGiftCardBatchDelivery(config, options(), fetcher)!,
      archive = Buffer.from('synthetic-encrypted-archive'),
      attemptId = randomUUID();
    expect(
      await delivery.send(attemptId, {
        batchId: '7',
        recipient: 'fixture@example.test',
        archive,
        requestId: 'fixture-request',
      }),
    ).toBe('accepted');
    const [, init] = fetcher.mock.calls[0]!;
    expect(init).toMatchObject({
      redirect: 'error',
      headers: { api_key: 'private-mail-fixture-key', 'Idempotency-Key': attemptId },
    });
    const body = JSON.parse(String(init?.body)) as unknown;
    expect(body).toMatchObject({
      subject: 'GC Card Data',
      attachments: [{ content: archive.toString('base64'), name: 'GC_CARD_DATA.zip' }],
      personalizations: [{ to: [{ email: 'fixture@example.test', name: 'fixture' }] }],
    });
    expect(JSON.stringify(body)).not.toMatch(/"password"|last.?6|phone/);
    for (const [response, outcome] of [
      [new Response('private-provider-canary@example.test', { status: 500 }), 'uncertain'],
      [new Response('{}', { status: 200 }), 'uncertain'],
      [new Response('{}', { status: 400 }), 'rejected'],
    ] as const) {
      fetcher.mockResolvedValueOnce(response);
      expect(
        await delivery.send(randomUUID(), {
          batchId: '7',
          recipient: 'fixture@example.test',
          archive,
        }),
      ).toBe(outcome);
    }
    fetcher.mockRejectedValueOnce(new Error('private-provider-canary@example.test'));
    expect(
      await delivery.send(randomUUID(), {
        batchId: '7',
        recipient: 'fixture@example.test',
        archive,
      }),
    ).toBe('uncertain');
  });
  it('binds configured KMS encryption to the exact key ARN and requires production bucket ownership', async () => {
    const client = new S3Client({
      region: 'ap-south-1',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
      requestHandler: {
        handle: async () => {
          throw new Error('Unexpected real network call');
        },
      },
    });
    const key = 'arn:aws:kms:ap-south-1:123456789012:key/11111111-1111-4111-8111-111111111111',
      bytes = Buffer.from('encrypted-fixture'),
      checksum = createHash('sha256').update(bytes).digest('hex');
    let returnedKey = key;
    client.middlewareStack.add(
      (_next, context) => async (args) => {
        if (context.commandName === 'GetPublicAccessBlockCommand')
          return {
            response: {},
            output: {
              $metadata: {},
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                IgnorePublicAcls: true,
                BlockPublicPolicy: true,
                RestrictPublicBuckets: true,
              },
            },
          };
        if (context.commandName === 'PutObjectCommand') {
          expect(args.input).toMatchObject({ SSEKMSKeyId: key, ServerSideEncryption: 'aws:kms' });
          return { response: {}, output: { $metadata: {} } };
        }
        if (context.commandName === 'HeadObjectCommand')
          return {
            response: {},
            output: {
              $metadata: {},
              ContentLength: bytes.length,
              ContentType: 'application/zip',
              ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
              ServerSideEncryption: 'aws:kms',
              SSEKMSKeyId: returnedKey,
            },
          };
        throw new Error('Unexpected fixture SDK command');
      },
      { step: 'initialize', name: 'giftCardBatchKmsFixture', priority: 'high' },
    );
    const storage = createGiftCardBatchStorage(
        config,
        { ...options(), AWS_S3_KMS_KEY_ID: key },
        client,
      )!,
      manifest = { key: storage.keyFor(randomUUID()), checksum, size: bytes.length };
    await storage.put(manifest, bytes);
    returnedKey = key.replace('11111111-', '22222222-');
    await expect(storage.put(manifest, bytes)).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_STORAGE_UNAVAILABLE',
    });
    storage.close();
    expect(() =>
      createGiftCardBatchStorage(
        { ...config, NODE_ENV: 'production' },
        { ...options(), AWS_S3_EXPECTED_BUCKET_OWNER: undefined },
      ),
    ).toThrow();
    expect(() =>
      createGiftCardBatchStorage(config, { ...options(), AWS_S3_KMS_KEY_ID: 'alias/gift-cards' }),
    ).toThrow();
  });
  it('remains disabled without opt-in and rejects unsafe provider destinations before sends', () => {
    expect(createGiftCardBatchStorage({ ...config, DEMO_MODE: true }, options())).toBeUndefined();
    expect(createGiftCardBatchDelivery(config, readGiftCardBatchOptions({}))).toBeUndefined();
    for (const url of [
      'http://mail.example.test/send',
      'https://private@mailer.example.test/send',
      'https://mailer.example.test/send?secret=private',
    ])
      expect(() =>
        createGiftCardBatchDelivery(config, { ...options(), NETCORE_EMAIL_URL: url }),
      ).toThrow();
  });
});
