import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import {
  assertPrivateBucket,
  createPrivateS3Client,
  validatePrivateS3Options,
} from '../administration/private-s3-client.js';
import type { GiftCardArchiveManifest, GiftCardBatchStorage } from './contracts.js';
import type { GiftCardBatchOptions } from './options.js';
import { maxGiftCardArchiveBytes } from './generation.js';

const unavailable = () =>
  new AppError(
    503,
    'GIFT_CARD_BATCH_STORAGE_UNAVAILABLE',
    'Gift card files are temporarily unavailable.',
  );
export function createGiftCardBatchStorage(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE'>,
  options: GiftCardBatchOptions,
  injected?: S3Client,
): GiftCardBatchStorage | undefined {
  if (
    config.DEMO_MODE ||
    !options.GIFT_CARD_BATCHES_ENABLED ||
    !options.AWS_STORAGE_BUCKET_NAME ||
    !options.S3_GIFT_CARD_BATCH_FOLDER_PATH
  )
    return undefined;
  validatePrivateS3Options(config, options);
  if (
    (config.NODE_ENV === 'production' && !options.AWS_S3_EXPECTED_BUCKET_OWNER) ||
    (options.AWS_S3_KMS_KEY_ID &&
      !/^arn:aws(?:-[a-z]+)*:kms:[a-z0-9-]+:\d{12}:key\/(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$/.test(
        options.AWS_S3_KMS_KEY_ID,
      ))
  )
    throw new AppError(
      503,
      'GIFT_CARD_BATCH_STORAGE_CONFIGURATION_INVALID',
      'Configure the private bucket owner and an exact KMS key ARN.',
    );
  const client = injected || createPrivateS3Client(config, options),
    bucket = options.AWS_STORAGE_BUCKET_NAME,
    prefix = options.S3_GIFT_CARD_BATCH_FOLDER_PATH.replace(/\/+$/, '') + '/';
  const bounded = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  function assertManifest(value: GiftCardArchiveManifest) {
    if (
      !value.key.startsWith(prefix) ||
      !z.uuid().safeParse(value.key.slice(prefix.length, -4)).success ||
      !value.key.endsWith('.zip') ||
      !/^[a-f0-9]{64}$/.test(value.checksum) ||
      !Number.isInteger(value.size) ||
      value.size < 1 ||
      value.size > maxGiftCardArchiveBytes
    )
      throw unavailable();
  }
  async function verify(manifest: GiftCardArchiveManifest, signal: AbortSignal) {
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: manifest.key,
        ExpectedBucketOwner: options.AWS_S3_EXPECTED_BUCKET_OWNER,
        ChecksumMode: 'ENABLED',
      }),
      { abortSignal: signal },
    );
    if (
      head.ContentLength !== manifest.size ||
      head.ContentType !== 'application/zip' ||
      head.ChecksumSHA256 !== Buffer.from(manifest.checksum, 'hex').toString('base64') ||
      head.ServerSideEncryption !== (options.AWS_S3_KMS_KEY_ID ? 'aws:kms' : 'AES256') ||
      (options.AWS_S3_KMS_KEY_ID && head.SSEKMSKeyId !== options.AWS_S3_KMS_KEY_ID)
    )
      throw unavailable();
  }
  return {
    keyFor(id) {
      if (!z.uuid().safeParse(id).success) throw unavailable();
      return prefix + id + '.zip';
    },
    async put(manifest, bytes, signal) {
      assertManifest(manifest);
      if (
        bytes.length !== manifest.size ||
        createHash('sha256').update(bytes).digest('hex') !== manifest.checksum
      )
        throw unavailable();
      const deadline = bounded(signal);
      try {
        await assertPrivateBucket(client, bucket, deadline, options.AWS_S3_EXPECTED_BUCKET_OWNER);
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: manifest.key,
              ExpectedBucketOwner: options.AWS_S3_EXPECTED_BUCKET_OWNER,
              Body: bytes,
              ContentLength: bytes.length,
              ContentType: 'application/zip',
              ChecksumSHA256: Buffer.from(manifest.checksum, 'hex').toString('base64'),
              ServerSideEncryption: options.AWS_S3_KMS_KEY_ID ? 'aws:kms' : 'AES256',
              ...(options.AWS_S3_KMS_KEY_ID ? { SSEKMSKeyId: options.AWS_S3_KMS_KEY_ID } : {}),
              IfNoneMatch: '*',
            }),
            { abortSignal: deadline },
          );
        } catch {
          /* Unknown or conditional PUT results are reconciled against the immutable checksum below. */
        }
        await verify(manifest, deadline);
      } catch {
        throw unavailable();
      }
    },
    async get(manifest, signal) {
      assertManifest(manifest);
      const deadline = bounded(signal);
      try {
        await assertPrivateBucket(client, bucket, deadline, options.AWS_S3_EXPECTED_BUCKET_OWNER);
        await verify(manifest, deadline);
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: manifest.key,
            ExpectedBucketOwner: options.AWS_S3_EXPECTED_BUCKET_OWNER,
            ChecksumMode: 'ENABLED',
          }),
          { abortSignal: deadline },
        );
        if (!(response.Body instanceof Readable)) {
          await response.Body?.transformToWebStream().cancel();
          throw unavailable();
        }
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const raw of response.Body as AsyncIterable<unknown>) {
            if (!(raw instanceof Uint8Array)) throw unavailable();
            const chunk = Buffer.from(raw);
            size += chunk.length;
            if (size > manifest.size || size > maxGiftCardArchiveBytes) throw unavailable();
            chunks.push(chunk);
          }
        } finally {
          response.Body.destroy();
        }
        const bytes = Buffer.concat(chunks);
        if (
          size !== manifest.size ||
          createHash('sha256').update(bytes).digest('hex') !== manifest.checksum
        )
          throw unavailable();
        return bytes;
      } catch {
        throw unavailable();
      }
    },
    close() {
      client.destroy();
    },
  };
}
