const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
class FixtureError extends Error {}
function check(value, code) {
  if (!value) throw new FixtureError(code);
}
async function verify() {
  const origin = 'http://frontend:8080',
    checks = [];
  const [{ migrationPlan }, { default: sharp }, { verifyPrivateImage }] = await Promise.all([
    import('./dist/db/migrations.js'),
    import('sharp'),
    import('./dist/modules/administration/image-lifecycle/validation.js'),
  ]);
  const plan = migrationPlan();
  check(
    plan.length > 0 &&
      plan.every(
        (migration) => migration.statements.length && /^[a-f0-9]{64}$/.test(migration.checksum),
      ),
    'PACKAGED_MIGRATIONS_FAILED',
  );
  checks.push('packaged-migration-plan');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  for (const path of [
    './dist/modules/customer-contacts/worker-main.js',
    './dist/modules/customer-otp/worker-main.js',
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
  const login = await fetch(origin + '/api/v1/auth/demo-sessions', {
    method: 'POST',
    headers: { Origin: origin },
  });
  check(login.status === 200, 'SYNTHETIC_LOGIN_FAILED');
  const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
    session = await login.json();
  check(session.user.id === '900001', 'UNEXPECTED_DEMO_IDENTITY');
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
    'DEMO_ISOLATION_FAILED',
  );
  check(
    (
      await fetch(origin + '/api/v1/auth/demo-sessions', {
        method: 'POST',
        headers: { Origin: 'https://canary.invalid' },
      })
    ).status === 403,
    'ORIGIN_ISOLATION_FAILED',
  );
  checks.push('demo-and-origin-isolation');
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
