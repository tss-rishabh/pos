import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
export const contactScope = z.object({ storeId: identifier, checkoutId: z.uuid() }).strict();
export type ContactScope = z.infer<typeof contactScope>;
/** Legacy UI rule `^\d{10}$` (`create_order.html:7836-7840`). */
export const updateTelephoneInput = z
  .object({ phoneNumber: z.string().regex(/^\d{10}$/, 'Please provide a valid mobile number') })
  .strict();
/**
 * Legacy UI rule `/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/` (`create_order.html:7952`),
 * rewritten without the optional separator (same language: `\w+\w+` is `\w+`) so the server
 * check cannot backtrack exponentially.
 */
export const legacyEmailPattern = /^\w+(?:[.-]\w+)*@\w+(?:[.-]\w+)*(?:\.\w{2,3})+$/;
export const updateEmailInput = z
  .object({
    email: z.string().max(96).regex(legacyEmailPattern, 'Please provide a valid email'),
  })
  .strict();
export interface ContactWorkspace {
  customerId: string;
  email: string;
  /** "Add Mobile No." shows only while `users.telephone` is empty (`create_order.html:2775-2780`). */
  canAddTelephone: boolean;
  /** The email popup shows only for a `temp.id` placeholder email (`create_order.html:1709-1711`). */
  canChangeEmail: boolean;
}
