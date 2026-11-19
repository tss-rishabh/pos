import { spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createConnection, createServer, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * W26: the real backend (API + `worker:jobs`) against the UAT environment, for driving the
 * desktop app end to end. Nothing here is synthetic: MySQL, Redis and API-v2 are UAT.
 *
 * Safety layers (the app itself is unchanged; everything below is environment plumbing):
 *   1. Host check. Every MySQL, Redis and HTTP base URL in `.env.uat` must be a known UAT host,
 *      a blocked messaging/production host (removed from the environment), or Google BigQuery.
 *      Anything else stops the stack before it starts.
 *   2. Messaging off. Every outbound messaging adapter is left unconfigured (Netcore, Gupshup,
 *      Slack, Freshdesk, mailr/MJML, WhatsApp invoice), login OTP delivery is `sandbox`, and AWS
 *      credentials are withheld (the configured bucket is not a UAT bucket).
 *   3. UAT reverse proxy. API-v2 and the other UAT HTTP services are reached only through
 *      http://127.0.0.1:<proxy>/_h/<host>/…, which forwards to https://<host>/… and refuses every
 *      messaging path (omnichannel SMS/OTP, mailr, WhatsApp, email). Calls are logged as
 *      method + host + path (no query, headers or bodies).
 *   4. Egress allowlist. The backend and worker run with NODE_USE_ENV_PROXY=1 and an HTTPS proxy
 *      that allows CONNECT only to Google BigQuery/OAuth hosts. Any other direct HTTPS call
 *      (Slack webhooks from store rows, S3, production hosts) is refused and logged.
 *   5. Redis relay. UAT Redis is plaintext on a private address; the app accepts plaintext only
 *      on loopback, so a loopback TCP relay forwards to it (a sidecar, as stunnel would be).
 *
 * Ports (W26_PORT_BASE, default 4760): web gate = base, vite preview = base+1, backend gate =
 * base+2, backend = base+3, control = base+4, UAT reverse proxy = base+5, egress proxy = base+6,
 * Redis relay = base+7. The web gate and backend gate can be cut to simulate a device losing its
 * network (offline billing). Logs go to `<repo>/.tmp/w26/` (git-ignored); never to the console.
 *
 * Secrets are read from `backend/.env.uat` at runtime and passed only to child environments.
 */
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = resolve(backend, '../frontend');
const logDirectory = resolve(backend, '../.tmp/w26');
mkdirSync(logDirectory, { recursive: true });
// Each stack run starts fresh logs; earlier runs are kept with a timestamp suffix.
for (const name of ['backend', 'worker', 'preview']) {
  const file = resolve(logDirectory, `${name}.log`);
  if (existsSync(file)) renameSync(file, `${file}.${Date.now()}`);
}
const base = Number(process.env.W26_PORT_BASE ?? '4760');
const ports = {
  web: base,
  webPrivate: base + 1,
  backendGate: base + 2,
  backend: base + 3,
  control: base + 4,
  reverse: base + 5,
  egress: base + 6,
  redis: base + 7,
};
const say = (message: string) => process.stdout.write(`[uat-stack] ${message}\n`);

// ---- 1. Environment and host check ------------------------------------------------------
const fileEnv = parseEnv(readFileSync(resolve(backend, '.env.uat'), 'utf8')) as Record<
  string,
  string
>;
/** UAT HTTP services, reached only through the reverse proxy. */
const uatHosts = new Set([
  'api-uat.thesouledstore.com',
  'observer-uat.thesouledstore.com',
  'stag-tss.thesouledstore.com',
  'mapi-uat.thesouledstore.com',
  'instore-ism.uat.pinelabs.com',
  'securegw-stage.paytm.in',
  'uat-backend-tss-sync.thesouledstore.com',
]);
/** Browser-facing UAT links (never called by the backend). */
const browserHosts = new Set([
  'uat.thesouledstore.com',
  'unimpertinent-cliffier-addyson.ngrok-free.dev',
]);
/** Static download link only (APK); not called by the backend. */
const linkHosts = new Set(['mpos-mobile-build.s3.ap-south-1.amazonaws.com']);
/** Hosts allowed through the egress proxy (BigQuery reads only). */
const egressAllow = new Set([
  'bigquery.googleapis.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
]);
/** UAT hosts used by modules that accept only HTTPS (no loopback exception). */
const directUatHosts = new Set(['stag-tss.thesouledstore.com']);
/** Messaging adapters and their credentials: removed, so each adapter is unconfigured. */
const messagingKeys = [
  'NETCORE_EMAIL_URL',
  'NETCORE_API_KEY',
  'GUPSHUP_SMS_USER_ID',
  'GUPSHUP_SMS_PASSWORD',
  'GUPSHUP_WHATSAPP_USER_ID',
  'GUPSHUP_WHATSAPP_PASSWORD',
  'WHATSAPP_GUPSHUP_API_URL',
  'SLACK_URL',
  'SLACK_DEMO_URL',
  'LOGIN_SECURITY_SLACK_WEBHOOK',
  'SLACK_WHATSAPP_ALERT_WEBHOOK',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS',
  'FRESHDESK_TICKET_URL',
  'FRESHDESK_BASIC_AUTH_USERNAME',
  'FRESHDESK_BASIC_AUTH_PASSWORD',
  'MJML_HOST',
  'AWS_STORAGE_BUCKET_NAME',
];
/**
 * W26_MESSAGING=live (after the W25 outbound allowlist guard was merged): the messaging adapters
 * keep their UAT credentials and every send goes through the guard, which delivers only to the
 * listed phone, email and Slack webhook. Refused unless the file enables the allowlist with all
 * three lists non-empty. Freshdesk (production helpdesk), Slack OAuth and the S3 bucket stay out.
 */
const liveMessaging = process.env.W26_MESSAGING === 'live';
if (liveMessaging) {
  const enabled = (fileEnv['OUTBOUND_ALLOWLIST_ENABLED'] ?? '').toLowerCase() === 'true';
  const lists = [
    'OUTBOUND_ALLOWLIST_PHONES',
    'OUTBOUND_ALLOWLIST_EMAILS',
    'OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS',
  ];
  if (!enabled || lists.some((key) => !(fileEnv[key] ?? '').trim())) {
    say('refusing live messaging: the outbound allowlist is not enabled with all three lists');
    process.exit(1);
  }
}
const removedKeys = liveMessaging
  ? [
      'SLACK_CLIENT_ID',
      'SLACK_CLIENT_SECRET',
      'FRESHDESK_TICKET_URL',
      'FRESHDESK_BASIC_AUTH_USERNAME',
      'FRESHDESK_BASIC_AUTH_PASSWORD',
      'AWS_STORAGE_BUCKET_NAME',
    ]
  : messagingKeys;
/** Messaging providers reachable directly in live mode; the allowlist guard checks recipients. */
const messagingEgress = [
  'emailapi.netcorecloud.net',
  'enterprise.smsgupshup.com',
  'mediaapi.smsgupshup.com',
  'hooks.slack.com',
];
if (liveMessaging) for (const host of messagingEgress) egressAllow.add(host);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(fileEnv))
  if (!removedKeys.includes(key)) env[key] = value;

