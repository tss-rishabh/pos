import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import {
  assertPrivateBucket,
  createPrivateS3Client,
  validatePrivateS3Options,
} from '../administration/private-s3-client.js';
import type { GiftCardBatchStorage } from './contracts.js';
import type { GiftCardBatchOptions } from './options.js';
import { maxGiftCardArchiveBytes } from './generation.js';

const unavailable = () =>
  new AppError(
    503,
    'GIFT_CARD_BATCH_STORAGE_UNAVAILABLE',
    'Gift card files are temporarily unavailable.',
  );
/**
 * Legacy `storage.upload(path_with_filename, bytes)` (helpers/storage.py:26-28) into
 * AWS_STORAGE_BUCKET_NAME. Security decision: the bucket must block public access (the archive
 * holds card codes and PINs), and SSE is requested; legacy performs neither check.
 */
export function createGiftCardBatchStorage(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE'>,
  options: GiftCardBatchOptions,
  injected?: S3Client,
): GiftCardBatchStorage | undefined {
  if (config.DEMO_MODE || !options.AWS_STORAGE_BUCKET_NAME) return undefined;
  validatePrivateS3Options(config, options);
  const client = injected || createPrivateS3Client(config, options),
    bucket = options.AWS_STORAGE_BUCKET_NAME;
  return {
    async upload(key, bytes, signal) {
      if (
        !/^uploads\/csv\/giftcards\/GFTCRDS-\d+\.zip$/.test(key) ||
        bytes.length < 1 ||
        bytes.length > maxGiftCardArchiveBytes
      )
        throw unavailable();
      const deadline = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000);
      try {
        await assertPrivateBucket(client, bucket, deadline, options.AWS_S3_EXPECTED_BUCKET_OWNER);
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ExpectedBucketOwner: options.AWS_S3_EXPECTED_BUCKET_OWNER,
            Body: bytes,
            ContentLength: bytes.length,
            ServerSideEncryption: options.AWS_S3_KMS_KEY_ID ? 'aws:kms' : 'AES256',
            ...(options.AWS_S3_KMS_KEY_ID ? { SSEKMSKeyId: options.AWS_S3_KMS_KEY_ID } : {}),
          }),
          { abortSignal: deadline },
        );
      } catch {
        throw unavailable();
      }
    },
    close() {
      client.destroy();
    },
  };
}
