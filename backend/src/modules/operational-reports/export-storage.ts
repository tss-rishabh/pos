import { createHash } from 'node:crypto';
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
import type { ClosedExportFile } from './export-artifact.js';
import {
  reportFileContentType,
  reportFileExtension,
  type ReportFileFormat,
} from './export-format.js';

const prefix = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,299}$/)
  .transform((value) => value.replace(/\/+$/, ''));
const boolean = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
export function reportExportOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...readPrivateS3Options(env),
    ...z
      .object({
        S3_REPORT_EXPORT_FOLDER_PATH: prefix.default('uploads/reports/pos-rewrite'),
        S3_LEGACY_REPORT_EXPORT_FOLDER_PATH: prefix.default('uploads/reports'),
        REPORT_EXPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(268435456).default(67108864),
        REPORT_EXPORT_WORKER_ENABLED: boolean,
        REPORT_EXPORT_WORKER_INTERVAL_MS: z.coerce
          .number()
          .int()
          .min(1000)
          .max(60000)
          .default(3000),
        REPORT_EXPORT_MAX_PENDING_PER_USER: z.coerce.number().int().min(1).max(10).default(3),
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
  keyFor(jobId: string, format?: ReportFileFormat): string;
  put(jobId: string, bytes: Buffer, checksum: string): Promise<void>;
  putArtifact?(
    jobId: string,
    file: ClosedExportFile,
    format: ReportFileFormat,
    signal?: AbortSignal,
  ): Promise<void>;
  head(key: string, legacy?: boolean): Promise<ExportObjectInfo | null>;
  stream(
    key: string,
    expected?: { size: number; checksum: string },
    legacy?: boolean,
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
  const scoped = (key: string, legacy = false) => {
    const base = legacy
      ? options.S3_LEGACY_REPORT_EXPORT_FOLDER_PATH
      : options.S3_REPORT_EXPORT_FOLDER_PATH;
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
  const keyFor = (jobId: string, format: ReportFileFormat = 'CSV') => {
    z.uuid().parse(jobId);
    return `${options.S3_REPORT_EXPORT_FOLDER_PATH}/${jobId}.${reportFileExtension(format)}`;
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
  async function head(key: string, legacy = false): Promise<ExportObjectInfo | null> {
    scoped(key, legacy);
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
    async put(jobId, bytes, checksum) {
      const key = keyFor(jobId);
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
    async putArtifact(jobId, file, format, signal) {
      const key = keyFor(jobId, format);
      scoped(key);
      if (
        !Number.isSafeInteger(file.byteCount) ||
        file.byteCount <= 0 ||
        file.byteCount > options.REPORT_EXPORT_MAX_BYTES ||
        !/^[a-f0-9]{64}$/.test(file.checksum)
      )
        throw new AppError(
          422,
          'EXPORT_ARTIFACT_INVALID',
          'This export failed file integrity validation.',
        );
      await ensurePrivate();
      const bounded = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000);
      const source = await file.open(bounded);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: source,
            ContentLength: file.byteCount,
            ContentType: reportFileContentType(format),
            ChecksumSHA256: Buffer.from(file.checksum, 'hex').toString('base64'),
            Metadata: { sha256: file.checksum },
            IfNoneMatch: '*',
            ServerSideEncryption: options.AWS_S3_KMS_KEY_ID ? 'aws:kms' : 'AES256',
            ...(options.AWS_S3_KMS_KEY_ID ? { SSEKMSKeyId: options.AWS_S3_KMS_KEY_ID } : {}),
            ExpectedBucketOwner: owner,
          }),
          { abortSignal: bounded },
        );
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
          const existing = await head(key);
          if (
            existing?.checksum === file.checksum &&
            existing.size === file.byteCount &&
            (!existing.contentType || existing.contentType === reportFileContentType(format))
          )
            return;
        }
        throw unavailable();
      } finally {
        source.destroy();
      }
    },
    async stream(key, expected, legacy = false, signal) {
      const info = await head(key, legacy);
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
