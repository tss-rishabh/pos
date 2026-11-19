import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
export const websiteHandoffScope = z.object({ storeId: identifier, checkoutId: z.uuid() }).strict();
export type WebsiteHandoffScope = z.infer<typeof websiteHandoffScope>;
/** Legacy posts `user_id`/`store_id`; both now come from the operator's own checkout scope. */
export const websiteHandoffIssue = z.object({}).strict();
export interface WebsiteHandoffResult {
  /** `{WEB_URL}/pos/login/?token=…&api_key=…&pos_store_id=…&pos_user_id=…` (order/views.py:4515). */
  webUrl: string;
  /** `JWT_CUSTOM_EXPIRY_MIN`, shown as "the session will remain active for only N minutes". */
  sessionMinutes: number;
}
