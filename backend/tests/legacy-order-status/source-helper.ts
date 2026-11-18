import { z } from 'zod';
import { goldenStdout, type GoldenOptions } from '../golden/load.js';

const sourceStatusSchema = z.array(
  z.object({
    callback: z.object({ status: z.number(), message: z.string() }).nullable(),
    requests: z.array(
      z.object({
        path: z.string(),
        body: z.object({
          orderId: z.string(),
          has_product_ids: z.array(z.string()),
          platform: z.string(),
        }),
        timeout: z.number(),
        headerNames: z.array(z.string()),
      }),
    ),
  }),
);
/** Replays the captured pinned-source oracle output recorded for the same input. */
export function goldenSourceStatusOracle(name: string, input: unknown, options?: GoldenOptions) {
  return sourceStatusSchema.parse(
    JSON.parse(
      goldenStdout('legacy-order-status', name, JSON.stringify(input), undefined, options),
    ) as unknown,
  );
}
