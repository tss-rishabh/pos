import { createHmac } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, eq, inArray } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { requireRole, requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { assertCurrentStoreAccess } from './authorization.js';
import { ownedImageService } from './image-lifecycle/service.js';
import {
  imageAttachmentInput,
  imageReservationInput,
  type ImageOwnerAdapter,
} from './image-lifecycle/domain.js';
import {
  ownedImageCleanup,
  retryOwnedImageCleanup,
  type ImageCleanupEvent,
} from './image-lifecycle/cleanup.js';
import { createScopedMediaStore, type DocumentationMediaStore } from './media-storage.js';
import type { PrivateS3Options } from './private-s3-client.js';
import { storeImageJobs, storeImageUploads } from './store-image-schema.js';
import { storePublicUrl } from './policies.js';

export const storeImageUploadInput = imageReservationInput.refine(
  (input) => input.upload.kind === 'image',
  'Choose a store image.',
);
export const storeImageAttachInput = imageAttachmentInput;
export interface StoreImageOptions {
  storeImageStore?: DocumentationMediaStore;
}
const tables = { uploads: storeImageUploads, jobs: storeImageJobs };
const imagePath = /^uploads\/stores\/stores_image\/[^/]+\.(?:jpg|jpeg|png|gif|webp)$/i;
export const storeImageReferences: Pick<
  ImageOwnerAdapter,
  'referencedKeys' | 'allowsCleanupKey' | 'errorPrefix'
> = {
  errorPrefix: 'STORE_IMAGE',
  async referencedKeys(tx, keys) {
    if (!keys.length) return new Set();
    const rows = await tx
      .select({ key: Store.store_image })
      .from(Store)
      .where(inArray(Store.store_image, keys));
    return new Set(rows.map((row) => row.key));
  },
  allowsCleanupKey: (key) =>
    /^uploads\/stores\/stores_image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|jpeg|png|gif|webp)$/i.test(
      key,
    ),
};
function storeImageOwner(config: Config): ImageOwnerAdapter {
  return {
    ...storeImageReferences,
    registry: 'stores',
    subject: 'the store',
    kinds: ['image'],
    reservationOwner: (context) => `${context.ownerId}:${context.user.id}`,
    async authorize(tx, context, mode) {
      const roles = mode === 'read' ? ([1, 2, 3] as const) : ([1, 3] as const);
      requireRole(context.user, [...roles]);
      requireStore(context.user, context.ownerId);
      await assertCurrentStoreAccess(tx, context.user.id, context.ownerId, roles);
      const [row] = await tx
        .select()
        .from(Store)
        .where(and(eq(Store.id, BigInt(context.ownerId)), eq(Store.is_active, true)))
        .limit(1)
        .for(mode === 'publish' ? 'update' : 'share');
      if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'An active store was not found.');
      const [actor] = await tx
        .select({ userType: PosUser.user_type, role: PosUser.role })
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(context.user.id)))
        .limit(1)
        .for('share');
      if (
        !actor ||
        ![1, 2].includes(actor.userType) ||
        (actor.userType === 2 && row.category !== 'FRANCHISE')
      )
        throw new AppError(
          403,
          'STORE_IMAGE_SCOPE_DENIED',
          'This store is outside your organization.',
        );
      if (actor.userType === 2 && actor.role === 1) {
        const [assignment] = await tx
          .select({ id: UserStore.id })
          .from(UserStore)
          .where(
            and(
              eq(UserStore.django_user_id, BigInt(context.user.id)),
              eq(UserStore.store_id, row.id),
            ),
          )
          .limit(1)
          .for('share');
        if (!assignment)
          throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
      }
      const revision = createHmac('sha256', config.SESSION_SECRET)
        .update(
          JSON.stringify(row, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        )
        .digest('hex');
      return { revision, keys: { image: row.store_image } };
    },
    async write(tx, context, _kind, key) {
      await tx
        .update(Store)
        .set({
          store_image: key,
          url_key: storePublicUrl(context.ownerId),
          updated_at: Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
            .toPlainDateTime()
            .toString({ smallestUnit: 'second' })
            .replace('T', ' '),
        })
        .where(eq(Store.id, BigInt(context.ownerId)));
    },
    allowsKey: (kind, key) => kind === 'image' && imagePath.test(key),
  };
}
export function createStoreImageStore(config: Config, options: PrivateS3Options) {
  return createScopedMediaStore(config, options, 'uploads/stores', { image: 'stores_image' });
}
export function storeImageService(
  config: Config,
  db: Databases,
  media: DocumentationMediaStore | undefined,
  now: () => number = Date.now,
) {
  const lifecycle = ownedImageService(db, tables, storeImageOwner(config), media, now);
  const context = (user: Principal, storeId: string) => ({ user, ownerId: storeId });
  return {
    async get(user: Principal, storeId: string) {
      const state = await lifecycle.state(context(user, storeId));
      return {
        revision: state.revision,
        available: Boolean(media),
        hasImage: Boolean(state.keys.image),
      };
    },
    reserve: (user: Principal, storeId: string, input: Parameters<typeof lifecycle.reserve>[1]) =>
      lifecycle.reserve(context(user, storeId), input),
    attach: (user: Principal, storeId: string, id: string, revision: string) =>
      lifecycle.attach(context(user, storeId), id, revision),
    stream: (user: Principal, storeId: string, signal?: AbortSignal) =>
      lifecycle.stream(context(user, storeId), 'image', signal),
  };
}
export function storeImageCleanup(
  db: Databases,
  media: DocumentationMediaStore,
  log: (event: ImageCleanupEvent) => void,
  now: () => number = Date.now,
) {
  return ownedImageCleanup(
    db,
    tables,
    storeImageReferences,
    media,
    { module: 'administration', resource: 'store-image' },
    log,
    now,
  );
}
export const retryStoreImageCleanup = (db: Databases, id: string) =>
  retryOwnedImageCleanup(db, tables, 'STORE_IMAGE', id);
