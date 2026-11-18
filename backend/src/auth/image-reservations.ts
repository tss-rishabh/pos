import { z } from 'zod';
import type { Databases } from '../db/pools.js';
import { retryTransaction } from '../db/retry.js';
import { AppError } from '../domain/errors.js';
import type { RedisPort } from '../redis/port.js';
import { uploadInput } from '../modules/administration/media-domain.js';
import type {
  DocumentationMediaStore,
  ReservedMedia,
} from '../modules/administration/media-storage.js';
import { verifyPrivateImage } from '../modules/administration/image-lifecycle/validation.js';
import {
  imageKind,
  type ImageContext,
  type ImageKind,
  type ImageOwnerAdapter,
  type imageReservationInput,
} from '../modules/administration/image-lifecycle/domain.js';
import { authKeys } from './keys.js';

/**
 * Operator profile/cover images, as legacy stores them: the object path in
 * `pos_user.profile_image` / `cover_image`, written synchronously (users/views.py:297-308).
 * The signed browser upload is reserved in Redis (`pos:profile_upload:{uploadId}`) instead
 * of `pos_rewrite_profile_uploads`; legacy never deletes replaced files, so there is no
 * cleanup job. The upload is still checked to be a real image, as Django's ImageField does.
 */
const RESERVATION_SECONDS = 15 * 60;
const GRACE_SECONDS = 60;
const reservation = z
  .object({
    ownerId: z.string().min(1).max(64),
    kind: imageKind,
    objectKey: z.string().min(1).max(254),
    contentType: z.string().max(64),
    size: z.number().int().positive(),
    checksum: z.string().max(44),
    ownerRevision: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type Reservation = z.infer<typeof reservation>;
function specification(id: string, upload: Reservation): ReservedMedia {
  return {
    ...uploadInput.parse({
      id,
      kind: upload.kind,
      name: 'private-image',
      contentType: upload.contentType,
      size: upload.size,
      checksum: upload.checksum,
    }),
    objectKey: upload.objectKey,
    expiresAt: new Date(upload.expiresAt).toISOString().replace('T', ' ').replace('Z', ''),
  };
}
export function redisImageService(
  db: Databases,
  redis: RedisPort | undefined,
  owner: ImageOwnerAdapter,
  media: DocumentationMediaStore | undefined,
  now: () => number = Date.now,
) {
  const fail = (status: number, suffix: string, message: string) =>
    new AppError(status, `${owner.errorPrefix}_${suffix}`, message);
  const changed = () =>
    fail(409, 'CHANGED', `Reload ${owner.subject} before choosing the image again.`);
  const expired = () => fail(409, 'UPLOAD_EXPIRED', 'The upload expired. Choose the image again.');
  const required = () => {
    if (!media || !redis)
      throw fail(503, 'STORAGE_UNAVAILABLE', 'Private images are currently unavailable.');
    return { store: media, cache: redis };
  };
  async function storageCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof AppError)
        throw fail(
          error.status,
          error.code.replace(/^(?:DOCUMENTATION|PROFILE|PRIVATE)_/, ''),
          'The image could not be processed. Choose a supported file or try again.',
        );
      throw fail(503, 'STORAGE_UNAVAILABLE', 'Private images are currently unavailable.');
    }
  }
  const state = (context: ImageContext, mode: 'read' | 'attach' = 'read') =>
    db.get('writer').transaction((tx) => owner.authorize(tx, context, mode));
  async function read(cache: RedisPort, context: ImageContext, id: string) {
    const raw = await cache.get(authKeys.profileUpload(id));
    let parsed: Reservation | undefined;
    try {
      parsed = raw ? reservation.parse(JSON.parse(raw)) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!parsed || parsed.ownerId !== owner.reservationOwner(context))
      throw fail(404, 'UPLOAD_NOT_FOUND', 'This upload was not found or has expired.');
    return parsed;
  }
  return {
    async reserve(context: ImageContext, input: z.infer<typeof imageReservationInput>) {
      const { store, cache } = required(),
        kind = imageKind.parse(input.upload.kind);
      if (!owner.kinds.includes(kind))
        throw fail(400, 'IMAGE_KIND_INVALID', 'Choose a supported image kind.');
      const key = store.keyFor(input.upload);
      if (key.length > 254 || !owner.allowsKey(kind, key) || !owner.allowsCleanupKey(key))
        throw fail(400, 'IMAGE_KEY_INVALID', 'Choose the image again.');
      const account = await state(context, 'attach');
      if (account.revision !== input.revision) throw changed();
      const value: Reservation = {
        ownerId: owner.reservationOwner(context),
        kind,
        objectKey: key,
        contentType: input.upload.contentType,
        size: input.upload.size,
        checksum: input.upload.checksum,
        ownerRevision: input.revision,
        expiresAt: now() + RESERVATION_SECONDS * 1000,
      };
      let upload = value;
      if (
        !(await cache.set(authKeys.profileUpload(input.upload.id), JSON.stringify(value), {
          EX: RESERVATION_SECONDS + GRACE_SECONDS,
          NX: true,
        }))
      ) {
        // An idempotent retry of the same reservation gets a fresh signed form.
        const previous = await read(cache, context, input.upload.id);
        if (
          previous.objectKey !== key ||
          previous.kind !== kind ||
          previous.contentType !== value.contentType ||
          previous.checksum !== value.checksum ||
          previous.size !== value.size ||
          previous.ownerRevision !== input.revision
        )
          throw fail(409, 'UPLOAD_CHANGED', 'Choose the image again.');
        if (previous.expiresAt - now() < 60000) throw expired();
        upload = previous;
      }
      return {
        id: input.upload.id,
        expiresAt: upload.expiresAt,
        ...(await storageCall(() => store.upload(specification(input.upload.id, upload)))),
      };
    },
    async attach(context: ImageContext, id: string, expectedRevision: string) {
      const { store, cache } = required(),
        upload = await read(cache, context, id),
        current = await state(context, 'attach');
      if (!owner.kinds.includes(upload.kind))
        throw fail(400, 'IMAGE_KIND_INVALID', 'Choose a supported image kind.');
      if (current.keys[upload.kind] === upload.objectKey) return;
      if (upload.expiresAt <= now()) throw expired();
      if (upload.ownerRevision !== expectedRevision || current.revision !== expectedRevision)
        throw changed();
      await storageCall(() => store.verify(specification(id, upload)));
      await verifyPrivateImage(
        () =>
          storageCall(() =>
            store.stream(upload.objectKey, upload.kind, undefined, AbortSignal.timeout(7000)),
          ),
        { contentType: upload.contentType, size: upload.size, checksum: upload.checksum },
        owner.errorPrefix,
      );
      await retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const account = await owner.authorize(tx, context, 'publish');
          if (account.keys[upload.kind] === upload.objectKey) return;
          if (account.revision !== expectedRevision) throw changed();
          await owner.write(tx, context, upload.kind, upload.objectKey);
        }),
      );
      await cache.del([authKeys.profileUpload(id)]);
    },
    async stream(context: ImageContext, kind: ImageKind, signal?: AbortSignal) {
      if (!media)
        throw fail(503, 'STORAGE_UNAVAILABLE', 'Private images are currently unavailable.');
      const account = await state(context),
        key = account.keys[kind];
      if (!owner.kinds.includes(kind) || !key || !owner.allowsKey(kind, key))
        throw fail(404, 'IMAGE_NOT_FOUND', 'This image is unavailable.');
      const object = await storageCall(() => media.stream(key, kind, undefined, signal));
      if (
        !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(object.contentType) ||
        !Number.isSafeInteger(object.size) ||
        !object.size ||
        object.size < 1 ||
        object.size > 10 * 1024 * 1024
      ) {
        object.body.destroy();
        throw fail(413, 'IMAGE_INVALID', 'This image is unavailable.');
      }
      return object;
    },
    state,
  };
}
