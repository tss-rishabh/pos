import { z } from 'zod';

const key = 'pos-desktop-sso-reference';
const pendingKey = 'pos-desktop-sso-create-pending';
export const desktopSsoReferenceSchema = z
  .object({ id: z.uuid(), expires: z.number().int().positive().safe() })
  .strict();
export type DesktopSsoReference = z.infer<typeof desktopSsoReferenceSchema>;
/** Nonsecret routing metadata only. The actual client proof is an HttpOnly
 * cookie; no code, browser ticket, client secret or session enters storage. */
export function readDesktopSsoReference(): DesktopSsoReference | null {
  try {
    if (localStorage.getItem('pos-pending-logout')) {
      clearDesktopSsoReference();
      return null;
    }
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    if (raw.length > 256) throw new Error();
    const value = desktopSsoReferenceSchema.parse(JSON.parse(raw) as unknown);
    if (value.expires <= Date.now()) {
      clearDesktopSsoReference(value.id);
      return null;
    }
    return value;
  } catch {
    throw new Error(
      'The previous desktop sign-in reference could not be read. Keep the original sign-in open.',
    );
  }
}
export function saveDesktopSsoReference(input: DesktopSsoReference) {
  try {
    localStorage.setItem(key, JSON.stringify(desktopSsoReferenceSchema.parse(input)));
    localStorage.removeItem(pendingKey);
  } catch {
    throw new Error('The desktop sign-in reference could not be saved. Keep this window open.');
  }
}
/** A boolean dispatch fence, not a fabricated source UUID/expiry or proof. */
export function markDesktopSsoCreation() {
  try {
    localStorage.setItem(pendingKey, '1');
  } catch {
    throw new Error('The original sign-in request could not be saved. Keep this window open.');
  }
}
export function hasPendingDesktopSsoCreation() {
  try {
    return !!localStorage.getItem(pendingKey);
  } catch {
    throw new Error('The original sign-in request could not be read. Keep this window open.');
  }
}
export function clearDesktopSsoReference(expectedId?: string) {
  try {
    if (expectedId) {
      const raw = localStorage.getItem(key);
      if (raw && desktopSsoReferenceSchema.parse(JSON.parse(raw) as unknown).id !== expectedId)
        return;
    }
    localStorage.removeItem(key);
    localStorage.removeItem(pendingKey);
  } catch {
    /* Logout's tombstone also fences unreadable/disabled storage. */
  }
}
