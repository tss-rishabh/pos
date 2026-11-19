import { expect, it } from 'vitest';
import { z } from 'zod';
import { appStack, appStackMysqlUrl, appStackOperator } from './helpers/app-stack.js';

const eventSchema = z.object({
  eventId: z.string(),
  eventInstanceId: z.uuid(),
  module: z.string(),
  resource: z.string(),
  requestId: z.uuid(),
  userId: z.string().nullable(),
  method: z.string(),
  status: z.number(),
  durationMs: z.number(),
});
it.skipIf(!appStackMysqlUrl)(
  'logs resource-scoped event identities and excludes PII, bodies, URLs and credentials',
  async () => {
    const lines: string[] = [];
    const stack = await appStack({
      logger: { level: 'info', stream: { write: (line: string) => lines.push(line) } },
    });
    const app = stack.app;
    try {
      const cookie = await stack.cookie(appStackOperator.id);
      await app.inject({
        url: '/api/v1/stores/1/catalog/products?search=pii-canary%40example.test',
        headers: { cookie, authorization: 'Bearer secret-canary' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions',
        headers: { origin: 'https://evil.example' },
        payload: { username: 'private-name-canary', password: 'private-password-canary' },
      });
      const logs = lines.join('');
      for (const value of [
        'pii-canary',
        'secret-canary',
        'private-name-canary',
        'private-password-canary',
        'authorization',
        'cookie',
        'search=',
        'operator@example.test',
        appStackOperator.name,
      ])
        expect(logs).not.toContain(value);
      const events = lines
        .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
        .filter((line) => line.eventId !== undefined)
        .map((line) => eventSchema.parse(line));
      expect(
        events.some(
          (e) => e.eventId === 'catalog.product.list.completed' && e.userId === appStackOperator.id,
        ),
      ).toBe(true);
      expect(
        events.some((e) => e.eventId === 'identity.session.create.failed' && e.status === 403),
      ).toBe(true);
      expect(new Set(events.map((e) => e.eventInstanceId)).size).toBe(events.length);
    } finally {
      await stack.close();
    }
  },
  60_000,
);
