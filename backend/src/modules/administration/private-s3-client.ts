import { S3Client, GetPublicAccessBlockCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export function readPrivateS3Options(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      AWS_STORAGE_BUCKET_NAME: optional(z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)),
      AWS_S3_REGION_NAME: z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .default(env.AWS_REGION || 'ap-south-1'),
      AWS_S3_ENDPOINT_URL: optional(z.url()),
      AWS_S3_KMS_KEY_ID: optional(z.string().min(1).max(2048)),
      AWS_S3_EXPECTED_BUCKET_OWNER: optional(z.string().regex(/^\d{12}$/)),
      AWS_S3_PRESIGNED_URL_EXPIRY: z.coerce.number().int().min(60).max(3600).default(3600),
    })
    .parse(env);
}
export type PrivateS3Options = ReturnType<typeof readPrivateS3Options>;
/** New private writes require all bucket-level public-access protections. No SDK errors escape. */
export async function assertPrivateBucket(
  client: S3Client,
  bucket: string,
  signal?: AbortSignal,
  expectedBucketOwner?: string,
): Promise<void> {
  if (expectedBucketOwner !== undefined && !/^\d{12}$/.test(expectedBucketOwner))
    throw new AppError(
      503,
      'PRIVATE_STORAGE_CONFIGURATION_INVALID',
      'Configure an approved private bucket owner.',
    );
  try {
    const response = await client.send(
      new GetPublicAccessBlockCommand({
        Bucket: bucket,
        ...(expectedBucketOwner ? { ExpectedBucketOwner: expectedBucketOwner } : {}),
      }),
      {
        abortSignal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(7000)])
          : AbortSignal.timeout(7000),
      },
    );
    const policy = response.PublicAccessBlockConfiguration;
    if (
      policy?.BlockPublicAcls !== true ||
      policy.IgnorePublicAcls !== true ||
      policy.BlockPublicPolicy !== true ||
      policy.RestrictPublicBuckets !== true
    )
      throw new AppError(
        503,
        'PRIVATE_STORAGE_NOT_PRIVATE',
        'Private storage protections are unavailable.',
      );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      503,
      'PRIVATE_STORAGE_UNAVAILABLE',
      'Private storage could not be verified.',
    );
  }
}
export function validatePrivateS3Options(
  config: Pick<Config, 'NODE_ENV'>,
  options: Pick<PrivateS3Options, 'AWS_S3_ENDPOINT_URL'>,
): void {
  const endpoint = options.AWS_S3_ENDPOINT_URL ? new URL(options.AWS_S3_ENDPOINT_URL) : undefined;
  const local = !!endpoint && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    endpoint &&
    (endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && local && endpoint.protocol === 'http:')))
  )
    throw new AppError(
      503,
      'PRIVATE_STORAGE_CONFIGURATION_INVALID',
      'Configure an approved private object storage endpoint.',
    );
}
/** Default credential chain, bounded sockets/timeouts and no SDK request/payload logging. */
export function createPrivateS3Client(
  config: Pick<Config, 'NODE_ENV'>,
  options: Pick<PrivateS3Options, 'AWS_S3_REGION_NAME' | 'AWS_S3_ENDPOINT_URL'>,
): S3Client {
  validatePrivateS3Options(config, options);
  return new S3Client({
    region: options.AWS_S3_REGION_NAME,
    endpoint: options.AWS_S3_ENDPOINT_URL,
    maxAttempts: 2,
    followRegionRedirects: false,
    requestHandler: {
      requestTimeout: 5000,
      connectionTimeout: 1000,
      httpsAgent: { keepAlive: true, maxSockets: 16 },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
