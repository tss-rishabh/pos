import { and, eq, inArray, or } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Databases } from '../db/pools.js';
import { PosUser } from '../db/legacy-schema.js';
import type { Principal } from '../domain/access.js';
import { AppError } from '../domain/errors.js';
import type { DocumentationMediaStore } from '../modules/administration/media-storage.js';
import { ownedImageService } from '../modules/administration/image-lifecycle/service.js';
import {
  imageAttachmentInput,
  imageKind,
  imageReservationInput,
  type ImageKind,
  type ImageOwnerAdapter,
} from '../modules/administration/image-lifecycle/domain.js';
import { profileRevision } from './profile.js';
import { profileMediaJobs, profileUploads } from './profile-media-schema.js';

export const profileImageKind = imageKind;
export type ProfileImageKind = ImageKind;
export const profileUploadInput = imageReservationInput;
export const profileAttachInput = imageAttachmentInput;
const field = (kind: ProfileImageKind) =>
  kind === 'image' ? ('profile_image' as const) : ('cover_image' as const);
export const profileImageReferences: Pick<
  ImageOwnerAdapter,
  'referencedKeys' | 'allowsCleanupKey' | 'errorPrefix'
> = {
  errorPrefix: 'PROFILE',
  async referencedKeys(tx, keys) {
    if (!keys.length) return new Set();
    const rows = await tx
      .select({ profile: PosUser.profile_image, cover: PosUser.cover_image })
      .from(PosUser)
      .where(or(inArray(PosUser.profile_image, keys), inArray(PosUser.cover_image, keys)));
    return new Set(rows.flatMap((row) => [row.profile, row.cover]));
  },
  allowsCleanupKey: (key) =>
    /^uploads\/users\/(?:profile_image|cover_image)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|jpeg|png|gif|webp)$/i.test(
      key,
    ),
};
export function profileImageOwner(config: Config): ImageOwnerAdapter {
  return {
    ...profileImageReferences,
    registry: 'operators',
    subject: 'your profile',
    kinds: ['image', 'cover-image'],
    reservationOwner: (context) => context.user.id,
    async authorize(tx, context, mode) {
      if (context.ownerId !== context.user.id)
        throw new AppError(403, 'PROFILE_OWNER_DENIED', 'Choose your own account image.');
      const [row] = await tx
        .select()
        .from(PosUser)
        .where(and(eq(PosUser.id, BigInt(context.user.id)), eq(PosUser.is_active, true)))
        .limit(1)
        .for(mode === 'publish' ? 'update' : 'share');
      if (!row) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      return {
        revision: profileRevision(config, row),
        keys: { image: row.profile_image, 'cover-image': row.cover_image },
      };
    },
    async write(tx, context, kind, key) {
      await tx
        .update(PosUser)
        .set({ [field(kind)]: key })
        .where(eq(PosUser.id, BigInt(context.ownerId)));
    },
    allowsKey(kind, key) {
      const directory = kind === 'image' ? 'profile_image' : 'cover_image';
      return new RegExp(`^uploads/users/${directory}/[^/]+\\.(?:jpg|jpeg|png|gif|webp)$`, 'i').test(
        key,
      );
    },
  };
}
export function profileMediaService(
  config: Config,
  db: Databases,
  media: DocumentationMediaStore | undefined,
  now: () => number = Date.now,
) {
  const lifecycle = ownedImageService(
    db,
    { uploads: profileUploads, jobs: profileMediaJobs },
    profileImageOwner(config),
    media,
    now,
  );
  const context = (user: Principal) => ({ user, ownerId: user.id });
  return {
    reserve: (user: Principal, input: Parameters<typeof lifecycle.reserve>[1]) =>
      lifecycle.reserve(context(user), input),
    attach: (user: Principal, id: string, revision: string) =>
      lifecycle.attach(context(user), id, revision),
    stream: (user: Principal, kind: ProfileImageKind, signal?: AbortSignal) =>
      lifecycle.stream(context(user), kind, signal),
  };
}
