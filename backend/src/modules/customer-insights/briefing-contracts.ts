import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

const text = (length: number) => z.string().max(length).nullable().default(null);
const numeric = z
  .union([
    z.number().finite(),
    z
      .string()
      .regex(/^-?\d+(?:\.\d+)?$/)
      .transform(Number),
  ])
  .refine((value) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER);
const stock = numeric.refine((value) => Number.isInteger(value) && value >= 0);
const truth = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(Boolean);
const product = z.object({
  name: text(300),
  image_url: text(2048),
  store: stock.nullable().default(null),
  online: stock.nullable().default(null),
  sizes: z
    .array(
      z.object({
        size: z.string().max(100),
        store: stock.nullable().default(null),
        online: stock.nullable().default(null),
      }),
    )
    .max(100)
    .default([]),
});
export const customerBriefing = z.object({
  user_id: z
    .union([z.string().max(128), z.number().int().safe().nonnegative().transform(String)])
    .nullable()
    .default(null),
  customer: z
    .object({ name: text(300), is_exclusive: truth.default(false) })
    .nullable()
    .default(null),
  occasion: z
    .object({ emoji: text(40), text: text(500) })
    .nullable()
    .default(null),
  segment: text(150),
  last_visit: text(150),
  home_store: text(200),
  avg_order_value: numeric.nullable().default(null),
  total_spend: numeric.nullable().default(null),
  customer_since: z
    .object({ date: text(100), tenure: text(150) })
    .nullable()
    .default(null),
  sizes: z
    .array(
      z.object({
        label: text(100),
        usual_size: text(100),
        recent_size: text(100),
        size_drifted: truth.default(false),
      }),
    )
    .max(100)
    .default([]),
  action_points: z
    .array(
      z.object({
        kind: z.string().max(40).default('action'),
        category: text(40),
        prompt: text(2000),
        text: text(4000),
        note: text(2000),
        count: stock.default(0),
        items: z.array(product).max(100).default([]),
      }),
    )
    .max(100)
    .default([]),
});
export const customerBriefingResponse = z
  .object({
    customerId: identifier,
    checkoutVersion: z.number().int().nonnegative(),
    briefing: customerBriefing,
    fetchedAt: z.iso.datetime(),
  })
  .strict();
export type CustomerBriefing = z.infer<typeof customerBriefing>;
export interface BriefingIdentity {
  id: string;
  email: string;
  telephone: string;
}
