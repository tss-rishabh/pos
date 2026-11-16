import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';
import { createExportSpool } from '../../src/modules/inventory-workbooks/staging.js';
import { readInventoryWorkbookOptions } from '../../src/modules/inventory-workbooks/options.js';
import {
  createReportExportStore,
  reportExportOptions,
} from '../../src/modules/operational-reports/export-storage.js';
import { xlsxContentType } from '../../src/modules/operational-reports/export-format.js';
const directories: string[] = [];
const flags = {
  BlockPublicAcls: true,
  IgnorePublicAcls: true,
  BlockPublicPolicy: true,
  RestrictPublicBuckets: true,
};
function fixtureClient(
  handler: (command: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  const client = new S3Client({
    region: 'ap-south-1',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
  });
  client.middlewareStack.add(
    (_next, context) => async (args) => ({
      response: {},
      output: {
        $metadata: {},
        ...(await handler(context.commandName || '', args.input as Record<string, unknown>)),
      },
    }),
    { step: 'initialize', name: 'controlledWorkbookStorage' },
  );
  return client;
}
const storageOptions = () =>
  reportExportOptions({
    AWS_STORAGE_BUCKET_NAME: 'fixture-private-workbooks',
    AWS_S3_EXPECTED_BUCKET_OWNER: '123456789012',
  });
async function artifact() {
  const directory = await mkdtemp(join(tmpdir(), 'pos-workbook-storage-'));
  directories.push(directory);
  const options = readInventoryWorkbookOptions({ INVENTORY_WORKBOOK_STAGING_DIRECTORY: directory }),
    spool = await createExportSpool(options, 100000, new AbortController().signal),
    writer = spool.writable.getWriter(),
    bytes = Buffer.from('PK\x03\x04synthetic sealed transport bytes');
  await writer.write(bytes);
  await writer.close();
  return { file: await spool.seal(), bytes };
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe('streaming XLSX S3 transport without network calls', () => {
  it('sends an authenticated private conditional stream with exact MIME, checksum, size and opaque extension', async () => {
    const { file, bytes } = await artifact(),
      id = randomUUID(),
      calls: { command: string; input: Record<string, unknown> }[] = [],
      client = fixtureClient(async (command, input) => {
        calls.push({ command, input });
        if (command === 'GetPublicAccessBlockCommand')
          return { PublicAccessBlockConfiguration: flags };
        if (command === 'PutObjectCommand') {
          expect(input.Body).toBeInstanceOf(Readable);
          expect(Buffer.isBuffer(input.Body)).toBe(false);
          const chunks: Buffer[] = [];
          for await (const value of input.Body as Readable) chunks.push(Buffer.from(value));
          expect(Buffer.concat(chunks)).toEqual(bytes);
          return {};
        }
        throw new Error('Unexpected fixture call.');
      }),
      store = createReportExportStore(
        { NODE_ENV: 'test', DEMO_MODE: false },
        storageOptions(),
        client,
      )!;
    try {
      await store.putArtifact!(id, file, 'XLSX');
      expect(calls.at(-1)?.input).toMatchObject({
        Key: `uploads/reports/pos-rewrite/${id}.xlsx`,
        ContentLength: bytes.length,
        ContentType: xlsxContentType,
        IfNoneMatch: '*',
        ServerSideEncryption: 'AES256',
        ExpectedBucketOwner: '123456789012',
        Metadata: { sha256: createHash('sha256').update(bytes).digest('hex') },
      });
      expect(calls.at(-1)?.input).not.toHaveProperty('ACL');
      expect(store.keyFor(id)).toMatch(/\.csv$/);
    } finally {
      store.close();
      await file.dispose();
    }
  });
  it('reconciles conditional PUT collision with matching HEAD and refuses mismatched XLSX content types', async () => {
    const { file } = await artifact(),
      id = randomUUID();
    let mime = xlsxContentType;
    const client = fixtureClient(async (command) => {
        if (command === 'GetPublicAccessBlockCommand')
          return { PublicAccessBlockConfiguration: flags };
        if (command === 'PutObjectCommand')
          throw new S3ServiceException({
            name: 'PreconditionFailed',
            $fault: 'client',
            $metadata: { httpStatusCode: 412 },
          });
        if (command === 'HeadObjectCommand')
          return {
            ContentLength: file.byteCount,
            Metadata: { sha256: file.checksum },
            ContentType: mime,
          };
        throw new Error('Unexpected fixture call.');
      }),
      store = createReportExportStore(
        { NODE_ENV: 'test', DEMO_MODE: false },
        storageOptions(),
        client,
      )!;
    try {
      await store.putArtifact!(id, file, 'XLSX');
      mime = 'text/html';
      await expect(store.putArtifact!(id, file, 'XLSX')).rejects.toMatchObject({
        code: 'REPORT_STORAGE_UNAVAILABLE',
      });
    } finally {
      store.close();
      await file.dispose();
    }
  });
  it('refuses an unverified public bucket and already-aborted uploads without opening private file bytes', async () => {
    let opens = 0,
      publicBucket = true;
    const client = fixtureClient(async (command) => {
        if (command === 'GetPublicAccessBlockCommand')
          return {
            PublicAccessBlockConfiguration: { ...flags, RestrictPublicBuckets: !publicBucket },
          };
        throw new Error('No upload permitted.');
      }),
      store = createReportExportStore(
        { NODE_ENV: 'test', DEMO_MODE: false },
        storageOptions(),
        client,
      )!,
      file = {
        byteCount: 10,
        checksum: 'a'.repeat(64),
        async open(signal?: AbortSignal) {
          signal?.throwIfAborted();
          opens++;
          return Readable.from(['0123456789']);
        },
        async dispose() {},
      };
    try {
      await expect(store.putArtifact!(randomUUID(), file, 'XLSX')).rejects.toMatchObject({
        code: 'REPORT_STORAGE_UNAVAILABLE',
      });
      publicBucket = false;
      const controller = new AbortController();
      controller.abort();
      await expect(
        store.putArtifact!(randomUUID(), file, 'XLSX', controller.signal),
      ).rejects.toBeInstanceOf(Error);
      expect(opens).toBe(0);
    } finally {
      store.close();
    }
  });
});
