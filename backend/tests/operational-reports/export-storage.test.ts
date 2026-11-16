import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  createReportExportStore,
  reportExportOptions,
} from '../../src/modules/operational-reports/export-storage.js';
const privateFlags = {
  BlockPublicAcls: true,
  IgnorePublicAcls: true,
  BlockPublicPolicy: true,
  RestrictPublicBuckets: true,
};
function clientFixture(
  handler: (command: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  const client = new S3Client({
    region: 'ap-south-1',
    credentials: { accessKeyId: 'fixture-only', secretAccessKey: 'fixture-only' },
  });
  client.middlewareStack.add(
    (_next, context) => async (args) => ({
      response: {},
      output: {
        $metadata: {},
        ...(await handler(context.commandName || '', args.input as Record<string, unknown>)),
      },
    }),
    { step: 'initialize', name: 'fixtureTransport' },
  );
  return client;
}
const options = () =>
  reportExportOptions({
    AWS_STORAGE_BUCKET_NAME: 'fixture-private-reports',
    AWS_S3_EXPECTED_BUCKET_OWNER: '123456789012',
  });
describe('private immutable report files without network calls', () => {
  it('uses conditional encrypted PUTs, scoped opaque keys and checksum verification after a lost response', async () => {
    const bytes = Buffer.from('"Store","Amount"\r\n"Fixture","-5.00"'),
      checksum = createHash('sha256').update(bytes).digest('hex'),
      id = randomUUID(),
      calls: { command: string; input: Record<string, unknown> }[] = [];
    const client = clientFixture(async (command, input) => {
      calls.push({ command, input });
      if (command === 'GetPublicAccessBlockCommand')
        return { PublicAccessBlockConfiguration: privateFlags };
      if (command === 'PutObjectCommand')
        throw new S3ServiceException({
          name: 'PreconditionFailed',
          $fault: 'client',
          $metadata: { httpStatusCode: 412 },
        });
      if (command === 'HeadObjectCommand')
        return {
          ContentLength: bytes.length,
          Metadata: { sha256: checksum },
          ETag: 'fixture-etag',
        };
      if (command === 'GetObjectCommand') return { Body: Readable.from(bytes) };
      throw new Error('Unexpected fixture command');
    });
    const store = createReportExportStore(
      { NODE_ENV: 'test', DEMO_MODE: false },
      options(),
      client,
    )!;
    await store.put(id, bytes, checksum);
    expect(calls.map((call) => call.command)).toEqual([
      'GetPublicAccessBlockCommand',
      'PutObjectCommand',
      'GetPublicAccessBlockCommand',
      'HeadObjectCommand',
    ]);
    expect(calls[1]?.input).toMatchObject({
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      ExpectedBucketOwner: '123456789012',
      Metadata: { sha256: checksum },
      Key: `uploads/reports/pos-rewrite/${id}.csv`,
    });
    expect(calls[1]?.input).not.toHaveProperty('ACL');
    const file = await store.stream(store.keyFor(id), { size: bytes.length, checksum }),
      chunks: Buffer[] = [];
    for await (const chunk of file.body as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(calls.at(-1)?.input).toMatchObject({ IfMatch: 'fixture-etag' });
    store.close();
  });
  it('denies public buckets, traversal and oversized or changed artifacts before download', async () => {
    let publicBucket = true,
      gets = 0;
    const client = clientFixture(async (command) => {
      if (command === 'GetPublicAccessBlockCommand')
        return {
          PublicAccessBlockConfiguration: publicBucket
            ? { ...privateFlags, RestrictPublicBuckets: false }
            : privateFlags,
        };
      if (command === 'HeadObjectCommand')
        return { ContentLength: 12, Metadata: { sha256: '0'.repeat(64) } };
      if (command === 'GetObjectCommand') {
        gets++;
        return { Body: Readable.from('bad artifact') };
      }
      throw new Error('Unexpected fixture command');
    });
    const store = createReportExportStore(
        { NODE_ENV: 'test', DEMO_MODE: false },
        options(),
        client,
      )!,
      key = store.keyFor(randomUUID());
    await expect(store.head(key)).rejects.toMatchObject({ code: 'REPORT_STORAGE_UNAVAILABLE' });
    publicBucket = false;
    await expect(store.head('uploads/reports/pos-rewrite/../private.csv')).rejects.toMatchObject({
      code: 'EXPORT_FILE_SCOPE_DENIED',
    });
    await expect(store.head('uploads/customer.csv')).rejects.toMatchObject({
      code: 'EXPORT_FILE_SCOPE_DENIED',
    });
    await expect(store.stream(key, { size: 12, checksum: '1'.repeat(64) })).rejects.toMatchObject({
      code: 'EXPORT_FILE_INTEGRITY_FAILED',
    });
    expect(gets).toBe(0);
    store.close();
  });
  it('sanitizes stream errors and rejects modified content even when object metadata matches', async () => {
    const checksum = createHash('sha256').update('valid').digest('hex');
    let fail = false;
    const client = clientFixture(async (command) => {
      if (command === 'GetPublicAccessBlockCommand')
        return { PublicAccessBlockConfiguration: privateFlags };
      if (command === 'HeadObjectCommand')
        return { ContentLength: 5, Metadata: { sha256: checksum } };
      if (command === 'GetObjectCommand')
        return {
          Body: fail
            ? Readable.from(
                (async function* () {
                  yield 'va';
                  throw new Error('secret request URL and credentials');
                })(),
              )
            : Readable.from('wrong'),
        };
      throw new Error('Unexpected fixture command');
    });
    const store = createReportExportStore(
        { NODE_ENV: 'test', DEMO_MODE: false },
        options(),
        client,
      )!,
      key = store.keyFor(randomUUID()),
      consume = async () => {
        const file = await store.stream(key, { size: 5, checksum });
        for await (const chunk of file.body as AsyncIterable<unknown>) void chunk;
      };
    await expect(consume()).rejects.toMatchObject({ code: 'REPORT_STORAGE_UNAVAILABLE' });
    fail = true;
    await expect(consume()).rejects.toMatchObject({
      code: 'REPORT_STORAGE_UNAVAILABLE',
      message: 'Report file storage is temporarily unavailable.',
    });
    store.close();
  });
  it('does not create an outbound client in demo mode or without a bucket', () => {
    expect(
      createReportExportStore({ NODE_ENV: 'test', DEMO_MODE: true }, options()),
    ).toBeUndefined();
    expect(
      createReportExportStore({ NODE_ENV: 'test', DEMO_MODE: false }, reportExportOptions({})),
    ).toBeUndefined();
    expect(() =>
      reportExportOptions({ S3_REPORT_EXPORT_FOLDER_PATH: 'uploads/../private' }),
    ).toThrow();
  });
});
