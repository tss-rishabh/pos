import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import { registerWholeOrderStatus } from '../../src/modules/legacy-order-status/index.js';
import { wholeOrderStatusReceiver } from '../../src/modules/legacy-order-status/receiver.js';
import { readStatusReceiverOptions } from '../../src/modules/legacy-order-status/receiver-options.js';
import { config, options } from './fixtures.js';
describe('disabled/unqualified status startup', () => {
  it.each([false, true])(
    'does no DB work at startup with demo=%s and no selected worker',
    async (demo) => {
      const get = vi.fn(() => {
          throw new Error('No operational writer was selected.');
        }),
        db: Databases = { get, async close() {} },
        app = Fastify({ logger: false });
      try {
        await registerWholeOrderStatus(app, { ...config, DEMO_MODE: demo }, db, {
          ...options,
          WHOLE_ORDER_STATUS_WORKER_ENABLED: false,
        });
        await app.ready();
        expect(get).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('never qualifies a production-style receiver without the composed handover barrier', () => {
    const get = vi.fn(() => {
        throw new Error('No database work permitted.');
      }),
      db: Databases = { get, async close() {} };
    const receiver = wholeOrderStatusReceiver(config, db, options, readStatusReceiverOptions({}));
    expect(() => receiver.ready()).toThrow(
      expect.objectContaining({ code: 'WHOLE_ORDER_HANDOVER_FENCE_REQUIRED' }),
    );
    expect(get).not.toHaveBeenCalled();
  });
  it('keeps a selected flag inert in demo mode without any writer or transport work', async () => {
    const get = vi.fn(() => {
        throw new Error('No demo DB work');
      }),
      db: Databases = { get, async close() {} },
      app = Fastify({ logger: false });
    try {
      await registerWholeOrderStatus(app, { ...config, DEMO_MODE: true }, db, {
        ...options,
        WHOLE_ORDER_STATUS_WORKER_ENABLED: true,
      });
      await app.ready();
      expect(get).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
