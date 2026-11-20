import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real web-image nginx configuration (the pinned runtime stage of frontend/Dockerfile, with
 * frontend/nginx/*) and checks that every response carries the security headers. nginx drops the
 * server-level add_header list in any location with its own add_header, so this covers each location.
 *
 * Needs a Linux Docker engine. Skipped when none is reachable, unless POS_NGINX_HEADERS_REQUIRED=1
 * (CI), which turns a missing engine into a failure.
 */
const frontend = join(import.meta.dirname, '..', '..');
const nginxDir = join(frontend, 'nginx');
const required = process.env.POS_NGINX_HEADERS_REQUIRED === '1';
const run = promisify(execFile);
const docker = (args: string[], timeout = 60_000) =>
  run('docker', args, { timeout, maxBuffer: 4_000_000 });

const engineAvailable = await docker(['info', '--format', '{{.OSType}}'], 15_000).then(
  (result) => result.stdout.trim() === 'linux',
  () => false,
);
if (required && !engineAvailable)
  throw new Error('POS_NGINX_HEADERS_REQUIRED=1 but no Linux Docker engine is reachable.');

/** The runtime stage of the production Dockerfile, serving a fixture bundle instead of the build stage. */
const runtimeStage = () => {
  const lines = readFileSync(join(frontend, 'Dockerfile'), 'utf8').split('\n');
  const start = lines.findIndex((line) =>
    /^FROM nginxinc\/nginx-unprivileged:\S+@sha256:\S+ AS runtime$/.test(line),
  );
  if (start < 0) throw new Error('Pinned nginx runtime stage not found in frontend/Dockerfile.');
  const stage = lines.slice(start).join('\n');
  const bundle = 'COPY --from=build /app/dist /usr/share/nginx/html';
  if (!stage.includes(bundle)) throw new Error('Runtime stage no longer copies the build output.');
  return stage.replace(bundle, 'COPY html /usr/share/nginx/html');
};

const spa = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};
const api = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

describe('nginx configuration', () => {
  const config = readFileSync(join(nginxDir, 'default.conf.template'), 'utf8');

  it('merges the server-level security headers into every location', () => {
    const server = config.slice(0, config.indexOf('  location'));
    expect(server).toMatch(/^\s*add_header_inherit merge;$/m);
    for (const [name, value] of Object.entries(spa))
      expect(server).toContain(
        `add_header ${name} ${value.includes(' ') ? `"${value}"` : value} always;`,
      );
  });
});

describe.skipIf(!engineAvailable)('nginx security headers (pinned web image)', () => {
  const name = `pos-nginx-headers-${randomUUID()}`;
  const context = mkdtempSync(join(tmpdir(), 'pos-nginx-headers-'));
  let origin = '';

  beforeAll(async () => {
    mkdirSync(join(context, 'nginx'));
    for (const file of ['nginx.conf', 'default.conf.template', 'entrypoint.sh'])
      copyFileSync(join(nginxDir, file), join(context, 'nginx', file));
    mkdirSync(join(context, 'html', 'assets'), { recursive: true });
    writeFileSync(
      join(context, 'html', 'index.html'),
      '<!doctype html><html><head><title>Retail POS</title><script type="module" src="/assets/app-fixture.js"></script></head><body><div id="root"></div></body></html>',
    );
    writeFileSync(join(context, 'html', 'assets', 'app-fixture.js'), 'export {};\n');
    writeFileSync(
      join(context, 'html', 'service-worker.js'),
      'self.addEventListener("fetch", () => {});\n',
    );
    writeFileSync(join(context, 'Dockerfile'), runtimeStage());
    await docker(['build', '--quiet', '--tag', name, context], 600_000);
    // The API upstream is a closed port: the proxy answers 502 itself, which exercises the API location.
    await docker([
      'run',
      '--detach',
      '--name',
      name,
      '--env',
      'API_UPSTREAM=127.0.0.1:9',
      '--publish',
      '127.0.0.1::8080',
      name,
    ]);
    const port = (await docker(['port', name, '8080/tcp'])).stdout
      .trim()
      .split('\n')[0]
      ?.split(':')
      .pop();
    if (!port) throw new Error('nginx port was not published.');
    origin = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        if ((await fetch(`${origin}/health/static`, { signal: AbortSignal.timeout(1000) })).ok)
          return;
      } catch {
        // not listening yet
      }
      await delay(250);
    }
    throw new Error('nginx did not become ready.');
  }, 660_000);

  afterAll(async () => {
    await docker(['rm', '--force', name]).catch(() => undefined);
    await docker(['image', 'rm', '--force', name]).catch(() => undefined);
    rmSync(context, { recursive: true, force: true });
  }, 60_000);

  const get = (path: string) => fetch(origin + path, { redirect: 'manual' });
  const expectHeaders = (response: Response, expected: Record<string, string>) => {
    // fetch joins repeated headers with ", ", so an exact match also rules out duplicates.
    for (const [header, value] of Object.entries(expected))
      expect(response.headers.get(header), header).toBe(value);
  };

  it.each([
    ['/', 'no-cache'],
    ['/some/spa/route', 'no-cache'],
    ['/index.html', 'no-cache'],
    ['/assets/app-fixture.js', 'public,max-age=31536000,immutable'],
    ['/service-worker.js', 'no-cache'],
  ])('%s carries the security headers and its cache policy', async (path, cacheControl) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expectHeaders(response, { ...spa, 'Cache-Control': cacheControl });
  });

  it('serves the SPA shell for client-side routes', async () => {
    expect(await (await get('/some/spa/route')).text()).toContain('<title>Retail POS</title>');
  });

  it.each(['/health/static', '/assets/missing-fixture.js'])(
    '%s (no cache policy) carries them too',
    async (path) => {
      const response = await get(path);
      expectHeaders(response, spa);
      expect(response.headers.get('Cache-Control')).toBeNull();
    },
  );

  it('leaves the framing policy of API responses to the backend', async () => {
    // Invoice and shipping-label previews are API documents framed by the SPA (frame-ancestors 'self').
    const response = await get('/api/v1/fixture');
    expect(response.status).toBe(502);
    expectHeaders(response, api);
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
  });
});
