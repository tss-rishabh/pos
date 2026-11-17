import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
export const python = resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python');
export const sourceRoot = process.env.SCREENING_SOURCE_ROOT ?? resolve('../../backend-tss-api_v2');
export const sourceOracleSchema = z.object({
  source: z.object({
    apiCommit: z.string(),
    helperHash: z.string(),
    controllerHash: z.string(),
    modelHash: z.string(),
  }),
  limit: z.array(
    z.object({
      bought: z.number(),
      quantity: z.number(),
      allowed: z.boolean(),
      message: z.string().nullable(),
    }),
  ),
  counter: z.object({
    exact: z.string(),
    guest: z.number(),
    readErrorFallback: z.number(),
    sql: z.string(),
  }),
  modes: z.array(
    z.object({
      unitMode: z.boolean(),
      quantity: z.number(),
      lines: z.array(
        z.object({ quantity: z.number(), productId: z.string(), subProductId: z.string() }),
      ),
      markerCount: z.number(),
      markerLineIds: z.array(z.string()),
    }),
  ),
  profiles: z.array(z.object({ name: z.string(), code: z.string().nullable() })),
  sourceChecks: z.object({ cart: z.number(), pos: z.number() }),
});
export function oracle(value: Record<string, unknown> = {}): unknown {
  return JSON.parse(
    execFileSync(python, ['-B', resolve('tests/legacy-import-screening/source_oracle.py')], {
      input: JSON.stringify({ sourceRoot, ...value }),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 20000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }),
  ) as unknown;
}
