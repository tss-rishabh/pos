import { z } from 'zod';
export const storedLifecycleInput = z
  .object({
    reason: z.string().max(255),
    reasonCategory: z.string().max(255),
    notify: z.boolean(),
    notificationTitle: z.string().min(1).max(200),
    automatic: z.boolean(),
    platform: z.enum(['CONVERT_ONLINE', 'RTO_CONVERT_ONLINE']),
    staffName: z.string().max(255),
    locationIds: z.string().max(255),
  })
  .strict();
export type StoredLifecycleInput = z.infer<typeof storedLifecycleInput>;
