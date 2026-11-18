import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createGiftCardBatchStorage } from '../../src/modules/gift-card-batches/storage.js';
import { createGiftCardBatchDelivery } from '../../src/modules/gift-card-batches/delivery.js';
import { readGiftCardBatchOptions } from '../../src/modules/gift-card-batches/options.js';

const config = { NODE_ENV: 'test' as const, DEMO_MODE: false };
const options = () =>
  readGiftCardBatchOptions({
    AWS_STORAGE_BUCKET_NAME: 'private-pos-fixture',
    AWS_S3_REGION_NAME: 'ap-south-1',
    NETCORE_EMAIL_URL: 'https://mail.example.test/send',
    NETCORE_API_KEY: 'private-mail-fixture-key',
  });
function fixtureClient(publicAccessBlocked: boolean) {
  const client = new S3Client({
    region: 'ap-south-1',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    requestHandler: {
      handle: async () => {
        throw new Error('Unexpected real network call');
      },
    },
  });
  const commands: { name: string; input: unknown }[] = [];
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
              BlockPublicAcls: publicAccessBlocked,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          },
        };
      return { response: {}, output: { $metadata: {} } };
    },
    { step: 'initialize', name: 'giftCardFixture' },
  );
  return { client, commands };
}
describe('gift card legacy storage and Netcore adapters', () => {
  it('uploads the legacy key to the private bucket and refuses public buckets or other keys', async () => {
    const { client, commands } = fixtureClient(true),
      storage = createGiftCardBatchStorage(config, options(), client)!,
      bytes = Buffer.from('synthetic-zip');
    await storage.upload('uploads/csv/giftcards/GFTCRDS-17319900001123456.zip', bytes);
    expect(commands.map((command) => command.name)).toEqual([
      'GetPublicAccessBlockCommand',
      'PutObjectCommand',
    ]);
    expect(commands[1]!.input).toMatchObject({
      Bucket: 'private-pos-fixture',
      Key: 'uploads/csv/giftcards/GFTCRDS-17319900001123456.zip',
      ServerSideEncryption: 'AES256',
    });
    await expect(storage.upload('uploads/csv/giftcards/../x.zip', bytes)).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_STORAGE_UNAVAILABLE',
    });
    const exposed = fixtureClient(false),
      publicStorage = createGiftCardBatchStorage(config, options(), exposed.client)!;
    await expect(
      publicStorage.upload('uploads/csv/giftcards/GFTCRDS-1.zip', bytes),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_BATCH_STORAGE_UNAVAILABLE' });
    expect(exposed.commands.map((command) => command.name)).toEqual([
      'GetPublicAccessBlockCommand',
    ]);
    expect(createGiftCardBatchStorage(config, readGiftCardBatchOptions({}))).toBeUndefined();
  });
  it('posts the legacy Netcore payload and reports failures without throwing', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'success' }), { status: 200 }));
    const delivery = createGiftCardBatchDelivery(config, options(), fetcher)!,
      archive = Buffer.from('synthetic-zip');
    expect(
      await delivery.send({ collectionId: '7', recipient: 'fixture@example.test', archive }),
    ).toBe(true);
    const [, init] = fetcher.mock.calls[0]!;
    expect(init).toMatchObject({
      method: 'POST',
      headers: { api_key: 'private-mail-fixture-key', 'content-type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      from: { email: 'connect@thesouledstore.com', name: 'The Souled Store' },
      subject: 'GC Card Data',
      content: [{ type: 'html', value: 'Please download the attached file for Collection: 7' }],
      personalizations: [{ to: [{ email: 'fixture@example.test', name: 'fixture' }] }],
      attachments: [{ content: archive.toString('base64'), name: 'GC_CARD_DATA.zip' }],
    });
    fetcher.mockResolvedValueOnce(new Response('provider-error', { status: 500 }));
    expect(
      await delivery.send({ collectionId: '7', recipient: 'fixture@example.test', archive }),
    ).toBe(false);
    fetcher.mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    expect(
      await delivery.send({ collectionId: '7', recipient: 'fixture@example.test', archive }),
    ).toBe(false);
    fetcher.mockRejectedValueOnce(new Error('network'));
    expect(
      await delivery.send({ collectionId: '7', recipient: 'fixture@example.test', archive }),
    ).toBe(false);
    expect(() =>
      createGiftCardBatchDelivery(
        config,
        readGiftCardBatchOptions({ NETCORE_EMAIL_URL: 'http://mail.test', NETCORE_API_KEY: 'k' }),
      ),
    ).toThrow();
  });
});
