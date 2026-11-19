import { Readable } from 'node:stream';
import { Temporal } from '@js-temporal/polyfill';
import {
  type S3Client,
  S3ServiceException,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import {
  readPrivateS3Options,
  validatePrivateS3Options,
  createPrivateS3Client,
  assertPrivateBucket,
  type PrivateS3Options,
} from './private-s3-client.js';
import { mediaMagicMatches, mediaTypes, type MediaKind, type UploadInput } from './media-domain.js';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export function readDocumentationMediaOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...readPrivateS3Options(env),
    ...z
      .object({
        S3_TUTORIAL_FOLDER_PATH: optional(
          z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,299}$/)
            .refine((value) => !value.split('/').some((part) => part === '.' || part === '..')),
        ),
      })
      .parse(env),
  };
}
export type DocumentationMediaOptions = ReturnType<typeof readDocumentationMediaOptions>;
export interface ReservedMedia extends UploadInput {
  objectKey: string;
  expiresAt: string;
}
export interface DocumentationMediaStore {
  keyFor(input: UploadInput): string;
  assertKey(key: string): void;
  upload(specification: ReservedMedia): Promise<{ url: string; fields: Record<string, string> }>;
  verify(specification: ReservedMedia): Promise<void>;
  stream(
    key: string,
    kind: MediaKind,
    range?: string,
    signal?: AbortSignal,
  ): Promise<{
    body: Readable;
    contentType: string;
    size?: number;
    contentRange?: string;
    etag?: string;
  }>;
  remove(key: string, signal?: AbortSignal): Promise<void>;
  close(): void;
}
const directories: Record<MediaKind, string> = {
  'cover-image': 'cover_images',
  image: 'uploaded-images',
  video: 'uploaded-video',
  document: 'uploaded-documents',
};
const unavailable = () =>
  new AppError(503, 'DOCUMENTATION_STORAGE_UNAVAILABLE', 'Guide attachments are unavailable.');
