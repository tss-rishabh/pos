import { execFileSync } from 'node:child_process';
import { z } from 'zod';
export function sourceStatusOracle(input: unknown) {
  return z
    .array(
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
    )
    .parse(
      JSON.parse(
        execFileSync(
          process.env.WHOLE_ORDER_STATUS_ORACLE_PYTHON ?? 'python3',
          ['tools/legacy-order-status/source_oracle.py'],
          {
            input: JSON.stringify(input),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 15000,
          },
        ),
      ) as unknown,
    );
}