const proxied = (url: URL) =>
  `http://127.0.0.1:${ports.reverse}/_h/${url.host}${url.pathname}${url.search}`;
const problems: string[] = [];
for (const [key, value] of Object.entries(env)) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) continue;
  const url = new URL(value);
  if (url.protocol === 'mysql:') {
    if (!/^uat-[a-z0-9-]+\.cluster-[a-z0-9]+\.ap-south-1\.rds\.amazonaws\.com$/.test(url.hostname))
      problems.push(`${key}: MySQL host is not a UAT cluster`);
  } else if (url.protocol === 'redis:' || url.protocol === 'rediss:') {
    if (url.host !== (fileEnv['UAT_EXPECTED_REDIS'] ?? '<unset>')) problems.push(`${key}: Redis is not the UAT Redis`);
  } else if (directUatHosts.has(url.hostname)) {
    // HTTPS-only module (application links); reached directly through the egress allowlist.
    egressAllow.add(url.hostname);
  } else if (uatHosts.has(url.hostname)) {
    env[key] = proxied(url);
  } else if (liveMessaging && messagingEgress.includes(url.hostname)) {
    // Provider endpoint, reached through the egress proxy; the allowlist guard checks recipients.
  } else if (!browserHosts.has(url.hostname) && !linkHosts.has(url.hostname)) {
    problems.push(`${key}: host is not on the UAT list`);
  }
}
if (problems.length) {
  say(`refusing to start:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const redisTarget = new URL(fileEnv['REDIS_URL'] ?? '');
// Legacy reads PAYTM_PROD_URL (terminal_helpers.py:397); the UAT file names it PAYTM_URL.
if (fileEnv['PAYTM_URL']) env['PAYTM_PROD_URL'] = proxied(new URL(fileEnv['PAYTM_URL']));
const emptyAwsFile = resolve(logDirectory, 'aws-empty');
writeFileSync(emptyAwsFile, '');
const childEnvironment = (overrides: Record<string, string>) => {
  const inherited: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'SHELL'])
    if (process.env[key]) inherited[key] = process.env[key]!;
  return {
    ...inherited,
    ...env,
    HOST: '127.0.0.1',
    PORT: String(ports.backend),
    WEB_ORIGIN: `http://localhost:${ports.web}`,
    // Rewrite-only redirect allowlist (S42); the UAT file has no entry for the UAT site.
    POS_CUSTOMER_APP_ORIGINS: 'https://uat.thesouledstore.com',
    SESSION_COOKIE_SECURE: 'false',
    API_RATE_LIMIT_PER_MINUTE: '5000',
    REDIS_URL: `redis://127.0.0.1:${ports.redis}/0`,
    ...(liveMessaging
      ? {}
      : {
          LOGIN_OTP_DELIVERY: 'sandbox',
          COMMON_GROUP_ALERT_ON: '0',
          ENABLE_WHATSAPP_INVOICE: '0',
        }),
    AWS_SHARED_CREDENTIALS_FILE: emptyAwsFile,
    AWS_CONFIG_FILE: emptyAwsFile,
    AWS_EC2_METADATA_DISABLED: 'true',
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: `http://127.0.0.1:${ports.egress}`,
    HTTP_PROXY: `http://127.0.0.1:${ports.egress}`,
    NO_PROXY: '127.0.0.1,localhost',
    ...overrides,
  };
};

