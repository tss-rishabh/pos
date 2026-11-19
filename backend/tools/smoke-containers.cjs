// Synthetic verification runs entirely inside a network without Internet or published ports.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes, randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const run = promisify(execFile),
  suffix = randomUUID().slice(0, 8),
  network = 'pos-rewrite-verify-' + suffix,
  seedNetwork = 'pos-rewrite-seed-' + suffix,
  mysql = 'pos-rewrite-mysql-' + suffix,
  redis = 'pos-rewrite-redis-' + suffix,
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
    // Real dependencies replace the former demo backend. MySQL is first reachable from this
    // host on a loopback-only port of a temporary seed network, so the TypeScript seed
    // (tools/e2e/seed.ts: production snapshot schema + synthetic rows) can run; it is then
    // detached so the stack only sees the internal network. The backend and Redis share the
    // MySQL container's network namespace, so both dependencies are plain loopback for the
    // backend (MYSQL_ALLOW_LOCAL_PLAINTEXT applies only to loopback) and `backend` resolves to it.
    await docker([
      'network',
      'create',
      '--label',
      'application=pos-rewrite-verification',
      seedNetwork,
    ]);
    await docker([
      'run',
      '--detach',
      '--name',
      mysql,
      '--network',
      seedNetwork,
      '--publish',
      '127.0.0.1::3306',
      '--tmpfs',
      '/var/lib/mysql:rw,size=512m',
      '--env',
      'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
      process.env.POS_MYSQL_TEST_IMAGE || 'mysql:8.4',
      '--sql-mode=',
      '--bind-address=0.0.0.0',
      '--mysqlx=OFF',
    ]);
    await docker(['network', 'connect', '--alias', 'backend', network, mysql]);
    const published = (await docker(['port', mysql, '3306/tcp'])).stdout.trim().split(':').pop();
    let seeded = false;
    for (let attempt = 0; attempt < 90 && !seeded; attempt++) {
      const logs = await docker(['logs', mysql]).catch(() => ({ stdout: '', stderr: '' }));
      if (/ready for connections.*port: 3306/.test(logs.stdout + logs.stderr))
        seeded = await run(process.execPath, ['--import', 'tsx', 'tools/e2e/seed.ts'], {
          cwd: resolve(__dirname, '..'),
          env: {
            PATH: process.env.PATH,
            E2E_MYSQL_URL: 'mysql://root@127.0.0.1:' + published + '/pos_rewrite_e2e',
          },
          timeout: 120000,
        }).then(
          () => true,
          () => false,
        );
      if (!seeded) await new Promise((done) => setTimeout(done, 1000));
    }
    check(seeded, 'SYNTHETIC_SEED_FAILED');
    await docker(['network', 'disconnect', seedNetwork, mysql]);
    await docker([
      'run',
      '--detach',
      '--name',
      redis,
      '--network',
      'container:' + mysql,
      process.env.POS_REDIS_TEST_IMAGE || 'redis:7',
      'redis-server',
      '--bind',
      '127.0.0.1',
      '--save',
      '',
      '--appendonly',
      'no',
      '--maxmemory-policy',
      'noeviction',
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
        ...safety.map((value) => (value === network ? 'container:' + mysql : value)),
        '--env',
        'NODE_ENV=test',
        '--env',
        'SESSION_SECRET',
        '--env',
        'WEB_ORIGIN=http://frontend:8080',
        ...['MYSQL_WRITER_URL', 'MYSQL_PRIMARY_READER_URL', 'MYSQL_DATA_READER_URL'].flatMap(
          (name) => ['--env', name + '=mysql://root@127.0.0.1:3306/pos_rewrite_e2e'],
        ),
        '--env',
        'MYSQL_ALLOW_LOCAL_PLAINTEXT=true',
        '--env',
        'REDIS_URL=redis://127.0.0.1:6379/0',
        // Sandbox OTP transport plus the legacy fixed OTP for the seeded synthetic operator only.
        '--env',
        'LOGIN_OTP_DELIVERY=sandbox',
        '--env',
        'LOGIN_FIXED_OTP_ENABLED=1',
        '--env',
        'LOGIN_FIXED_OTP=246810',
        '--env',
        'LOGIN_FIXED_OTP_USER_IDS=900001',
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
      [backend, frontend, redis, mysql].map((name) =>
        docker(['rm', '--force', name]).catch(() => undefined),
      ),
    );
    await docker(['network', 'rm', network]).catch(() => undefined);
    await docker(['network', 'rm', seedNetwork]).catch(() => undefined);
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
