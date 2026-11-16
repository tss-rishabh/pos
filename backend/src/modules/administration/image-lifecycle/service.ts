import { and, count, eq, gt } from 'drizzle-orm';
import type { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { retryTransaction } from '../../../db/retry.js';
import { AppError } from '../../../domain/errors.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { uploadInput } from '../media-domain.js';
import { lockAdministrationRegistry } from '../locks.js';
import type { DocumentationMediaStore, ReservedMedia } from '../media-storage.js';
import { verifyPrivateImage } from './validation.js';
import {
  imageKind,
  type ImageContext,
  type ImageKind,
  type ImageOwnerAdapter,
  type imageReservationInput,
} from './domain.js';
import type { ImageTables, ImageUpload } from './schema.js';

function specification(upload: ImageUpload): ReservedMedia {
  return {
    ...uploadInput.parse({
      id: upload.id,
      kind: upload.kind,
      name: 'private-image',
      contentType: upload.contentType,
      size: upload.size,
      checksum: upload.checksum,
    }),
    objectKey: upload.objectKey,
    expiresAt: upload.expiresAt.toISOString().replace('T', ' ').replace('Z', ''),
  };
}
/** One reservation/verification/attachment lifecycle for independently authorized image owners. */
export function ownedImageService(
  db: Databases,
  tables: ImageTables,
  owner: ImageOwnerAdapter,
  media: DocumentationMediaStore | undefined,
  now: () => number = Date.now,
) {
  const { uploads, jobs } = tables;
  const fail = (status: number, suffix: string, message: string) =>
    new AppError(status, `${owner.errorPrefix}_${suffix}`, message);
  const changed = () =>
    fail(409, 'CHANGED', `Reload ${owner.subject} before choosing the image again.`);
  const expired = () => fail(409, 'UPLOAD_EXPIRED', 'Choose the image again.');
  const required = () => {
    if (!media) throw fail(503, 'STORAGE_UNAVAILABLE', 'Private images are currently unavailable.');
    return media;
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
  async function uploadFor(context: ImageContext, id: string) {
    const [upload] = await db
      .get('writer')
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, id), eq(uploads.ownerId, owner.reservationOwner(context))))
      .limit(1);
    if (!upload) throw fail(404, 'UPLOAD_NOT_FOUND', 'This upload was not found.');
    return upload;
  }
  async function queue(
    tx: Parameters<ImageOwnerAdapter['write']>[0],
    upload: ImageUpload,
    userId: string,
    availableAt: number,
  ) {
    await tx.insert(jobs).values({
      id: crypto.randomUUID(),
      uploadId: upload.id,
      ownerId: userId,
      requestId: currentRequestTrace()?.requestId || null,
      state: 'pending',
      attempts: 0,
      availableAt: new Date(availableAt),
      createdAt: new Date(now()),
    });
  }
  return {
    async reserve(context: ImageContext, input: z.infer<typeof imageReservationInput>) {
      const store = required(),
        kind = imageKind.parse(input.upload.kind);
      if (!owner.kinds.includes(kind))
        throw fail(400, 'IMAGE_KIND_INVALID', 'Choose a supported image kind.');
      const key = store.keyFor(input.upload);
      if (key.length > 254 || !owner.allowsKey(kind, key) || !owner.allowsCleanupKey(key))
        throw fail(400, 'IMAGE_KEY_INVALID', 'Choose the image again.');
      const upload = await retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockAdministrationRegistry(tx, owner.registry);
          const account = await owner.authorize(tx, context, 'publish');
          if (account.revision !== input.revision) throw changed();
          const [previous] = await tx
            .select()
            .from(uploads)
            .where(eq(uploads.id, input.upload.id))
            .limit(1)
            .for('update');
          if (previous) {
            if (previous.ownerId !== owner.reservationOwner(context))
              throw fail(404, 'UPLOAD_NOT_FOUND', 'This upload was not found.');
            if (previous.state !== 'reserved' || previous.expiresAt.getTime() - now() < 60000)
              throw expired();
            if (
              previous.objectKey !== key ||
              previous.kind !== kind ||
              previous.contentType !== input.upload.contentType ||
              previous.checksum !== input.upload.checksum ||
              previous.size !== input.upload.size ||
              previous.ownerRevision !== input.revision
            )
              throw fail(409, 'UPLOAD_CHANGED', 'Choose the image again.');
            return previous;
          }
          const [pending] = await tx
            .select({ count: count() })
            .from(uploads)
            .where(
              and(
                eq(uploads.ownerId, owner.reservationOwner(context)),
                eq(uploads.state, 'reserved'),
                gt(uploads.expiresAt, new Date(now())),
              ),
            );
          if (pending && pending.count >= 5)
            throw fail(
              429,
              'UPLOAD_LIMIT',
              'Finish an existing image upload before starting another.',
            );
          const value: ImageUpload = {
            id: input.upload.id,
            ownerId: owner.reservationOwner(context),
            kind,
            objectKey: key,
            contentType: input.upload.contentType,
            size: input.upload.size,
            checksum: input.upload.checksum,
            ownerRevision: input.revision,
            state: 'reserved',
            createdAt: new Date(now()),
            expiresAt: new Date(now() + 15 * 60000),
            attachedAt: null,
          };
          await tx.insert(uploads).values(value);
          await queue(tx, value, context.user.id, value.expiresAt.getTime() + 60000);
          return value;
        }),
      );
      return {
        id: upload.id,
        expiresAt: upload.expiresAt.getTime(),
        ...(await storageCall(() => store.upload(specification(upload)))),
      };
    },
    async attach(context: ImageContext, id: string, expectedRevision: string) {
      const store = required(),
        upload = await uploadFor(context, id),
        kind = imageKind.parse(upload.kind),
        currentOwner = await state(context, 'attach');
      if (!owner.kinds.includes(kind))
        throw fail(400, 'IMAGE_KIND_INVALID', 'Choose a supported image kind.');
      if (upload.state === 'attached') {
        if (currentOwner.keys[kind] === upload.objectKey) return;
        throw fail(409, 'UPLOAD_REPLACED', 'This image has already been replaced.');
      }
      if (upload.state !== 'reserved' || upload.expiresAt.getTime() <= now()) throw expired();
      if (upload.ownerRevision !== expectedRevision || currentOwner.revision !== expectedRevision)
        throw changed();
      await storageCall(() => store.verify(specification(upload)));
      await verifyPrivateImage(
        () =>
          storageCall(() =>
            store.stream(upload.objectKey, kind, undefined, AbortSignal.timeout(7000)),
          ),
        { contentType: upload.contentType, size: upload.size, checksum: upload.checksum },
        owner.errorPrefix,
      );
      await retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockAdministrationRegistry(tx, owner.registry);
          const account = await owner.authorize(tx, context, 'publish');
          const [current] = await tx
            .select()
            .from(uploads)
            .where(eq(uploads.id, id))
            .limit(1)
            .for('update');
          if (!current || current.ownerId !== owner.reservationOwner(context))
            throw fail(404, 'UPLOAD_NOT_FOUND', 'This upload was not found.');
          if (current.state === 'attached' && account.keys[kind] === current.objectKey) return;
          if (current.state !== 'reserved' || current.expiresAt.getTime() <= now()) throw expired();
          if (current.ownerRevision !== expectedRevision || account.revision !== expectedRevision)
            throw changed();
          const oldKey = account.keys[kind],
            [previous] = oldKey
              ? await tx.select().from(uploads).where(eq(uploads.objectKey, oldKey)).limit(1)
              : [];
          await owner.write(tx, context, kind, current.objectKey);
          await tx
            .update(uploads)
            .set({ state: 'attached', attachedAt: new Date(now()) })
            .where(eq(uploads.id, id));
          // Only this lifecycle's generated uploads can be scheduled, never arbitrary/default keys.
          if (previous && previous.objectKey !== current.objectKey) {
            const [pending] = await tx
              .select({ id: jobs.id })
              .from(jobs)
              .where(and(eq(jobs.uploadId, previous.id), eq(jobs.state, 'pending')))
              .limit(1)
              .for('update');
            if (!pending)
              await queue(
                tx,
                previous,
                context.user.id,
                Math.max(now() + 60000, previous.expiresAt.getTime() + 60000),
              );
          }
        }),
      );
    },
    async stream(context: ImageContext, kind: ImageKind, signal?: AbortSignal) {
      const store = required(),
        account = await state(context),
        key = account.keys[kind];
      if (!owner.kinds.includes(kind) || !key || !owner.allowsKey(kind, key))
        throw fail(404, 'IMAGE_NOT_FOUND', 'This image is unavailable.');
      const object = await storageCall(() => store.stream(key, kind, undefined, signal));
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
