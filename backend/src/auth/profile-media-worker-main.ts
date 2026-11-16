import { AppError } from '../domain/errors.js';
import { runOwnedImageWorker } from '../modules/administration/image-lifecycle/runner.js';
import { readPrivateS3Options } from '../modules/administration/private-s3-client.js';
import { createScopedMediaStore } from '../modules/administration/media-storage.js';
import { profileMediaCleanup, retryProfileMediaCleanup } from './profile-media-worker.js';

await runOwnedImageWorker({
  envPrefix: 'PROFILE_MEDIA',
  errorPrefix: 'PROFILE_MEDIA',
  module: 'identity',
  resource: 'operator-profile-image',
  build(config, db, log) {
    const store = createScopedMediaStore(config, readPrivateS3Options(), 'uploads/users', {
      image: 'profile_image',
      'cover-image': 'cover_image',
    });
    if (!store)
      throw new AppError(
        503,
        'PROFILE_STORAGE_UNAVAILABLE',
        'Configure the private image storage.',
      );
    try {
      return {
        store,
        worker: profileMediaCleanup(db, store, log),
        retry: (id) => retryProfileMediaCleanup(db, id),
      };
    } catch (error) {
      store.close();
      throw error;
    }
  },
});