// ---- Logs ---------------------------------------------------------------------------------
const callLog = createWriteStream(resolve(logDirectory, 'outbound-calls.jsonl'), { flags: 'a' });
interface Call {
  at: string;
  via: 'reverse' | 'egress';
  method: string;
  host: string;
  path: string;
  status: number | string;
  ms: number;
  blocked?: string;
}
const calls: Call[] = [];
function record(call: Call) {
  calls.push(call);
  callLog.write(`${JSON.stringify(call)}\n`);
}

// ---- 3. UAT reverse proxy -----------------------------------------------------------------
/** Messaging endpoints: never forwarded until the allowlist guard is merged. */
const messagingPath =
  /(omnichannel|send-?otp|send_otp|verify-?otp|verify_otp|mailr|whatsapp|\/sms\b|sms\/|email|mail\/send|notify)/i;
const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'host',
]);
const reverse = createHttpServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
  const started = performance.now();
  const target = new URL(incoming.url ?? '/', 'http://local');
  const match = /^\/_h\/([^/]+)(\/.*)?$/.exec(target.pathname);
  const host = match?.[1] ?? '';
  const path = match?.[2] ?? '/';
  const method = incoming.method ?? 'GET';
  const refuse = (status: number, reason: string) => {
    record({
      at: new Date().toISOString(),
      via: 'reverse',
      method,
      host,
      path,
      status,
      ms: 0,
      blocked: reason,
    });
    incoming.resume();
    outgoing.writeHead(status, { 'content-type': 'application/json' });
    outgoing.end(
      JSON.stringify({ status: 'error', success: false, message: `W26 UAT guard: ${reason}` }),
    );
  };
  if (!uatHosts.has(host)) return refuse(403, 'host not on the UAT list');
  if (!liveMessaging && messagingPath.test(path))
    return refuse(503, 'messaging blocked pending allowlist');
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming.headers))
    if (value !== undefined && !hopHeaders.has(key)) headers[key] = value;
  headers['host'] = host;
  const upstream = httpsRequest(
    { host, port: 443, method, path: path + target.search, headers, timeout: 60000 },
    (reply) => {
      record({
        at: new Date().toISOString(),
        via: 'reverse',
        method,
        host,
        path,
        status: reply.statusCode ?? 0,
        ms: Math.round(performance.now() - started),
      });
      const replyHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(reply.headers))
        if (value !== undefined && !hopHeaders.has(key)) replyHeaders[key] = value;
      outgoing.writeHead(reply.statusCode ?? 502, replyHeaders);
      reply.pipe(outgoing);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (error: NodeJS.ErrnoException) => {
    record({
      at: new Date().toISOString(),
      via: 'reverse',
      method,
      host,
      path,
      status: error.code ?? 'ERROR',
      ms: Math.round(performance.now() - started),
    });
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
});

