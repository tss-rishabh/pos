import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appStack, appStackMysqlUrl, appStackOperator } from '../helpers/app-stack.js';

const stores = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
});

describe.skipIf(!appStackMysqlUrl)('daily report store options on the real stack', () => {
  it('lists only active assigned STORE rows, ordered by name, for an authenticated operator', async () => {
    const stack = await appStack();
    try {
      const { app } = stack,
        path = '/api/v1/reports/store-cash-balances/stores';
      expect((await app.inject({ url: path })).statusCode).toBe(401);
      const headers = { cookie: await stack.cookie(appStackOperator.id) };
      const options = await app.inject({ url: path, headers });
      expect(options.statusCode).toBe(200);
      // Store 3 is an assigned WAREHOUSE and store 4 is not assigned (ledger.stores).
      expect(stores.parse(options.json<unknown>()).data).toEqual([
        { id: '1', name: 'Synthetic Flagship' },
        { id: '2', name: 'Synthetic Second Store' },
      ]);
    } finally {
      await stack.close();
    }
  }, 60_000);
});
