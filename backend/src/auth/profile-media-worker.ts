import type { Databases } from '../db/pools.js';
import type { DocumentationMediaStore } from '../modules/administration/media-storage.js';
import {
  ownedImageCleanup,
  retryOwnedImageCleanup,
  type ImageCleanupEvent,
} from '../modules/administration/image-lifecycle/cleanup.js';
import { profileMediaJobs, profileUploads } from './profile-media-schema.js';
import { profileImageReferences } from './profile-media.js';

export interface ProfileMediaEvent extends ImageCleanupEvent {
  module: 'identity';
  resource: 'operator-profile-image';
}
const tables = { uploads: profileUploads, jobs: profileMediaJobs };
export function profileMediaCleanup(
  db: Databases,
  store: DocumentationMediaStore,
  log: (event: ProfileMediaEvent) => void,
  now: () => number = Date.now,
) {
  return ownedImageCleanup(
    db,
    tables,
    profileImageReferences,
    store,
    { module: 'identity', resource: 'operator-profile-image' },
    (event) => log({ ...event, module: 'identity', resource: 'operator-profile-image' }),
    now,
  );
}
export const retryProfileMediaCleanup = (db: Databases, id: string) =>
  retryOwnedImageCleanup(db, tables, 'PROFILE', id);