// ---- 4. Egress allowlist (CONNECT) proxy --------------------------------------------------
const egress = createHttpServer((incoming, outgoing) => {
  let host = '';
  try {
    host = new URL(incoming.url ?? '').host;
  } catch {
    host = '';
  }
  record({
    at: new Date().toISOString(),
    via: 'egress',
    method: incoming.method ?? 'GET',
    host,
    path: '',
    status: 403,
    ms: 0,
    blocked: 'plain HTTP egress refused',
  });
  outgoing.writeHead(403);
  outgoing.end();
});
egress.on('connect', (incoming: IncomingMessage, client: Socket, head: Buffer) => {
  const [host = '', port = '443'] = (incoming.url ?? '').split(':');
  if (!egressAllow.has(host) || port !== '443') {
    record({
      at: new Date().toISOString(),
      via: 'egress',
      method: 'CONNECT',
      host,
      path: '',
      status: 403,
      ms: 0,
      blocked: 'host not on the egress allowlist',
    });
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  record({
    at: new Date().toISOString(),
    via: 'egress',
    method: 'CONNECT',
    host,
    path: '',
    status: 200,
    ms: 0,
  });
  const upstream = createConnection({ host, port: 443 }, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const drop = () => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  client.on('error', drop);
});

// ---- 5. Redis relay ------------------------------------------------------------------------
const relaySockets = new Set<Socket>();
const redisRelay = createServer((client) => {
  const upstream = createConnection({
    host: redisTarget.hostname,
    port: Number(redisTarget.port || '6379'),
  });
  relaySockets.add(client).add(upstream);
  // Detect a silently dropped VPN path to UAT Redis, so the app sees a closed socket and reconnects.
  upstream.setKeepAlive(true, 5000);
  upstream.setNoDelay(true);
  const drop = () => {
    client.destroy();
    upstream.destroy();
    relaySockets.delete(client);
    relaySockets.delete(upstream);
  };
  client.on('error', drop).on('close', drop);
  upstream.on('error', drop).on('close', drop);
  client.pipe(upstream);
  upstream.pipe(client);
});

// ---- Processes -------------------------------------------------------------------------------
const cleanups: (() => Promise<void>)[] = [];
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => say('cleanup step failed'));
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => void stop(0));

function startChild(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  childEnv: NodeJS.ProcessEnv,
) {
  const out = createWriteStream(resolve(logDirectory, `${name}.log`), { flags: 'a' });
  const child = spawn(command, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  say(`${name} started (pid ${child.pid})`);
  return child;
}
async function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  await exited;
  clearTimeout(timer);
}

