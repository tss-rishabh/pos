import { verifyPrivateImage } from '../modules/administration/image-lifecycle/validation.js';

/** Compatibility export; all owner kinds share one bounded decoder and concurrency guard. */
export const verifyProfileImage = (
  read: Parameters<typeof verifyPrivateImage>[0],
  expected: Parameters<typeof verifyPrivateImage>[1],
) => verifyPrivateImage(read, expected, 'PROFILE');
