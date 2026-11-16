import { AppError } from '../../domain/errors.js';
import { runOwnedImageWorker } from './image-lifecycle/runner.js';
import { readPrivateS3Options } from './private-s3-client.js';
import {
  createStoreImageStore,
  retryStoreImageCleanup,
  storeImageCleanup,
} from './store-images.js';

await runOwnedImageWorker({
  envPrefix: 'STORE_IMAGE',
  errorPrefix: 'STORE_IMAGE',
  module: 'administration',
  resource: 'store-image',
  build(config, db, log) {
    const store = createStoreImageStore(config, readPrivateS3Options());
    if (!store)
      throw new AppError(
        503,
        'STORE_IMAGE_STORAGE_UNAVAILABLE',
        'Configure the private image storage.',
      );
    try {
      return {
        store,
        worker: storeImageCleanup(db, store, log),
        retry: (id) => retryStoreImageCleanup(db, id),
      };
    } catch (error) {
      store.close();
      throw error;
    }
  },
});
