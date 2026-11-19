import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import {
  createPrivateS3Client,
  readPrivateS3Options,
  assertPrivateBucket,
} from '../administration/private-s3-client.js';

const prefix = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,299}$/)
  .transform((value) => value.replace(/\/+$/, ''));
export function reportExportOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...readPrivateS3Options(env),
    ...z
      .object({
        /** Legacy `create_and_upload_csv` folder: `uploads/reports/{report_type}/orders_{uuid}.csv`. */
        S3_REPORT_EXPORT_FOLDER_PATH: prefix.default('uploads/reports'),
        REPORT_EXPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(268435456).default(67108864),
      })
      .parse(env),
  };
}
export type ReportExportOptions = ReturnType<typeof reportExportOptions>;
export interface ExportObjectInfo {
  size: number;
  checksum: string | null;
  etag?: string;
  contentType?: string;
}
export interface ReportExportStore {
  /** `{prefix}/{folder}/orders_{uuid hex}.csv`, as `Helpers.create_and_upload_csv` (helpers/helpers.py:2152-2153). */
  keyFor(folder: string): string;
  put(key: string, bytes: Buffer, checksum: string): Promise<void>;
  head(key: string): Promise<ExportObjectInfo | null>;
  stream(
    key: string,
    expected?: { size: number; checksum: string },
    signal?: AbortSignal,
  ): Promise<{ body: Readable; size: number; contentType?: string }>;
  close(): void;
}
const unavailable = () =>
  new AppError(
    503,
    'REPORT_STORAGE_UNAVAILABLE',
    'Report file storage is temporarily unavailable.',
  );
async function discard(body: GetObjectCommandOutput['Body']) {
  if (body instanceof Readable) body.destroy();
  else await body?.transformToWebStream().cancel();
}
export function createReportExportStore(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE'>,
  options: ReportExportOptions,
  injected?: S3Client,
): ReportExportStore | undefined {
  if (config.DEMO_MODE || !options.AWS_STORAGE_BUCKET_NAME) return undefined;
  const client = injected || createPrivateS3Client(config, options),
    bucket = options.AWS_STORAGE_BUCKET_NAME,
    owner = options.AWS_S3_EXPECTED_BUCKET_OWNER;
  let privateReady: Promise<void> | undefined;
  const scoped = (key: string) => {
    const base = options.S3_REPORT_EXPORT_FOLDER_PATH;
    if (
      !key.startsWith(base + '/') ||
      /[\p{C}\\]/u.test(key) ||
      key.split('/').some((part) => part === '.' || part === '..') ||
      Buffer.byteLength(key, 'utf8') > 1024
    )
      throw new AppError(
        403,
        'EXPORT_FILE_SCOPE_DENIED',
        'This file is outside the approved report location.',
      );
  };
  const keyFor = (folder: string) => {
    z.string()
      .regex(/^[a-z_]{1,32}$/)
      .parse(folder);
    return `${options.S3_REPORT_EXPORT_FOLDER_PATH}/${folder}/orders_${randomUUID().replaceAll('-', '')}.csv`;
  };
  const ensurePrivate = async () => {
    privateReady ??= assertPrivateBucket(client, bucket, AbortSignal.timeout(7000), owner).catch(
      () => {
        throw unavailable();
      },
    );
    const active = privateReady;
    try {
      await active;
    } finally {
      if (privateReady === active) privateReady = undefined;
    }
  };
  async function head(key: string): Promise<ExportObjectInfo | null> {
    scoped(key);
    await ensurePrivate();
    try {
      const value = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key, ExpectedBucketOwner: owner }),
        { abortSignal: AbortSignal.timeout(7000) },
      );
      if (
        value.ContentLength === undefined ||
        !Number.isSafeInteger(value.ContentLength) ||
        value.ContentLength < 0 ||
        value.ContentLength > options.REPORT_EXPORT_MAX_BYTES
      )
        throw unavailable();
      return {
        size: value.ContentLength,
        checksum: value.Metadata?.sha256 || null,
        ...(value.ETag ? { etag: value.ETag } : {}),
        ...(value.ContentType ? { contentType: value.ContentType } : {}),
      };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
        return null;
      throw unavailable();
    }
  }
  return {
    keyFor,
    head,
    async put(key, bytes, checksum) {
      scoped(key);
      if (
        bytes.length > options.REPORT_EXPORT_MAX_BYTES ||
        !/^[a-f0-9]{64}$/.test(checksum) ||
        createHash('sha256').update(bytes).digest('hex') !== checksum
      )
        throw new AppError(
          422,
          'EXPORT_ARTIFACT_INVALID',
          'This export exceeds the file limit or failed integrity validation.',
        );
      await ensurePrivate();
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentLength: bytes.length,
            ContentType: 'text/csv; charset=utf-8',
            ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
            Metadata: { sha256: checksum },
            IfNoneMatch: '*',
            ServerSideEncryption: options.AWS_S3_KMS_KEY_ID ? 'aws:kms' : 'AES256',
            ...(options.AWS_S3_KMS_KEY_ID ? { SSEKMSKeyId: options.AWS_S3_KMS_KEY_ID } : {}),
            ExpectedBucketOwner: owner,
          }),
          { abortSignal: AbortSignal.timeout(12000) },
        );
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
          const existing = await head(key);
          if (existing?.checksum === checksum && existing.size === bytes.length) return;
        }
        throw unavailable();
      }
    },
    async stream(key, expected, signal) {
      const info = await head(key);
      if (!info) throw new AppError(404, 'EXPORT_FILE_NOT_FOUND', 'Report file not found.');
      if (expected && (info.size !== expected.size || info.checksum !== expected.checksum))
        throw new AppError(
          503,
          'EXPORT_FILE_INTEGRITY_FAILED',
          'The report file could not be verified.',
        );
      const bounded = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000);
      let response: GetObjectCommandOutput;
      try {
        response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            IfMatch: info.etag,
            ExpectedBucketOwner: owner,
          }),
          { abortSignal: bounded },
        );
      } catch {
        throw unavailable();
      }
      if (!(response.Body instanceof Readable)) {
        await discard(response.Body);
        throw unavailable();
      }
      const source = response.Body,
        abort = () => source.destroy(unavailable());
      if (bounded.aborted) {
        source.destroy();
        throw unavailable();
      }
      source.on('error', () => {});
      bounded.addEventListener('abort', abort, { once: true });
      const body = Readable.from(
        (async function* () {
          let count = 0;
          const digest = createHash('sha256');
          try {
            for await (const item of source as AsyncIterable<unknown>) {
              const chunk = Buffer.isBuffer(item)
                ? item
                : typeof item === 'string'
                  ? Buffer.from(item)
                  : item instanceof Uint8Array
                    ? Buffer.from(item)
                    : undefined;
              if (!chunk) throw unavailable();
              count += chunk.length;
              if (count > info.size || count > options.REPORT_EXPORT_MAX_BYTES) throw unavailable();
              digest.update(chunk);
              yield chunk;
            }
            if (count !== info.size || (expected && digest.digest('hex') !== expected.checksum))
              throw unavailable();
          } catch {
            throw unavailable();
          } finally {
            bounded.removeEventListener('abort', abort);
            source.destroy();
          }
        })(),
      );
      body.once('close', () => {
        bounded.removeEventListener('abort', abort);
        source.destroy();
      });
      return {
        body,
        size: info.size,
        ...(info.contentType ? { contentType: info.contentType } : {}),
      };
    },
    close() {
      client.destroy();
    },
  };
}