let server: ChildProcess | null = null;
let worker: ChildProcess | null = null;
let limits: Record<string, string> = {
  OFFLINE_BILLING_MAX_MINUTES: env['OFFLINE_BILLING_MAX_MINUTES'] ?? '120',
  OFFLINE_BILLING_MAX_ORDERS: env['OFFLINE_BILLING_MAX_ORDERS'] ?? '10',
};
async function startBackend() {
  await stopChild(server);
  const child = startChild(
    'backend',
    process.execPath,
    ['--import', 'tsx', resolve(backend, process.env.W26_BACKEND_ENTRY ?? 'src/server.ts')],
    backend,
    childEnvironment(limits),
  );
  server = child;
  child.once('exit', (code) => {
    if (!stopping && server === child) say(`backend exited (${code ?? 'signal'})`);
  });
  for (let attempt = 0; attempt < 240; attempt++) {
    const ready = await fetch(`http://127.0.0.1:${ports.backend}/health/ready`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    if (child.exitCode !== null) throw new Error('The backend exited during start-up.');
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('The backend did not become ready.');
}

// TCP gates (as the W17 offline stack): `up: false` refuses the web origin and the backend,
// as a device without network sees it; `backend: false` cuts only the store service.
let up = true,
  backendUp = true;
const gateSockets = new Map<Socket, boolean>();
async function openGate(listenPort: number, targetPort: number, isBackend: boolean) {
  const gate = createServer((client) => {
    if (!up || (isBackend && !backendUp)) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: '127.0.0.1', port: targetPort });
    gateSockets.set(client, isBackend).set(upstream, isBackend);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      gateSockets.delete(client);
      gateSockets.delete(upstream);
    };
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await listen(gate, listenPort);
  cleanups.push(() => new Promise<void>((done) => gate.close(() => done())));
}
function listen(
  target: {
    listen: (port: number, host: string, done: () => void) => unknown;
    once: (event: 'error', fail: (error: Error) => void) => unknown;
  },
  port: number,
) {
  return new Promise<void>((done, fail) => {
    target.once('error', fail);
    target.listen(port, '127.0.0.1', () => done());
  });
}
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

try {
  await listen(reverse, ports.reverse);
  cleanups.push(() => new Promise<void>((done) => reverse.close(() => done())));
  await listen(egress, ports.egress);
  cleanups.push(() => new Promise<void>((done) => egress.close(() => done())));
  await listen(redisRelay, ports.redis);
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        for (const socket of relaySockets) socket.destroy();
        redisRelay.close(() => done());
      }),
  );
  cleanups.push(() => stopChild(server));
  await startBackend();
  say(`backend ready on ${ports.backend}`);
  worker = startChild(
    'worker',
    process.execPath,
    ['--import', 'tsx', resolve(backend, 'src/jobs/worker-main.ts')],
    backend,
    childEnvironment(limits),
  );
  cleanups.push(() => stopChild(worker));
  if (liveMessaging) {
    // Both processes must log `outbound.allowlist.active` with non-zero list sizes (sizes only).
    for (const name of ['backend', 'worker']) {
      let confirmed = false;
      for (let attempt = 0; attempt < 120 && !confirmed; attempt++) {
        const file = resolve(logDirectory, `${name}.log`);
        const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n');
        confirmed = lines.some((line) => {
          if (!line.includes('outbound.allowlist.active')) return false;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            return ['phones', 'emails', 'slackWebhooks'].every(
              (key) => typeof event[key] === 'number' && (event[key] as number) > 0,
            );
          } catch {
            return false;
          }
        });
        if (!confirmed) await new Promise((done) => setTimeout(done, 500));
      }
      if (!confirmed) throw new Error(`${name} did not confirm the outbound allowlist guard.`);
      say(`${name}: outbound allowlist guard active with non-empty lists`);
    }
  }
  if (!existsSync(resolve(frontend, 'dist/index.html')))
    throw new Error('Build the frontend first (npm run build).');
  const preview = startChild(
    'preview',
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--config',
      'e2e-desktop/vite.preview.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(ports.webPrivate),
      '--strictPort',
    ],
    frontend,
    {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      E2E_DESKTOP_PORT_BASE: String(base),
    },
  );
  cleanups.push(() => stopChild(preview));
  await openGate(ports.backendGate, ports.backend, true);
  await openGate(ports.web, ports.webPrivate, false);
  cleanups.push(async () => {
    for (const socket of gateSockets.keys()) socket.destroy();
  });

  const control = createHttpServer((request, response) => {
    void (async () => {
      try {
        const target = new URL(request.url ?? '/', 'http://127.0.0.1');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const input = (chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}) as Record<
          string,
          unknown
        >;
        if (target.pathname === '/ready')
          return json(response, server && worker ? 200 : 503, { up, backendUp });
        if (target.pathname === '/pids')
          return json(response, 200, {
            stack: process.pid,
            backend: server?.pid,
            worker: worker?.pid,
            preview: preview.pid,
          });
        if (target.pathname === '/network' && request.method === 'POST') {
          up = input['up'] === true;
          backendUp = input['backend'] !== false;
          for (const [socket, isBackend] of gateSockets)
            if (!up || (isBackend && !backendUp)) socket.destroy();
          return json(response, 200, { up, backendUp });
        }
        if (target.pathname === '/backend/restart' && request.method === 'POST') {
          limits = {
            OFFLINE_BILLING_MAX_MINUTES: String(
              input['maxMinutes'] ?? limits['OFFLINE_BILLING_MAX_MINUTES'],
            ),
            OFFLINE_BILLING_MAX_ORDERS: String(
              input['maxOrders'] ?? limits['OFFLINE_BILLING_MAX_ORDERS'],
            ),
            // Narrows scheduled day-close alerts to the test store (default: legacy 'COCO').
            ...(typeof input['dayCloseStores'] === 'string' &&
            /^[0-9,]+$/.test(input['dayCloseStores'])
              ? { DAY_CLOSE_ENABLED_STORE_IDS: input['dayCloseStores'] }
              : {}),
          };
          await startBackend();
          return json(response, 200, { limits });
        }
        if (target.pathname === '/calls') {
          const since = Number(target.searchParams.get('since') ?? '0');
          return json(response, 200, { total: calls.length, calls: calls.slice(since) });
        }
        return json(response, 404, { error: 'unknown control path' });
      } catch (error) {
        return json(response, 500, { error: error instanceof Error ? error.message : 'failed' });
      }
    })();
  });
  await listen(control, ports.control);
  cleanups.push(() => new Promise<void>((done) => control.close(() => done())));
  say(`ready: workspace http://localhost:${ports.web}, control http://127.0.0.1:${ports.control}`);
} catch (error) {
  say(`startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  await stop(1);
}
