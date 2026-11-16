import Fastify from 'fastify';
import { it, expect } from 'vitest';
import { z } from 'zod';
import { setTimeout } from 'node:timers/promises';
import { currentRequestTrace, registerRequestTrace } from '../src/observability/context.js';
import { demoUser } from '../src/modules/demo.js';

it('preserves the authenticated actor through async work without leaking context between requests', async () => {
  const app = Fastify({ logger: false });
  app.decorateRequest('principal', null);
  app.decorateRequest('auditUserId', null);
  registerRequestTrace(app);
  app.get(
    '/fixture/:id',
    { config: { trace: { module: 'fixture', resource: 'request-context', action: 'read' } } },
    async (request) => {
      const { id } = z.object({ id: z.enum(['1', '2']) }).parse(request.params);
      expect(currentRequestTrace()?.userId).toBeNull();
      request.principal = { ...demoUser, id };
      await setTimeout(id === '1' ? 20 : 5);
      return currentRequestTrace();
    },
  );
  try {
    const [one, two] = await Promise.all(
      ['/fixture/1', '/fixture/2'].map((url) => app.inject({ url })),
    );
    expect(one!.json()).toMatchObject({
      userId: '1',
      module: 'fixture',
      resource: 'request-context',
    });
    expect(two!.json()).toMatchObject({
      userId: '2',
      module: 'fixture',
      resource: 'request-context',
    });
    expect(one!.json<{ requestId: string }>().requestId).not.toBe(
      two!.json<{ requestId: string }>().requestId,
    );
    expect(currentRequestTrace()).toBeNull();
  } finally {
    await app.close();
  }
});
