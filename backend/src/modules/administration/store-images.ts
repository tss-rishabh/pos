import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { requireRole, requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { assertCurrentOperatorRole, assertCurrentStoreAccess } from './authorization.js';
import type { AdministrationTransaction } from './checkins.js';
import { administrationEphemeralStore } from './ephemeral-runtime.js';
import { verifyPrivateImage } from './image-lifecycle/validation.js';
import { mediaTypes, uploadInput } from './media-domain.js';
import { createScopedMediaStore, type DocumentationMediaStore } from './media-storage.js';
import type { PrivateS3Options } from './private-s3-client.js';

/**
 * Store image of the legacy store form (`stores/forms.py:80`, `_form.html:376-389`): chosen in
 * the same create/edit form and saved with it into `stores.store_image`. The browser uploads to
 * private storage first; the reservation lives in Redis `pos:store_image_upload:{uploadId}`
 * (15 min) and is consumed when the form is saved. Replaced images are never deleted, as legacy.
 */
export const storeImageUploadKey = (id: string) => `pos:store_image_upload:${id}`;
export const storeImageReservationInput = z
  .object({
    storeId: identifier.optional(),
    upload: uploadInput.refine((input) => input.kind === 'image', 'Choose a store image.'),
  })
  .strict();
export interface StoreImageOptions {
  storeImageStore?: DocumentationMediaStore;
}
/** Django `ImageField` message (`forms.ImageField.default_error_messages['invalid_image']`). */
export const invalidStoreImage =
  'Upload a valid image. The file you uploaded was either not an image or a corrupted image.';
const imagePath = /^uploads\/stores\/stores_image\/[^/]+\.(?:jpg|jpeg|png|gif|webp)$/i;
const reservation = z
  .object({
    id: z.uuid(),
    actorId: z.string(),
    storeId: z.string().nullable(),
    objectKey: z.string(),
    contentType: z.string(),
    size: z.number().int(),
    checksum: z.string(),
    expiresAt: z.number(),
  })
  .strict();
type Reservation = z.infer<typeof reservation>;
export class StoreImageInvalid extends AppError {
  constructor() {
    super(400, 'STORE_IMAGE_INVALID', invalidStoreImage);
  }
}
const fileBase = (name: string) =>
  name
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'store_image';

/** Current store authority for image reads and uploads (role, store scope, franchise scope). */
async function authorizeStore(
  tx: AdministrationTransaction,
  user: Principal,
  storeId: string,
  mode: 'read' | 'write',
) {
  const roles = mode === 'read' ? ([1, 2, 3] as const) : ([1, 3] as const);
  requireRole(user, [...roles]);
  requireStore(user, storeId);
  await assertCurrentStoreAccess(tx, user.id, storeId, roles, 'share');
  const [row] = await tx
    .select()
    .from(Store)
    .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
    .limit(1);
  if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'An active store was not found.');
  const [actor] = await tx
    .select({ userType: PosUser.user_type, role: PosUser.role })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1);
  if (
    !actor ||
    ![1, 2].includes(actor.userType) ||
    (actor.userType === 2 && row.category !== 'FRANCHISE')
  )
    throw new AppError(403, 'STORE_IMAGE_SCOPE_DENIED', 'This store is outside your organization.');
  if (actor.userType === 2 && actor.role === 1) {
    const [assignment] = await tx
      .select({ id: UserStore.id })
      .from(UserStore)
      .where(and(eq(UserStore.django_user_id, BigInt(user.id)), eq(UserStore.store_id, row.id)))
      .limit(1);
    if (!assignment)
      throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
  }
  return row;
}
export function createStoreImageStore(config: Config, options: PrivateS3Options) {
  return createScopedMediaStore(config, options, 'uploads/stores', { image: 'stores_image' });
}
export function storeImageService(
  config: Config,
  db: Databases,
  media: DocumentationMediaStore | undefined,
  ephemeral: EphemeralStore = administrationEphemeralStore(config),
  now: () => number = Date.now,
) {
  const required = () => {
    if (!media)
      throw new AppError(
        503,
        'STORE_IMAGE_STORAGE_UNAVAILABLE',
        'Store images are currently unavailable.',
      );
    return media;
  };
  const revision = (key: string | null) =>
    createHmac('sha256', config.SESSION_SECRET + ':store-image')
      .update(key || '')
      .digest('hex');
  async function load(id: string): Promise<Reservation | null> {
    const raw = await ephemeral.get(storeImageUploadKey(id));
    if (raw === null) return null;
    try {
      const value = reservation.parse(JSON.parse(raw) as unknown);
      return value.expiresAt > now() ? value : null;
    } catch {
      return null;
    }
  }
  const specification = (value: Reservation) => ({
    ...uploadInput.parse({
      id: value.id,
      kind: 'image',
      name: 'store-image',
      contentType: value.contentType,
      size: value.size,
      checksum: value.checksum,
    }),
    objectKey: value.objectKey,
    expiresAt: new Date(value.expiresAt).toISOString().replace('T', ' ').replace('Z', ''),
  });
  return {
    async get(user: Principal, storeId: string) {
      const store = await db
        .get('writer')
        .transaction((tx) => authorizeStore(tx, user, storeId, 'read'));
      return {
        revision: revision(store.store_image),
        available: Boolean(media),
        hasImage: Boolean(store.store_image && imagePath.test(store.store_image)),
      };
    },
    /** Reserve a private upload for the store form (new store when `storeId` is absent). */
    async reserve(user: Principal, input: z.infer<typeof storeImageReservationInput>) {
      const store = required();
      requireRole(user, [1, 3]);
      await db.get('writer').transaction(async (tx) => {
        if (input.storeId) await authorizeStore(tx, user, input.storeId, 'write');
        else await assertCurrentOperatorRole(tx, user.id, [1, 3]);
      });
      const objectKey = store
        .keyFor(input.upload)
        .replace(
          /\/[^/]+$/,
          `/${fileBase(input.upload.name)}_${input.upload.id}.${mediaTypes[input.upload.contentType].extension}`,
        );
      store.assertKey(objectKey);
      if (objectKey.length > 254 || !imagePath.test(objectKey))
        throw new AppError(400, 'STORE_IMAGE_KEY_INVALID', 'Choose the image again.');
      let open = 0;
      for (const key of await ephemeral.scanKeys('pos:store_image_upload:*'))
        if ((await load(key.slice('pos:store_image_upload:'.length)))?.actorId === user.id) open++;
      if (open >= 5)
        throw new AppError(
          429,
          'STORE_IMAGE_UPLOAD_LIMIT',
          'Finish an existing image upload before starting another.',
        );
      const value: Reservation = {
        id: input.upload.id,
        actorId: user.id,
        storeId: input.storeId ?? null,
        objectKey,
        contentType: input.upload.contentType,
        size: input.upload.size,
        checksum: input.upload.checksum,
        expiresAt: now() + 15 * 60_000,
      };
      if (
        !(await ephemeral.set(storeImageUploadKey(value.id), JSON.stringify(value), {
          NX: true,
          EX: 15 * 60,
        }))
      )
        throw new AppError(409, 'STORE_IMAGE_UPLOAD_CHANGED', 'Choose the image again.');
      return {
        id: value.id,
        expiresAt: value.expiresAt,
        ...(await store.upload(specification(value))),
      };
    },
    /**
     * Verify an uploaded image for the store form before its writer transaction (Django
     * `ImageField` validation). Returns the `stores.store_image` path.
     */
    async prepare(user: Principal, uploadId: string, storeId: string | null) {
      const store = required(),
        value = await load(uploadId);
      if (!value || value.actorId !== user.id || value.storeId !== storeId)
        throw new AppError(
          409,
          'STORE_IMAGE_UPLOAD_EXPIRED',
          'The store image upload expired. Choose the image again.',
        );
      try {
        await store.verify(specification(value));
        await verifyPrivateImage(
          () => store.stream(value.objectKey, 'image', undefined, AbortSignal.timeout(7000)),
          { contentType: value.contentType, size: value.size, checksum: value.checksum },
          'STORE_IMAGE',
        );
      } catch (error) {
        if (error instanceof AppError && error.status === 429) throw error;
        throw new StoreImageInvalid();
      }
      return value.objectKey;
    },
    /** After the store form committed. */
    async consume(uploadId: string) {
      await ephemeral.del(storeImageUploadKey(uploadId));
    },
    async stream(user: Principal, storeId: string, signal?: AbortSignal) {
      const store = required(),
        row = await db.get('writer').transaction((tx) => authorizeStore(tx, user, storeId, 'read'));
      const key = row.store_image;
      if (!key || !imagePath.test(key))
        throw new AppError(404, 'STORE_IMAGE_NOT_FOUND', 'This image is unavailable.');
      let object: Awaited<ReturnType<DocumentationMediaStore['stream']>>;
      try {
        object = await store.stream(key, 'image', undefined, signal);
      } catch {
        throw new AppError(404, 'STORE_IMAGE_NOT_FOUND', 'This image is unavailable.');
      }
      if (
        !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(object.contentType) ||
        !Number.isSafeInteger(object.size) ||
        !object.size ||
        object.size > 10 * 1024 * 1024
      ) {
        object.body.destroy();
        throw new AppError(413, 'STORE_IMAGE_INVALID', 'This image is unavailable.');
      }
      return object;
    },
  };
}
