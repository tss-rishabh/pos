// Private IPC owner of the real authenticated Fastify application. No fixture routes.
import { z } from 'zod';
import { readConfig } from '../../src/config.ts';
import { buildApp } from '../../src/app.ts';

const database = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'mysql:' &&
    url.hostname === '127.0.0.1' &&
    !!url.port &&
    /^\/pos_rewrite_catalog_workflow_[a-f0-9]{12}$/.test(url.pathname) &&
    !url.search &&
    !url.hash
  );
});
const initialize = z
  .object({
    command: z.literal('initialize'),
    primary: database,
    writer: database,
    secret: z.string().min(40).max(128),
    webOrigin: z.literal('http://127.0.0.1:1'),
  })
  .strict();
let app;
async function close() {
  const current = app;
  app = undefined;
  await current?.close();
}
let started = false;
process.on('message', (value) => {
  void (async () => {
    if (started) {
      if (JSON.stringify(value) !== JSON.stringify({ command: 'close' }))
        throw new Error('UNKNOWN_BENCHMARK_API_COMMAND');
      await close();
      process.send?.({ kind: 'closed' });
      process.disconnect?.();
      return;
    }
    started = true;
    const input = initialize.parse(value);
    const writer = new URL(input.writer),
      primary = new URL(input.primary);
    if (writer.host !== primary.host || writer.pathname !== primary.pathname)
      throw new Error('BENCHMARK_API_SCHEMA_MISMATCH');
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      SESSION_SECRET: input.secret,
      WEB_ORIGIN: input.webOrigin,
      MYSQL_WRITER_URL: input.writer,
      MYSQL_PRIMARY_READER_URL: input.primary,
      MYSQL_DATA_READER_URL: input.primary,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_POOL_SIZE: '2',
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    app = await buildApp(config);
    process.send?.({ kind: 'ready', origin: await app.listen({ host: '127.0.0.1', port: 0 }) });
  })().catch(async (error) => {
    process.send?.({
      kind: 'error',
      code: 'BENCHMARK_API_FAILED',
      errorKind: error instanceof Error ? error.name : 'UnknownError',
    });
    await close().catch(() => undefined);
    process.exitCode = 1;
    process.disconnect?.();
  });
});
process.on('disconnect', () => {
  void close().catch(() => undefined);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void close().finally(() => process.exit(1));
  });
process.send?.({ kind: 'awaiting-initialization' });
