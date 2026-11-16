import { imageCleanupTable, imageUploadTable } from './image-lifecycle/schema.js';

export const storeImageUploads = imageUploadTable(
  'pos_rewrite_store_image_uploads',
  'owner_revision',
  80,
);
export const storeImageJobs = imageCleanupTable('pos_rewrite_store_image_jobs');
