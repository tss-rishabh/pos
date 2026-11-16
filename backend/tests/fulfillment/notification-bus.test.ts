import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  notificationBus,
  type NoticeEvent,
  type NotificationBus,
} from '../../src/modules/fulfillment/notification-bus.js';

describe('scoped Redis notification fanout', () => {
  let server: ChildProcess | undefined, bus: NotificationBus | undefined;
  beforeAll(async () => {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No isolated notification port.');
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    server = spawn(
      'redis-server',
      [
        '--port',
        String(address.port),
        '--bind',
        '127.0.0.1',
        '--save',
        '',
        '--appendonly',
        'no',
        '--protected-mode',
        'yes',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Isolated Redis did not start.')), 5000);
      server!.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server!.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Ready to accept connections')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    bus = notificationBus(
      readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'isolated-redis-notifications-'.repeat(3),
        REDIS_URL: `redis://127.0.0.1:${address.port}`,
      }),
    );
  });
  afterAll(async () => {
    await bus?.close();
    if (server && !server.killed) {
      const exit = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
      server.kill('SIGTERM');
      await exit;
    }
  });
  it('publishes only to the requested store and recipients without revealing the audience', async () => {
    if (!bus) throw new Error('Fixture not initialized');
    const received: { listener: string; event: Omit<NoticeEvent, 'userIds'> }[] = [];
    const stops = await Promise.all([
      bus.subscribe('1', '10', 'a', (event) => received.push({ listener: 'a', event })),
      bus.subscribe('1', '11', 'b', (event) => received.push({ listener: 'b', event })),
      bus.subscribe('2', '10', 'c', (event) => received.push({ listener: 'c', event })),
    ]);
    await bus.publish({
      event: 'notification.created',
      notificationId: '900',
      storeId: '1',
      userIds: ['10'],
      isNewOrder: true,
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const poll = () => {
        if (received.length) resolve();
        else if (Date.now() > deadline) reject(new Error('Notification was not received.'));
        else setTimeout(poll, 5);
      };
      poll();
    });
    expect(received).toEqual([
      {
        listener: 'a',
        event: {
          event: 'notification.created',
          notificationId: '900',
          storeId: '1',
          isNewOrder: true,
        },
      },
    ]);
    await Promise.all(stops.map((stop) => stop()));
  });
  it('fails safely without a configured broker and rejects remote plaintext in production', async () => {
    const missing = notificationBus(
      readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'missing-redis-fixture-'.repeat(3),
      }),
    );
    await expect(
      missing.publish({
        event: 'notification.read',
        notificationId: '1',
        storeId: '1',
        userIds: ['1'],
        isNewOrder: false,
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    await missing.close();
    const insecure = notificationBus({
      ...readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'insecure-redis-fixture-'.repeat(3),
      }),
      NODE_ENV: 'production',
      REDIS_URL: 'redis://broker.example.test:6379',
    });
    await expect(
      insecure.publish({
        event: 'notification.read',
        notificationId: '1',
        storeId: '1',
        userIds: ['1'],
        isNewOrder: false,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REDIS_CONFIGURATION' });
    await insecure.close();
  });
});
