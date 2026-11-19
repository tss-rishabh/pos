import { randomInt } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { createPrivateS3Client, type PrivateS3Options } from './private-s3-client.js';

/**
 * Storage of uploaded CSV files, as legacy `CsvUpload.filename` (`FileField` on the default
 * S3 storage, `upload_to` `RenameUploadedFile.path_and_rename`, `core/models.py:226-239`).
 */
export interface CsvUploadStorage {
  /** Stores `body` under `key`, or under a suffixed name when taken; returns the stored key. */
  save(key: string, body: Buffer): Promise<string>;
  read(key: string, signal?: AbortSignal): Promise<Buffer>;
}

const unavailable = () =>
  new AppError(503, 'CSV_STORAGE_UNAVAILABLE', 'CSV file storage is unavailable.');
const keyPattern = /^uploads\/csv\/[A-Za-z0-9_.-]{1,200}\.csv$/;
const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** django-storages `get_available_name` with `AWS_S3_FILE_OVERWRITE=False`: `{root}_{7 chars}{ext}`. */
export function alternativeName(key: string): string {
  const dot = key.lastIndexOf('.'),
    suffix = Array.from({ length: 7 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${key.slice(0, dot)}_${suffix}${key.slice(dot)}`;
}

export function createCsvUploadStorage(
  config: Pick<Config, 'NODE_ENV'>,
  options: PrivateS3Options,
  injectedClient?: S3Client,
): CsvUploadStorage | undefined {
  if (!options.AWS_STORAGE_BUCKET_NAME) return undefined;
  const bucket = options.AWS_STORAGE_BUCKET_NAME,
    client = injectedClient || createPrivateS3Client(config, options),
    owner = options.AWS_S3_EXPECTED_BUCKET_OWNER
      ? { ExpectedBucketOwner: options.AWS_S3_EXPECTED_BUCKET_OWNER }
      : {};
  return {
    async save(key, body) {
      let candidate = key;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (!keyPattern.test(candidate)) throw unavailable();
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: candidate,
              Body: body,
              ContentType: 'text/csv',
              IfNoneMatch: '*',
              ServerSideEncryption: options.AWS_S3_KMS_KEY_ID ? 'aws:kms' : 'AES256',
              ...(options.AWS_S3_KMS_KEY_ID ? { SSEKMSKeyId: options.AWS_S3_KMS_KEY_ID } : {}),
              ...owner,
            }),
            { abortSignal: AbortSignal.timeout(10_000) },
          );
          return candidate;
        } catch (error) {
          const status =
            typeof error === 'object' && error !== null && '$metadata' in error
              ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
              : undefined;
          if (status !== 412) throw unavailable();
          candidate = alternativeName(key);
        }
      }
      throw unavailable();
    },
    async read(key, signal) {
      if (!keyPattern.test(key)) throw unavailable();
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key, ...owner }),
          {
            abortSignal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
              : AbortSignal.timeout(30_000),
          },
        );
        if (!response.Body) throw unavailable();
        return Buffer.from(await response.Body.transformToByteArray());
      } catch {
        throw unavailable();
      }
    },
  };
}

/** In-process storage for tests and local development. */
export function memoryCsvUploadStorage(): CsvUploadStorage & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async save(key, body) {
      let candidate = key;
      while (files.has(candidate)) candidate = alternativeName(key);
      files.set(candidate, Buffer.from(body));
      return candidate;
    },
    async read(key) {
      const file = files.get(key);
      if (!file) throw unavailable();
      return file;
    },
  };
}
