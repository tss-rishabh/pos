import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import { buildPrivateWholeOrderStatusRuntime } from '../../src/modules/legacy-order-status/runtime.js';
import {
  statusCapabilitySchema,
  statusCapabilitySignature,
} from '../../src/modules/legacy-order-status/domain.js';
import { command, options } from './fixtures.js';
import { privateRuntimeEnv, privateReceiverHeaders } from './private-runtime-fixtures.js';

describe('private whole-order receiver process composition', () => {
  const open: { stop: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((runtime) => runtime.stop()));
  });
  function ports() {
    const get: Databases['get'] = vi.fn(() => {
        throw new Error('SYNTHETIC_PRIVATE_SQL_TOKEN');
      }),
      close = vi.fn(async () => {}),
      createDatabases = vi.fn(() => ({ get, close })),
      fetcher: typeof fetch = vi.fn(async () => {
        throw new Error('Unexpected external request.');
      });
    return { get, close, createDatabases, fetcher };
  }
  async function start(env = privateRuntimeEnv()) {
    const dependencies = ports(),
      runtime = await buildPrivateWholeOrderStatusRuntime(env, { ...dependencies, logger: false });
    open.push(runtime);
    if (!runtime.enabled) throw new Error('Expected the selected synthetic receiver.');
    return { ...dependencies, runtime };
  }
  it.each([
    {},
    { WHOLE_ORDER_STATUS_RECEIVER_ENABLED: 'false' },
    { WHOLE_ORDER_STATUS_RECEIVER_ENABLED: '' },
  ])(
    'default/unselected mode exits before parsing dependency credentials (%j)',
    async (selection) => {
      const dependencies = ports(),
        runtime = await buildPrivateWholeOrderStatusRuntime(
          { ...selection, MYSQL_WRITER_URL: 'not-a-url-SYNTHETIC_PRIVATE_VALUE' },
          dependencies,
        );
      expect(runtime.enabled).toBe(false);
      await runtime.stop();
      expect(dependencies.createDatabases).not.toHaveBeenCalled();
      expect(dependencies.fetcher).not.toHaveBeenCalled();
    },
  );
  it('DEMO exits with no database/network, even if selected production credentials are invalid', async () => {
    const dependencies = ports(),
      runtime = await buildPrivateWholeOrderStatusRuntime(
        { NODE_ENV: 'production', DEMO_MODE: 'true', WHOLE_ORDER_STATUS_RECEIVER_ENABLED: 'true' },
        dependencies,
      );
    expect(runtime).toMatchObject({ enabled: false, reason: 'demo' });
    expect(dependencies.createDatabases).not.toHaveBeenCalled();
    expect(dependencies.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { WHOLE_ORDER_STATUS_CONTRACT: undefined },
    { WHOLE_ORDER_STATUS_RECEIPT_KEY: undefined },
    { WHOLE_ORDER_STATUS_VENDOR_API_KEY: undefined },
    { TSS_EVENTS_URL: 'https://user:SYNTHETIC_PRIVATE_VALUE@events.synthetic.invalid' },
    { WHOLE_ORDER_STATUS_VENDOR_SHIPPED_URL: 'http://vendor.synthetic.invalid/status' },
    { MYSQL_WRITER_URL: undefined },
    { MYSQL_DATA_READER_URL: 'postgres://root@localhost/synthetic' },
    { MYSQL_DATA_READER_URL: 'mysql://root@localhost/synthetic?secret=SYNTHETIC_PRIVATE_VALUE' },
    { MYSQL_PRIMARY_READER_URL: 'mysql://invalid%ZZ@localhost/synthetic' },
    { MYSQL_DATA_READER_URL: 'mysql://root:invalid%ZZ@localhost/synthetic' },
    { WHOLE_ORDER_STATUS_RECEIVER_HOST: 'SYNTHETIC_PRIVATE_VALUE.invalid' },
    { WHOLE_ORDER_STATUS_RECEIVER_PORT: '65536' },
    { WHOLE_ORDER_STATUS_RECEIVER_ENABLED: 'SYNTHETIC_PRIVATE_VALUE' },
  ])('rejects incomplete/unsafe selection before constructing pools', async (extra) => {
    const dependencies = ports();
    await expect(
      buildPrivateWholeOrderStatusRuntime(privateRuntimeEnv(extra), dependencies),
    ).rejects.toMatchObject({
      code: 'WHOLE_ORDER_STATUS_PRIVATE_CONFIGURATION_REQUIRED',
      message: 'The private STORE receiver configuration needs review.',
    });
    expect(dependencies.createDatabases).not.toHaveBeenCalled();
    expect(dependencies.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'https://sync.synthetic.invalid/api/%2fsecret/',
    'https://sync.synthetic.invalid/api/../secret/',
    'https://sync.synthetic.invalid/api//secret/',
    'https://sync.synthetic.invalid/api/:secret/',
    'https://sync.synthetic.invalid/api/*/',
    'https://sync.synthetic.invalid/api/?token=SYNTHETIC_PRIVATE_VALUE',
  ])('rejects route syntax and normalized/raw sensitive prefixes', async (base) => {
    const dependencies = ports();
    await expect(
      buildPrivateWholeOrderStatusRuntime(
        privateRuntimeEnv({ BACKEND_SYNC_API_BASE_URL: base }),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_STATUS_PRIVATE_CONFIGURATION_REQUIRED' });
    expect(dependencies.createDatabases).not.toHaveBeenCalled();
  });
  it('exposes only scoped private HMAC routes plus a no-effect health route', async () => {
    // The sender flag must never accidentally start the public worker in this process.
    const { runtime, get, fetcher } = await start(
      privateRuntimeEnv({ WHOLE_ORDER_STATUS_WORKER_ENABLED: 'true' }),
    );
    const live = await runtime.app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json<unknown>()).toEqual({ status: 'ok' });
    expect(live.headers['cache-control']).toBe('no-store');
    for (const url of [
      '/api/v1/stores',
      '/api/v1/auth/sessions/current',
      '/health/ready',
      '/store-order/status/capabilities',
    ])
      expect((await runtime.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    const challenge = randomUUID(),
      capability = await runtime.app.inject({
        method: 'GET',
        url: '/api/store-order/status/capabilities',
        headers: {
          ...privateReceiverHeaders(),
          'x-pos-status-challenge': challenge,
        },
      });
    expect(capability.statusCode).toBe(200);
    expect(capability.json<unknown>()).toMatchObject({
      challenge,
      operationId: command.id,
      profile: 'pinned-store-chain-v1',
    });
    expect(capability.headers['x-pos-status-capability']).toBe(
      statusCapabilitySignature(
        options.WHOLE_ORDER_STATUS_RECEIPT_KEY!,
        statusCapabilitySchema.parse(capability.json<unknown>()),
      ),
    );
    expect(get).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires both independent service credentials and binds the original operation before DB access', async () => {
    const { runtime, get } = await start();
    for (const headers of [
      { cookie: 'pos_session=SYNTHETIC_PRIVATE_COOKIE' },
      { ...privateReceiverHeaders(), 'x-api-key': 'wrong-private-key' },
      { ...privateReceiverHeaders(), 'x-pos-status-proof': 'a'.repeat(43) },
      { ...privateReceiverHeaders(), 'idempotency-key': randomUUID() },
    ]) {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/store-order/status',
        payload: {},
        headers,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json<unknown>()).toMatchObject({
        code: 'WHOLE_ORDER_STATUS_SERVICE_UNAUTHORIZED',
      });
    }
    const outside = await runtime.app.inject({
      method: 'GET',
      url: `/api/store-order/status/commands/${randomUUID()}`,
      headers: privateReceiverHeaders(),
    });
    expect(outside.statusCode).toBe(403);
    expect(outside.json<unknown>()).toMatchObject({ code: 'WHOLE_ORDER_STATUS_SERVICE_SCOPE' });
    expect(get).not.toHaveBeenCalled();
  });
  it('logs only resource/request/user identifiers, never raw paths, queries, cookies, bodies or errors', async () => {
    const chunks: string[] = [],
      logStream = new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk.toString());
          done();
        },
      }),
      dependencies = ports(),
      runtime = await buildPrivateWholeOrderStatusRuntime(privateRuntimeEnv(), {
        ...dependencies,
        logStream,
      });
    open.push(runtime);
    if (!runtime.enabled) throw new Error('Expected the selected receiver.');
    const canary = 'SYNTHETIC_PRIVATE_VALUE',
      headers = { ...privateReceiverHeaders(), cookie: canary, 'x-request-id': canary },
      response = await runtime.app.inject({
        method: 'GET',
        url: `/api/store-order/status/capabilities?recipient=${canary}`,
        headers,
      }),
      failed = await runtime.app.inject({
        method: 'POST',
        url: '/api/store-order/status',
        headers,
        payload: { private: canary },
      }),
      databaseFailure = await runtime.app.inject({
        method: 'GET',
        url: '/api/store-order/status/commands/' + command.id,
        headers,
      }),
      missing = await runtime.app.inject({ method: 'GET', url: '/not-a-route/' + canary }),
      events = chunks
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(response.statusCode).toBe(400);
    expect(failed.statusCode).toBe(400);
    expect(databaseFailure.statusCode).toBe(503);
    expect(missing.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      response.body + failed.body + databaseFailure.body + missing.body + chunks.join(''),
    ).not.toMatch(/SYNTHETIC_PRIVATE|recipient|cookie|password|stack|\/api\//);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      module: 'whole-order-status',
      resource: 'whole-order-status-receiver',
      userId: '1',
      eventId: 'whole-order-status.whole-order-status-receiver.qualify.failed',
    });
    expect(
      events.every(
        (event) => typeof event.requestId === 'string' && typeof event.eventInstanceId === 'string',
      ),
    ).toBe(true);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(4);
  });
  it('uses a real ephemeral listener and closes it/pools exactly once', async () => {
    const { runtime, close, get } = await start(),
      address = await runtime.listen();
    expect((await fetch(address + '/health/live')).status).toBe(200);
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    await expect(fetch(address + '/health/live')).rejects.toThrow();
  });
  it('joins a running private worker before closing pools and never dispatches after stop', async () => {
    let release: () => void = () => {},
      started: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
        release = resolve;
      }),
      claimed = new Promise<void>((resolve) => {
        started = resolve;
      }),
      transaction = vi.fn(async () => {
        started();
        await pending;
        throw new Error('SYNTHETIC_PRIVATE_WORKER_ERROR');
      }),
      get: Databases['get'] = vi.fn(
        () => ({ transaction }) as unknown as ReturnType<Databases['get']>,
      ),
      close = vi.fn(async () => {}),
      runtime = await buildPrivateWholeOrderStatusRuntime(
        privateRuntimeEnv({ WHOLE_ORDER_STATUS_RECEIVER_WORKER_ENABLED: 'true' }),
        {
          createDatabases: () => ({ get, close }),
          logger: false,
        },
      );
    open.push(runtime);
    if (!runtime.enabled) throw new Error('Expected selected worker.');
    await runtime.app.ready();
    await claimed;
    const stopped = runtime.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).not.toHaveBeenCalled();
    release();
    await stopped;
    expect(close).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it.each([{ DEMO_MODE: 'true', WHOLE_ORDER_STATUS_RECEIVER_ENABLED: 'true' }, {}])(
    'the actual entry exits cleanly with no configured dependencies when disabled',
    async (selection) => {
      const result = await promisify(execFile)(
        process.execPath,
        ['--import=tsx', 'src/modules/legacy-order-status/receiver-main.ts'],
        {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH, ...selection },
        },
      );
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        module: 'whole-order-status',
        resource: 'private-receiver-runtime',
        eventId: 'whole-order-status.private-receiver-runtime.disabled',
        userId: null,
      });
    },
  );
  it('the actual entry emits a static startup failure without leaking malformed credentials', async () => {
    const result = await promisify(execFile)(
      process.execPath,
      ['--import=tsx', 'src/modules/legacy-order-status/receiver-main.ts'],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          WHOLE_ORDER_STATUS_RECEIVER_ENABLED: 'true',
          MYSQL_WRITER_URL: 'SYNTHETIC_PRIVATE_URL',
        },
      },
    ).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    const output = result as { stderr: string };
    expect(JSON.parse(output.stderr)).toMatchObject({
      eventId: 'whole-order-status.private-receiver-runtime.startup-failed',
      userId: null,
    });
    expect(output.stderr).not.toMatch(/SYNTHETIC|Zod|Error|password|stack/);
  });
  it('the selected actual entry listens privately, health performs no SQL, and SIGTERM closes cleanly', async () => {
    let connections = 0;
    const sqlTrap = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => sqlTrap.listen(0, '127.0.0.1', resolve));
    const sqlAddress = sqlTrap.address();
    if (!sqlAddress || typeof sqlAddress === 'string')
      throw new Error('Expected local fixture port.');
    const url = `mysql://root@127.0.0.1:${sqlAddress.port}/pos_rewrite_whole_status_test`,
      child = spawn(
        process.execPath,
        ['--import=tsx', 'src/modules/legacy-order-status/receiver-main.ts'],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            ...privateRuntimeEnv({
              MYSQL_WRITER_URL: url,
              MYSQL_PRIMARY_READER_URL: url,
              MYSQL_DATA_READER_URL: url,
            }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    let stdout = '',
      stderr = '';
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const listening = new Promise<string>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => reject(new Error('Private fixture exited before listening.')));
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
          if (match) resolve(match[1]!);
        });
      });
      const address = await listening;
      expect((await fetch(address + '/health/live')).status).toBe(200);
      expect((await fetch(address + '/api/v1/stores')).status).toBe(404);
      expect(connections).toBe(0);
      child.kill('SIGTERM');
      expect(await closed).toEqual({ code: 0, signal: null });
      expect(stderr).toBe('');
      expect(stdout).toContain('whole-order-status.private-receiver-runtime.stopped');
      expect(stdout).not.toContain(options.BACKEND_SYNC_REPO_API_KEY!);
      await expect(fetch(address + '/health/live')).rejects.toThrow();
    } finally {
      child.kill('SIGTERM');
      await closed;
      await new Promise<void>((resolve, reject) =>
        sqlTrap.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
