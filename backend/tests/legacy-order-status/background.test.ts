import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerStatusWorkerLoop } from '../../src/modules/legacy-order-status/background.js';
describe('actorless worker failure tracing', () => {
  it('names the actual resource, creates a run UUID and never serializes a private thrown object', async () => {
    const output: string[] = [],
      app = Fastify({ logger: { level: 'error', stream: { write: (line) => output.push(line) } } });
    registerStatusWorkerLoop(
      app,
      'return-repair-obligation',
      async () => {
        throw { authorization: 'Bearer SYNTHETIC_PRIVATE', body: 'SYNTHETIC_PRIVATE_BODY' };
      },
      () => {},
    );
    try {
      await app.ready();
      await expect.poll(() => output.length).toBeGreaterThan(0);
      const row: unknown = JSON.parse(output[0]!);
      expect(row).toMatchObject({
        eventId: 'whole-order-status.return-repair-obligation.worker-failure',
        resource: 'return-repair-obligation',
        userId: null,
      });
      const parsed = row as { requestId: string; eventInstanceId: string };
      expect(parsed.requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(parsed.eventInstanceId).toBe(parsed.requestId);
      expect(output.join('')).not.toMatch(/SYNTHETIC_PRIVATE|Bearer|authorization|body/);
    } finally {
      await app.close();
    }
  });
});
