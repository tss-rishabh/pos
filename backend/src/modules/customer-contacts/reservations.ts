import { z } from 'zod';
import type { AdministrationTransaction } from '../administration/checkins.js';

/**
 * The verified contact-change challenge (and its reservation/mutex tables) is deleted:
 * legacy `AjaxUpdateUserMobile`/`AjaxUpdateUserEmail` (`order/views.py:3369-3399`) update
 * `users` directly. No contact change can be pending, so these checks only validate input.
 * Kept so checkout customer registration (W4) compiles unchanged.
 */
export const customerContactKey = z.string().regex(/^(?:email|phone):[a-f0-9]{64}$/);
const keys = (input: readonly string[]) => z.array(customerContactKey).min(1).max(4).parse(input);
export async function lockCustomerContactKeys(
  _tx: AdministrationTransaction,
  input: readonly string[],
): Promise<void> {
  keys(input);
}
export async function assertNoActiveContactChangeReservation(
  _tx: AdministrationTransaction,
  input: readonly string[],
  nowMs: number,
): Promise<void> {
  z.number().int().nonnegative().refine(Number.isSafeInteger).parse(nowMs);
  keys(input);
}
