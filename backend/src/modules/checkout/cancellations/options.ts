import { z } from 'zod';

/** Legacy settings `MAIN_API_V2_URL` / `API_V2_URL` (POSAdmin/settings.py:448-449). */
export interface PendingCancellationOptions {
  mainApiV2Url?: string;
  apiV2Url?: string;
}
export function pendingCancellationOptions(
  env: NodeJS.ProcessEnv = process.env,
): PendingCancellationOptions {
  const value = z
    .object({ MAIN_API_V2_URL: z.url().optional(), API_V2_URL: z.url().optional() })
    .parse(Object.fromEntries(Object.entries(env).filter(([, item]) => item !== '')));
  return {
    ...(value.MAIN_API_V2_URL ? { mainApiV2Url: value.MAIN_API_V2_URL } : {}),
    ...(value.API_V2_URL ? { apiV2Url: value.API_V2_URL } : {}),
  };
}
