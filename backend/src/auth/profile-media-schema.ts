import {
  imageCleanupTable,
  imageUploadTable,
} from '../modules/administration/image-lifecycle/schema.js';

// Preserve deployed profile table/column names while sharing the lifecycle mapping.
export const profileUploads = imageUploadTable('pos_rewrite_profile_uploads', 'profile_revision');
export const profileMediaJobs = imageCleanupTable('pos_rewrite_profile_media_jobs');
