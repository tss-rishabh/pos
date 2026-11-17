import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ecommerceFixture } from '../../../tools/administration/ecommerce-sync/fixture.js';
import { createEcommerceFullSyncAdapter } from '../../../src/modules/administration/ecommerce-sync/http.js';
import { readEcommerceSynchronizationOptions } from '../../../src/modules/administration/ecommerce-sync/options.js';
const connection = process.env.ECOMMERCE_SYNC_MYSQL_TEST_URL;
it.skipIf(!connection)(
  'executes the durable source bridge and actual mandatory source I/O blocks without provider sends',
  async () => {
    const fixture = await ecommerceFixture(connection!);
    try {
      const result = spawnSync(
        'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
        ['tools/administration/ecommerce-sync/bridge-oracle.py'],
        {
          input: JSON.stringify({ database: fixture.url }),
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(
        z
          .object({ ok: z.literal(true), cases: z.literal(16) })
          .strict()
          .parse(JSON.parse(result.stdout) as unknown),
      ).toEqual({ ok: true, cases: 16 });
      // Same reviewed schema, fresh queue: prove the actual Node adapter accepts the
      // Python MAC/body and completion receipt, not independently invented envelopes.
      await fixture.admin.query('DELETE FROM pos_ecommerce_full_sync_commands');
      await fixture.admin.query(
        "UPDATE pos_ecommerce_full_sync_registry SET active_id=NULL WHERE id='catalog'",
      );
      const secret = 'synthetic-node-python-ecom-secret-'.repeat(2),
        clock = 1781505000,
        rpc = (input: Record<string, unknown>) => {
          const response = spawnSync(
            'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
            ['tools/administration/ecommerce-sync/protocol_fixture.py'],
            {
              input: JSON.stringify({ database: fixture.url, secret, clock, ...input }),
              encoding: 'utf8',
              timeout: 15000,
              maxBuffer: 1024 * 1024,
            },
          );
          expect(response.status).toBe(0);
          expect(response.stderr).toBe('');
          return JSON.parse(response.stdout) as unknown;
        },
        fetcher: typeof fetch = async (url, init) => {
          const response = z
            .object({
              status: z.number(),
              headers: z.record(z.string(), z.string()),
              body: z.string(),
            })
            .strict()
            .parse(
              rpc({
                mode: 'http',
                request: {
                  path: new URL(String(url)).pathname,
                  method: init?.method,
                  headers: Object.fromEntries(new Headers(init?.headers)),
                  body: init?.body || '',
                },
              }),
            );
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        },
        adapter = createEcommerceFullSyncAdapter(
          readEcommerceSynchronizationOptions({
            ECOMMERCE_FULL_SYNC_CONTRACT: 'pos-ecommerce-full-sync-v1',
            ECOMMERCE_FULL_SYNC_URL: 'https://fixture.invalid/internal/pos/ecommerce-full-syncs',
            ECOMMERCE_FULL_SYNC_SECRET: secret,
          }),
          fetcher,
          () => clock * 1000,
        )!,
        command = {
          operationId: randomUUID(),
          storeId: '9007199254740993',
          actorId: '9007199254740995',
          requestId: 'cross-language-fixture',
        };
      expect((await adapter.submit(command)).status).toBe('queued');
      rpc({ mode: 'worker' });
      expect(await adapter.read(command)).toMatchObject({
        operationId: command.operationId,
        status: 'succeeded',
        proof: { mongoWrites: 3, redisWrites: 3, cdnBatches: 1 },
      });
    } finally {
      await fixture.close();
    }
  },
  40000,
);
