/** Local inspection only. Not included in the production build or container. */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

const credentialSchema = z.object({
  host: z.literal('data-team-reader-mysql.thesouledstore.com'),
  user: z.string().min(1), password: z.string().min(1), database: z.literal('tss'),
}).strict();

async function start(supplied: unknown) {
  const credentials = credentialSchema.parse(supplied);
  const preserved = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT']);
  for (const key of Object.keys(process.env)) if (!preserved.has(key)) delete process.env[key];
  process.env.NODE_ENV = 'development';
  const { readConfig } = await import('../src/config.js');
  const { buildApp } = await import('../src/app.js');
  const url = new URL('mysql://localhost/tss');
  url.hostname = credentials.host;
  url.username = credentials.user;
  url.password = credentials.password;
  const config = readConfig({
    NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '4610', WEB_ORIGIN: 'http://localhost:4273',
    SESSION_SECRET: randomBytes(48).toString('base64url'),
    MYSQL_WRITER_URL: url.href, MYSQL_PRIMARY_READER_URL: url.href, MYSQL_DATA_READER_URL: url.href,
    MYSQL_TLS_CA_FILE: resolve('../../global-bundle.pem'), MYSQL_POOL_SIZE: '3',
  });
  const app = await buildApp(config, { logger: false });
  const previewId = '9223372036854775807';
  app.addHook('onRequest', async (request, reply) => {
    if (!['localhost:4273', '127.0.0.1:4273', 'localhost:4610', '127.0.0.1:4610'].includes(request.headers.host || ''))
      return reply.code(403).send({ error: { code: 'LOCAL_PREVIEW_ONLY', message: 'Open the local preview URL.' } });
  });
  app.addHook('preHandler', async (request) => {
    request.principal = { id: previewId, name: 'MySQL UI preview', email: '', role: 1, userType: 1, storeIds: [] };
    request.sessionExpiresAt = Date.now() + 4 * 3600_000;
    request.authSessionValid = async () => true;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode === 401 && request.principal?.id === previewId) {
      reply.code(403);
      return JSON.stringify({ error: { code: 'LOCAL_PREVIEW_ONLY', message: 'This action requires a configured operator session. You can continue browsing the UI.', requestId: request.id } });
    }
    return payload;
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => { void app.close().then(() => process.exit(0)); });
  await app.listen({ host: '127.0.0.1', port: 4610 });
  process.stdout.write('Local real-MySQL UI backend ready on http://127.0.0.1:4610\n');
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdout.write('Ready for MySQL credentials on hidden stdin.\n');
let input = '', started = false;
process.stdin.on('data', (chunk: string) => {
  if (started) return;
  input += chunk;
  if (!/[\r\n]/.test(input)) return;
  started = true;
  process.stdin.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try {
    const value: unknown = JSON.parse(input.trim());
    input = '';
    void start(value).catch(() => { process.stderr.write('Local preview could not start.\n'); process.exit(1); });
  } catch {
    input = '';
    process.stderr.write('Local preview credentials could not be read.\n');
    process.exit(1);
  }
});
