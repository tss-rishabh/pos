import { z } from 'zod';
import { customerWorkspaceBase, customerWorkspaceRequest, type ProfileScope } from './client';

const text = (length: number) => z.string().max(length).nullable();
const amount = z
  .number()
  .finite()
  .refine((value) => Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  .nullable();
const stock = z.number().int().nonnegative().safe().nullable();
const product = z.object({
  name: text(300),
  image_url: text(2048),
  store: stock,
  online: stock,
  sizes: z.array(z.object({ size: z.string().max(100), store: stock, online: stock })).max(100),
});
export const briefingResponse = z
  .object({
    customerId: z.string().regex(/^[1-9]\d{0,19}$/),
    checkoutVersion: z.number().int().nonnegative(),
    fetchedAt: z.iso.datetime(),
    briefing: z.object({
      user_id: text(128),
      customer: z.object({ name: text(300), is_exclusive: z.boolean() }).nullable(),
      occasion: z.object({ emoji: text(40), text: text(500) }).nullable(),
      segment: text(150),
      last_visit: text(150),
      home_store: text(200),
      avg_order_value: amount,
      total_spend: amount,
      customer_since: z.object({ date: text(100), tenure: text(150) }).nullable(),
      sizes: z
        .array(
          z.object({
            label: text(100),
            usual_size: text(100),
            recent_size: text(100),
            size_drifted: z.boolean(),
          }),
        )
        .max(100),
      action_points: z
        .array(
          z.object({
            kind: z.string().max(40),
            category: text(40),
            prompt: text(2000),
            text: text(4000),
            note: text(2000),
            count: z.number().int().nonnegative().safe(),
            items: z.array(product).max(100),
          }),
        )
        .max(100),
    }),
  })
  .strict();
export type CustomerBriefing = z.infer<typeof briefingResponse>['briefing'];
export type BriefingProduct = z.infer<typeof product>;

export async function readCustomerBriefing(
  scope: ProfileScope,
  expectedVersion: number,
  abort: AbortSignal,
) {
  const result = await customerWorkspaceRequest(
    scope,
    customerWorkspaceBase(scope) + '/customer-insights',
    { signal: AbortSignal.any([abort, AbortSignal.timeout(12000)]) },
    briefingResponse,
  );
  if (result.customerId !== scope.customerId || result.checkoutVersion !== expectedVersion)
    throw new Error('This sale changed. Reopen customer insights.');
  return result;
}