async function nodeBody(body: GetObjectCommandOutput['Body']): Promise<Readable> {
  if (body instanceof Readable) return body;
  await body?.transformToWebStream().cancel();
  throw unavailable();
}
export function mediaContentTypeFromKey(key: string): string {
  const extension = key.split('.').at(-1)?.toLowerCase();
  return (
    Object.entries(mediaTypes).find(([, type]) => type.extension === extension)?.[0] ||
    'application/octet-stream'
  );
}
export function createDocumentationMediaStore(
  config: Pick<Config, 'NODE_ENV'>,
  options: DocumentationMediaOptions,
  injectedClient?: S3Client,
): DocumentationMediaStore | undefined {
  if (!options.AWS_STORAGE_BUCKET_NAME || !options.S3_TUTORIAL_FOLDER_PATH) return undefined;
  return createScopedMediaStore(
    config,
    options,
    options.S3_TUTORIAL_FOLDER_PATH,
    directories,
    injectedClient,
  );
}
/** Shared private upload/verification/stream/delete mechanics; callers own authorization/reservations. */
export function createScopedMediaStore(
  config: Pick<Config, 'NODE_ENV'>,
  options: PrivateS3Options,
  objectPrefix: string,
  paths: Readonly<Partial<Record<MediaKind, string>>>,
  injectedClient?: S3Client,
): DocumentationMediaStore | undefined {
  if (!options.AWS_STORAGE_BUCKET_NAME) return undefined;
  const validPath = (value: string) =>
    /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,299}$/.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..');
  if (!validPath(objectPrefix) || Object.values(paths).some((value) => !validPath(value)))
    throw new AppError(
      503,
      'PRIVATE_MEDIA_SCOPE_INVALID',
      'Configure an approved private media location.',
    );
  validatePrivateS3Options(config, options);
  const prefix = objectPrefix.replace(/\/+$/, '') + '/',
    bucket = options.AWS_STORAGE_BUCKET_NAME;
  const client = injectedClient || createPrivateS3Client(config, options);
  function assertKey(key: string) {
    if (
      !key.startsWith(prefix) ||
      /[\p{C}\\]/u.test(key) ||
      key.split('/').some((part) => part === '.' || part === '..') ||
      Buffer.byteLength(key, 'utf8') > 1024
    )
      throw new AppError(
        403,
        'DOCUMENTATION_ASSET_SCOPE_DENIED',
        'This attachment is outside the guide media location.',
      );
  }
  return {
    assertKey,
    keyFor(input) {
      const directory = paths[input.kind];
      if (!directory)
        throw new AppError(
          400,
          'PRIVATE_MEDIA_KIND_INVALID',
          'Choose a supported attachment type.',
        );
      const key = `${prefix}${directory}/${input.id}.${mediaTypes[input.contentType].extension}`;
      assertKey(key);
      return key;
    },
    async upload(specification) {
      assertKey(specification.objectKey);
      const expiry = Temporal.PlainDateTime.from(specification.expiresAt.replace(' ', 'T'))
        .toZonedDateTime('UTC')
        .toInstant();
      const seconds = Math.floor((expiry.epochMilliseconds - Date.now()) / 1000);
      if (seconds < 60)
        throw new AppError(
          409,
          'DOCUMENTATION_UPLOAD_EXPIRED',
          'Choose the file again to renew its upload.',
        );
      const fields: Record<string, string> = {
        'Content-Type': specification.contentType,
        'x-amz-checksum-algorithm': 'SHA256',
        'x-amz-checksum-sha256': specification.checksum,
        'x-amz-server-side-encryption': options.AWS_S3_KMS_KEY_ID ? 'aws:kms' : 'AES256',
        success_action_status: '204',
        ...(options.AWS_S3_KMS_KEY_ID
          ? { 'x-amz-server-side-encryption-aws-kms-key-id': options.AWS_S3_KMS_KEY_ID }
          : {}),
      };
      try {
        await assertPrivateBucket(client, bucket, undefined, options.AWS_S3_EXPECTED_BUCKET_OWNER);
        return await createPresignedPost(client, {
          Bucket: bucket,
          Key: specification.objectKey,
          Expires: Math.min(seconds, 900, options.AWS_S3_PRESIGNED_URL_EXPIRY),
          Fields: fields,
          Conditions: [
            ['content-length-range', specification.size, specification.size],
            ...Object.entries(fields).map(([name, value]) => ({ [name]: value })),
          ],
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw unavailable();
      }
    },
    async verify(specification) {
      assertKey(specification.objectKey);
      const signal = AbortSignal.timeout(7000);
      try {
        const head = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: specification.objectKey,
            ExpectedBucketOwner: options.AWS_S3_EXPECTED_BUCKET_OWNER,
            ChecksumMode: 'ENABLED',
          }),
          { abortSignal: signal },
        );
        if (
          head.ContentLength !== specification.size ||
          head.ContentType !== specification.contentType ||
          head.ChecksumSHA256 !== specification.checksum
        )
          throw new AppError(
            400,
            'DOCUMENTATION_UPLOAD_MISMATCH',
            'The uploaded file does not match its reservation.',
          );
        const sample = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: specification.objectKey,
            ExpectedBucketOwner: options.AWS_S3_EXPECTED_BUCKET_OWNER,
            Range: 'bytes=0-31',
          }),
          { abortSignal: signal },
        );
        const body = await nodeBody(sample.Body),
          parts: Buffer[] = [];
        let size = 0;
        try {
          for await (const value of body) {
            const chunk: unknown = value;
            if (!(chunk instanceof Uint8Array) || size + chunk.length > 32)
              throw new AppError(
                400,
                'DOCUMENTATION_MEDIA_INVALID',
                'The file content is not supported.',
              );
            size += chunk.length;
            parts.push(Buffer.from(chunk));
          }
        } finally {
          body.destroy();
        }
        if (!mediaMagicMatches(specification.contentType, Buffer.concat(parts)))
          throw new AppError(
            400,
            'DOCUMENTATION_MEDIA_INVALID',
            'The file content does not match its attachment type.',
          );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          400,
          'DOCUMENTATION_UPLOAD_INCOMPLETE',
          'Upload the file before adding it to this guide.',
        );
      }
    },
    async stream(key, _kind, range, signal) {
      assertKey(key);
      try {
        const object = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ExpectedBucketOwner: options.AWS_S3_EXPECTED_BUCKET_OWNER,
            ...(range ? { Range: range } : {}),
          }),
          { abortSignal: signal },
        );
        return {
          body: await nodeBody(object.Body),
          contentType: mediaContentTypeFromKey(key),
          ...(Number.isSafeInteger(object.ContentLength) ? { size: object.ContentLength } : {}),
          ...(object.ContentRange && /^bytes \d+-\d+\/\d+$/.test(object.ContentRange)
            ? { contentRange: object.ContentRange }
            : {}),
          ...(object.ETag && /^"[a-f0-9-]{1,128}"$/i.test(object.ETag)
            ? { etag: object.ETag }
            : {}),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 416)
          throw new AppError(
            416,
            'DOCUMENTATION_RANGE_INVALID',
            'Choose a valid attachment range.',
          );
        throw new AppError(
          404,
          'DOCUMENTATION_ATTACHMENT_NOT_FOUND',
          'This guide attachment is unavailable.',
        );
      }
    },
    async remove(key, signal) {
      assertKey(key);
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
            ExpectedBucketOwner: options.AWS_S3_EXPECTED_BUCKET_OWNER,
          }),
          {
            abortSignal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(7000)])
              : AbortSignal.timeout(7000),
          },
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
