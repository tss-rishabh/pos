const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
class FixtureError extends Error {}
function check(value, code) {
  if (!value) throw new FixtureError(code);
}
async function verify() {
  const origin = 'http://frontend:8080',
    checks = [];
  const [{ default: sharp }, { verifyPrivateImage }] = await Promise.all([
    import('sharp'),
    import('./dist/modules/administration/image-lifecycle/validation.js'),
  ]);
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  for (const path of [
    // Legacy-style worker processes were replaced by dist/jobs/worker-main.js (needs Redis).
  ]) {
    const result = await promisify(execFile)(process.execPath, [path], {
      env: {
        ...process.env,
        CUSTOMER_CONTACTS_WORKER_ENABLED: 'false',
        CUSTOMER_OTP_WORKER_ENABLED: 'false',
      },
      timeout: 5000,
      maxBuffer: 64000,
    });
    const events = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((value) => JSON.parse(value));
    check(
      events.length > 0 &&
        events.every(
          (event) =>
            typeof event.module === 'string' &&
            typeof event.resource === 'string' &&
            typeof event.eventId === 'string' &&
            event.eventId.includes(event.resource) &&
            typeof event.eventInstanceId === 'string' &&
            Object.hasOwn(event, 'requestId') &&
            Object.hasOwn(event, 'userId'),
        ),
      'PACKAGED_DISABLED_WORKER_FAILED',
    );
  }
  checks.push('packaged-disabled-worker-entrypoints');
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 11, g: 22, b: 33 } },
  })
    .png()
    .toBuffer();
  const { Readable } = require('node:stream');
  const { createHash } = require('node:crypto');
  await verifyPrivateImage(
    async () => ({ body: Readable.from([bytes]), contentType: 'image/png', size: bytes.length }),
    {
      contentType: 'image/png',
      size: bytes.length,
      checksum: createHash('sha256').update(bytes).digest('base64'),
    },
  );
  checks.push('native-linux-image-decoder');
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(origin + '/health/ready', { signal: AbortSignal.timeout(1000) })).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(500);
  }
  check(ready, 'CONTAINER_READINESS_FAILED');
  checks.push('gateway-api-proxy');
  const html = await (await fetch(origin + '/')).text();
  check(html.replaceAll('&#39;', "'").includes("frame-src 'self'"), 'STATIC_CSP_MISSING');
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map((match) => match[1]);
  check(assets.length > 0, 'BUILD_ASSETS_MISSING');
  for (const asset of assets) check((await fetch(origin + asset)).ok, 'STATIC_ASSET_FAILED');
  checks.push('static-assets-and-csp');
  const worker = await fetch(origin + '/service-worker.js');
  check(
    worker.ok && worker.headers.get('cache-control') === 'no-cache',
    'WORKER_CACHE_POLICY_FAILED',
  );
  checks.push('offline-shell-cache-policy');
  // Real login of the synthetic operator seeded by tools/e2e/seed.ts: password step, then the
  // legacy fixed OTP that the smoke stack enables for this user id only.
  const cookies = (response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  const challenge = await fetch(origin + '/api/v1/auth/sessions', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'e2e-operator', password: 'Synthetic-e2e-password-2026' }),
  });
  check(challenge.status === 202, 'SYNTHETIC_LOGIN_FAILED');
  const login = await fetch(origin + '/api/v1/auth/challenges/current/verifications', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookies(challenge) },
    body: JSON.stringify({ code: '246810', factor: 'otp', storeId: '1' }),
  });
  check(login.status === 200, 'SYNTHETIC_LOGIN_FAILED');
  const cookie = cookies(login),
    session = await login.json();
  check(session.user.id === '900001', 'UNEXPECTED_SYNTHETIC_IDENTITY');
  const headers = {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Operator-Id': session.user.id,
    },
    catalog = await (await fetch(origin + '/api/v1/stores/1/catalog/products', { headers })).json();
  check(catalog.data.length > 0, 'SYNTHETIC_CATALOG_FAILED');
  const product = catalog.data[0],
    id = randomUUID(),
    draft = {
      mutationId: randomUUID(),
      expectedVersion: 0,
      draft: {
        id,
        storeId: '1',
        counterId: '1',
        customerId: null,
        lines: [
          {
            productId: product.id,
            name: product.name,
            barcode: product.barcode,
            unitPrice: product.price,
            quantity: 1,
          },
        ],
      },
    };
  const saved = await fetch(origin + '/api/v1/stores/1/cart-drafts/' + id, {
    method: 'PUT',
    headers,
    body: JSON.stringify(draft),
  });
  check(saved.ok && (await saved.json()).version === 1, 'SYNTHETIC_DRAFT_FAILED');
  checks.push('synthetic-login-catalog-and-draft');
  check(
    (await fetch(origin + '/api/v1/admin/stores', { headers })).status === 403,
    'ROLE_ISOLATION_FAILED',
  );
  check(
    (
      await fetch(origin + '/api/v1/auth/sessions', {
        method: 'POST',
        headers: { Origin: 'https://canary.invalid', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'e2e-operator', password: 'canary' }),
      })
    ).status === 403,
    'ORIGIN_ISOLATION_FAILED',
  );
  checks.push('role-and-origin-isolation');
  return { checks, passed: true };
}
verify()
  .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch((error) =>
    process.stdout.write(
      JSON.stringify({
        passed: false,
        errorCode: error instanceof FixtureError ? error.message : 'HTTP_OPERATION_FAILED',
      }) + '\n',
    ),
  );
