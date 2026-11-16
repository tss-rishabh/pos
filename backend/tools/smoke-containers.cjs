// Synthetic verification runs entirely inside a network without Internet or published ports.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes, randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const run = promisify(execFile),
  suffix = randomUUID().slice(0, 8),
  network = 'pos-rewrite-verify-' + suffix,
  backend = 'pos-rewrite-backend-' + suffix,
  frontend = 'pos-rewrite-frontend-' + suffix,
  secret = randomBytes(48).toString('base64url');
class SmokeError extends Error {}
function check(value, message) {
  if (!value) throw new SmokeError(message);
}
async function docker(args, env = {}) {
  return run('docker', args, {
    env: { ...process.env, ...env },
    maxBuffer: 2000000,
    timeout: 60000,
  });
}
async function main() {
  let passed = false;
  try {
    await docker([
      'network',
      'create',
      '--internal',
      '--label',
      'application=pos-rewrite-verification',
      network,
    ]);
    const safety = [
      '--network',
      network,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
    ];
    await docker(
      [
        'run',
        '--detach',
        '--name',
        backend,
        '--network-alias',
        'backend',
        ...safety,
        '--env',
        'NODE_ENV=test',
        '--env',
        'DEMO_MODE=true',
        '--env',
        'SESSION_SECRET',
        '--env',
        'WEB_ORIGIN=http://frontend:8080',
        process.env.POS_BACKEND_TEST_IMAGE || 'pos-rewrite-backend:verification',
      ],
      { SESSION_SECRET: secret },
    );
    await docker([
      'run',
      '--detach',
      '--name',
      frontend,
      '--network-alias',
      'frontend',
      ...safety,
      process.env.POS_FRONTEND_TEST_IMAGE || 'pos-rewrite-frontend:verification',
    ]);
    const source = readFileSync(resolve(__dirname, 'container-fixture.cjs'), 'utf8');
    const result = JSON.parse((await docker(['exec', backend, 'node', '-e', source])).stdout);
    check(
      result.passed === true,
      typeof result.errorCode === 'string' && /^[A-Z_]+$/.test(result.errorCode)
        ? result.errorCode
        : 'CONTAINER_FIXTURE_FAILED',
    );
    const users = await Promise.all(
      [backend, frontend].map(async (name) =>
        JSON.parse((await docker(['inspect', '--format', '{{json .Config.User}}', name])).stdout),
      ),
    );
    check(
      users.every((user) => user && user !== '0' && user !== 'root'),
      'CONTAINER_USER_ISOLATION_FAILED',
    );
    // Exercise the proxy's own failure path: API callback URLs can carry
    // credentials, so even a refused upstream must never log the request URI.
    await docker(['stop', '--time', '5', backend]);
    await docker([
      'exec',
      frontend,
      'wget',
      '-q',
      '-T',
      '7',
      '-O',
      '/dev/null',
      'http://127.0.0.1:8080/api/v1/privacy-probe?email=operator@example.test&token=fixture.canary.invalid',
    ]).catch(() => undefined);
    const proxyLogs = (await docker(['logs', frontend])).stdout;
    const proxyEvents = proxyLogs
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    check(
      proxyEvents.some(
        (event) =>
          event.module === 'gateway' &&
          event.resource === 'http-request' &&
          event.status >= 500 &&
          event.requestId &&
          event.eventInstanceId,
      ),
      'PROXY_FAILURE_TRACE_MISSING',
    );
    const logs =
      (await docker(['logs', backend])).stdout + (await docker(['logs', frontend])).stdout;
    check(
      !logs.includes(secret) &&
        !logs.includes('operator@example.test') &&
        !logs.includes('canary.invalid'),
      'LOG_PRIVACY_CANARY_FAILED',
    );
    const evidence = {
      recordedAt: new Date().toISOString(),
      checks: [
        'read-only-non-root-containers',
        ...result.checks,
        'proxy-failure-tracing-without-uri',
        'log-privacy-canaries',
      ],
      passed: true,
    };
    writeFileSync(
      resolve(__dirname, '../evidence/container-smoke.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    process.stdout.write(JSON.stringify(evidence) + '\n');
    passed = true;
  } finally {
    if (!passed) {
      const diagnostics = await Promise.all(
        [backend, frontend].map(async (name) => {
          try {
            const state = (await docker(['inspect', '--format', '{{json .State}}', name])).stdout,
              logs = await docker(['logs', name]);
            return {
              name,
              state,
              logs: (logs.stdout + logs.stderr).replaceAll(secret, '[fixture secret]'),
            };
          } catch {
            return { name, state: 'unavailable' };
          }
        }),
      );
      mkdirSync(resolve(__dirname, '../evidence/private'), { recursive: true });
      writeFileSync(
        resolve(__dirname, '../evidence/private/container-smoke-failure.json'),
        JSON.stringify(diagnostics, null, 2) + '\n',
        { mode: 0o600 },
      );
    }
    await Promise.all(
      [backend, frontend].map((name) => docker(['rm', '--force', name]).catch(() => undefined)),
    );
    await docker(['network', 'rm', network]).catch(() => undefined);
  }
}
main().catch((error) => {
  process.stderr.write(
    'Synthetic container verification failed: ' +
      (error instanceof SmokeError ? error.message : 'DOCKER_OPERATION_FAILED') +
      '\n',
  );
  process.exitCode = 1;
});
