import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { readConfig } from '../../../src/config.ts';
import { buildApp } from '../../../src/app.ts';
import { createDatabases } from '../../../src/db/pools.ts';
import { identityService } from '../../../src/auth/identity.ts';
import { mysqlSessions } from '../../../src/auth/sessions.ts';
import { seal } from '../../../src/auth/crypto.ts';
import { splitMigration } from '../../../src/db/migrations.ts';
import { verifiedMysqlFixture } from '../../operational-reports/verified-mysql-fixture.ts';
import { nativeUiServer } from '../../global-reminders/native-ui-server.ts';
import { createWorkflowFixture, mysqlImage } from '../workflow-fixture.mjs';
import { sourceUiContract } from './source-ui.mjs';

const here = dirname(fileURLToPath(import.meta.url)),
  backend = resolve(here, '../../..');
process.chdir(backend);
assert.equal(process.versions.node, '24.22.3');
const input = z
  .object({
    database: z.url(),
    container: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().regex(/^[a-f0-9]{12}$/),
    python: z.string().startsWith('/'),
    sourceRoot: z.string().startsWith('/'),
    output: z.string().startsWith('/'),
  })
  .strict()
  .parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
assert(!existsSync(input.output), 'Output must be new');
const server = new URL(input.database);
assert(
  server.protocol === 'mysql:' &&
    server.hostname === '127.0.0.1' &&
    server.port &&
    server.port !== '54777' &&
    server.pathname === '/pos_rewrite_catalog_workflow_test' &&
    !server.search &&
    !server.hash,
);
const container = JSON.parse(
  execFileSync('docker', ['inspect', input.container], { encoding: 'utf8' }),
)[0];
assert.equal(container.Config.Image, mysqlImage);
assert.equal(container.Config.Labels['pos-rewrite.catalog-native-ui-nonce'], input.nonce);
assert(container.State.Running);
assert(
  container.NetworkSettings.Ports['3306/tcp'].some(
    (binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === server.port,
  ),
);
assert(!container.Mounts.some((mount) => mount.Type === 'bind'));
assert.equal(
  execFileSync('git', ['-C', input.sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
);
assert.equal(
  execFileSync('git', ['-C', input.sourceRoot, 'status', '--porcelain', '--untracked-files=no'], {
    encoding: 'utf8',
  }).trim(),
  '',
);
const sha = (value) => createHash('sha256').update(value).digest('hex');
function logEvent(eventId, fields) {
  process.stdout.write(
    JSON.stringify({
      module: 'parity',
      resource: 'catalog-native-ui',
      eventId,
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
      ...fields,
    }) + '\n',
  );
}
function trackedInputs() {
  const names = execFileSync('git', ['ls-files', '-z'], {
    cwd: resolve(backend, '..'),
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  return Object.fromEntries(
    names.map((name) => [name, sha(readFileSync(resolve(backend, '..', name)))]),
  );
}
const before = trackedInputs();
const debug = process.argv[3] === '--debug-browser';
assert(!process.argv[3] || debug);
const browserFile = resolve(
  backend,
  '../frontend/tests/catalog-details/native-ui-workflow/browser.mjs',
);
const common = {
  catalog: [
    'id',
    'product',
    'erp_product',
    'price',
    'exclusive_price',
    'prod_type',
    'categories',
    'spl_price',
    'DT_RowId',
    'store_names',
  ],
  matrix: [
    'id',
    'product',
    'erp_product',
    'DT_RowId',
    'ParentProductId',
    'stores',
    'product_store_stock',
    'product_store_stock_is_avail',
    'product_store_stock_is_del',
  ],
};
function project(kind, response) {
  return {
    draw: response.draw,
    recordsTotal: response.recordsTotal,
    recordsFiltered: response.recordsFiltered,
    data: response.data.map((row) =>
      Object.fromEntries(
        common[kind].map((field) => {
          assert(Object.hasOwn(row, field));
          return [field, row[field]];
        }),
      ),
    ),
  };
}
function oracle() {
  const errors = openSync(resolve(dirname(process.argv[2]), 'source.stderr'), 'wx', 0o600);
  const child = spawn(input.python, ['-B', resolve(here, 'source.py')], {
    cwd: backend,
    env: { PATH: process.env.PATH, TZ: 'UTC', PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['pipe', 'pipe', errors],
  });
  closeSync(errors);
  let pending;
  const lines = createInterface({ input: child.stdout });
  const fail = () => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('SOURCE_NATIVE_UI_PROTOCOL_FAILED'));
      pending = undefined;
    }
  };
  lines.on('line', (line) => {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    try {
      assert(Buffer.byteLength(line) <= 2_000_000);
      const response = JSON.parse(line);
      if (response.kind === 'error') throw new Error('SOURCE_NATIVE_UI_' + response.errorKind);
      current.resolve(response);
    } catch {
      current.reject(new Error('SOURCE_NATIVE_UI_PROTOCOL_FAILED'));
    }
  });
  child.once('error', fail);
  child.once('exit', fail);
  return {
    call(value) {
      assert(!pending);
      return new Promise((resolveCall, reject) => {
        pending = {
          resolve: resolveCall,
          reject,
          timer: setTimeout(() => {
            fail();
            child.kill('SIGTERM');
          }, 20000),
        };
        child.stdin.write(JSON.stringify(value) + '\n');
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.end(JSON.stringify({ command: 'close' }) + '\n');
      await new Promise((done) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          done();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
      lines.close();
    },
  };
}
let fixture, web, app, databases, identity, source;
const report = {
  version: 1,
  mode: debug ? 'debug-browser-not-certification' : 'canonical',
  completed: false,
  sourceDeclarations: ['core/urls.py:19', 'core/urls.py:34', 'core/urls.py:35', 'core/urls.py:43'],
  sourceTemplates: [
    'core/templates/products/index.html',
    'core/templates/products/stock/index.html',
  ],
  sourceBoundary:
    'native-row-authentication projection / real source class-model-template dispatch / explicit Redis/layout/URL/plugin transports',
  candidateBoundary:
    'actual built routed App / native signed session / real HTTP / production services / native MySQL',
  sourcePageCases: [],
  apiAuthorityCases: [],
  nativeHttpDiagnostics: [],
  comparisons: [],
  uiGroups: [],
  exclusions: [
    'Whole template stock/visibility/hold/bulk-upload mutation acceptance',
    'Destination detail/audit source-family parity',
    'Original middleware/deployed source HTTP transport',
    'Third-party source DataTables/plugin runtime',
    'Production warehouse/stock-writer/provider activation',
    'Latency/performance claims',
  ],
};
try {
  fixture = await createWorkflowFixture(input.database, 'mixed', input.nonce);
  const physical = verifiedMysqlFixture(fixture.admin);
  await physical.create(['store_counters', 'pos_franchise', 'add_desc']);
  for (const name of [
    'migrations/0001_rewrite_state.sql',
    'src/modules/administration/migration.sql',
  ])
    for (const statement of splitMigration(readFileSync(name, 'utf8')))
      await fixture.admin.query(statement);
  await fixture.admin.query("UPDATE stores SET category='FRANCHISE' WHERE id=2");
  web = await nativeUiServer(resolve(backend, '../frontend/dist'));
  const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'false',
    WEB_ORIGIN: web.origin,
    SESSION_SECRET: randomBytes(48).toString('base64url'),
    MYSQL_WRITER_URL: fixture.adminUrl,
    MYSQL_PRIMARY_READER_URL: fixture.accounts.api_primary.url,
    MYSQL_DATA_READER_URL: fixture.accounts.api_primary.url,
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    MYSQL_POOL_SIZE: '2',
    BUSINESS_TIMEZONE: 'Asia/Kolkata',
  });
  databases = createDatabases(config);
  identity = identityService(config, databases);
  const sessions = mysqlSessions(databases),
    accounts = [];
  for (const role of [1, 2, 3, 4, 5])
    for (const type of [1, 2]) {
      const id = String(900100 + role * 10 + type);
      await physical.insert('pos_user', {
        id,
        username: `native-catalog-${id}`,
        first_name: 'Synthetic',
        last_name: 'Operator',
        role,
        user_type: type,
        is_active: 1,
        is_staff: 1,
      });
      await physical.insert('user_stores', { django_user_id: id, store_id: type === 2 ? 2 : 1 });
      const user = await identity.get(id);
      assert(user && user.role === role && user.userType === type);
      const credential = await sessions.create(id);
      accounts.push({
        user,
        cookie: {
          name: 'pos_session',
          value: seal({ id, ...credential }, config.SESSION_SECRET),
          url: web.origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      });
    }
  const admin = await identity.get('900001');
  assert(admin);
  const credential = await sessions.create(admin.id);
  const administrator = {
    user: admin,
    cookie: {
      name: 'pos_session',
      value: seal({ id: admin.id, ...credential }, config.SESSION_SECRET),
      url: web.origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  };
  source = oracle();
  const initialized = await source.call({
    command: 'initialize',
    database: fixture.accounts.source.url,
    sourceRoot: input.sourceRoot,
  });
  report.sourceHashes = initialized.sourceHashes;
  const contracts = {};
  for (const page of ['catalog', 'matrix']) {
    const response = await source.call({
      command: 'page',
      page,
      method: 'GET',
      actorId: admin.id,
      storeIds: [],
      checkinStoreId: '1',
    });
    assert.equal(response.status, 200);
    assert.equal(response.context.stores.length, 8);
    if (page === 'catalog') assert.deepEqual(response.context.selectedStoreIds, ['1']);
    contracts[page] = sourceUiContract(page, response.html);
  }
  report.sourceUiContracts = contracts;
  if (!debug) {
    for (const actor of [null, ...accounts.map((account) => account.user)])
      for (const page of ['catalog', 'matrix']) {
        const result = await source.call({
          command: 'page',
          page,
          method: 'GET',
          actorId: actor?.id ?? null,
          storeIds: [],
          checkinStoreId: null,
        });
        const denied = !actor || (page === 'matrix' && actor.userType === 2);
        assert.equal(result.status, denied ? 302 : 200);
        if (!denied && page === 'matrix')
          assert.equal(result.context.stores.length, actor.role === 1 ? 8 : 1);
        if (!denied && page === 'catalog')
          assert.equal(
            result.context.stores.length,
            actor.userType === 2 && actor.role !== 1 ? 1 : 8,
          );
        report.sourcePageCases.push({
          page,
          role: actor?.role ?? null,
          userType: actor?.userType ?? null,
          status: result.status,
        });
      }
    const post = await source.call({
      command: 'page',
      page: 'catalog',
      method: 'POST',
      actorId: admin.id,
      storeIds: ['2', '1'],
      checkinStoreId: null,
    });
    assert.equal(post.status, 200);
    assert.deepEqual(post.context.selectedStoreIds, ['2', '1']);
    report.sourcePageCases.push({
      page: 'catalog',
      method: 'POST',
      selectedStoreOrderRetained: true,
    });
  }
  app = await buildApp(config, { logger: false });
  web.attach(await app.listen({ host: '127.0.0.1', port: 0 }));
  const direct = async (path, account, body) => {
    const response = await fetch(web.origin + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: web.origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(account
          ? { Cookie: 'pos_session=' + account.cookie.value, 'X-Operator-ID': account.user.id }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response
      .clone()
      .json()
      .catch(() => null);
    const code = payload?.code ?? payload?.error?.code;
    report.nativeHttpDiagnostics.push({
      path,
      method: body ? 'POST' : 'GET',
      status: response.status,
      code: typeof code === 'string' && /^[A-Z_]{1,100}$/.test(code) ? code : null,
    });
    return response;
  };
  if (!debug) assert.equal((await direct('/api/v1/catalog/stores')).status, 401);
  const base = {
    storeIds: ['1'],
    search: '',
    sort: 'id',
    direction: 'asc',
    start: 0,
    length: 10,
    draw: 0,
  };
  if (!debug) {
    for (const account of accounts) {
      const reply = await direct('/api/v1/catalog/stores', account);
      assert.equal(reply.status, 200);
      const metadata = await reply.json();
      assert.equal(metadata.data.length, account.user.userType === 2 ? 1 : 8);
      const matrix = await direct('/api/v1/catalog/inventory/search', account, base);
      assert.equal(matrix.status, account.user.userType === 2 ? 403 : 200);
      report.apiAuthorityCases.push({
        role: account.user.role,
        userType: account.user.userType,
        metadata: reply.status,
        matrix: matrix.status,
      });
    }
  }
  const franchise = accounts.find(
    (account) => account.user.role === 4 && account.user.userType === 2,
  );
  if (!debug) {
    assert.equal((await direct('/api/v1/catalog/products/search', franchise, base)).status, 403);
    const tampered = {
      ...administrator,
      cookie: { ...administrator.cookie, value: administrator.cookie.value + 'x' },
    };
    assert.equal((await direct('/api/v1/catalog/stores', tampered)).status, 401);
  }
  let activeBrowser;
  const exercise = async () => {
    const loaded = await import(
      pathToFileURL(browserFile).href + (debug ? '?step=' + randomBytes(6).toString('hex') : '')
    );
    report.uiGroups = await loaded.exerciseCatalogUi({
      origin: web.origin,
      calls: web.calls,
      contracts,
      results: report.uiGroups,
      progress: (stage) => {
        report.uiStage = stage;
      },
      onBrowser: (value) => {
        activeBrowser = value;
      },
      diagnostics: (value) => {
        report.domStructure = value;
      },
      accounts: {
        admin: administrator,
        restricted: accounts.find(
          (account) => account.user.role === 4 && account.user.userType === 1,
        ),
        franchise,
      },
      async compare(kind, actualInput, response) {
        const query = { ...base, ...actualInput };
        const expected = await source.call({ command: 'call', kind, input: query });
        assert.deepEqual(project(kind, response), project(kind, expected.response));
        report.comparisons.push({
          kind,
          inputHash: sha(JSON.stringify(query)),
          responseHash: sha(JSON.stringify(project(kind, response))),
          rows: response.data.length,
        });
      },
    });
  };
  if (debug) {
    const commands = createInterface({ input: process.stdin });
    let stopped = false,
      steps = 0;
    const stop = () => {
      stopped = true;
      commands.close();
      void activeBrowser?.close();
    };
    const deadline = setTimeout(stop, 5 * 60 * 1000);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    logEvent('parity.catalog-native-ui.debug.ready', { maxSteps: 3, maxMinutes: 5 });
    report.debugSteps = [];
    try {
      for await (const command of commands) {
        if (command === 'stop' || stopped) break;
        assert.equal(command, 'run');
        report.uiGroups = [];
        report.comparisons = [];
        const step = { browserSha256: sha(readFileSync(browserFile)), passed: false };
        try {
          await exercise();
          step.passed = true;
        } catch (error) {
          step.failureKind = error instanceof Error ? error.name : 'UnknownError';
        }
        Object.assign(step, {
          stage: report.uiStage,
          groups: [...report.uiGroups],
          comparisons: report.comparisons.length,
          domStructure: report.domStructure,
        });
        report.debugSteps.push(step);
        writeFileSync(
          input.output + '.debug-steps.json',
          JSON.stringify(report.debugSteps, null, 2) + '\n',
          { mode: 0o600 },
        );
        logEvent('parity.catalog-native-ui.debug.step', step);
        if (step.passed || ++steps === 3) break;
      }
    } finally {
      clearTimeout(deadline);
      commands.close();
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    }
    report.debugBrowserPassed = report.debugSteps.some((step) => step.passed);
    if (!report.debugBrowserPassed) process.exitCode = 1;
  } else {
    await exercise();
    assert(report.comparisons.length >= 18);
    assert.deepEqual(trackedInputs(), before);
    report.inputHashes = before;
    report.completed = true;
  }
} catch (error) {
  report.failure = {
    code: 'CATALOG_NATIVE_UI_WORKFLOW_FAILED',
    kind: error instanceof Error ? error.name : 'UnknownError',
  };
  process.exitCode = 1;
} finally {
  report.httpCalls =
    web?.calls.map((call) => ({
      method: call.method,
      path: call.path.replace(/\/[0-9]+(?=\/|$)/g, '/:id'),
      status: call.status,
    })) || [];
  await source?.close();
  await app?.close();
  await identity?.close();
  await databases?.close();
  await web?.close();
  await fixture?.close();
  writeFileSync(input.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  logEvent('parity.catalog-native-ui.completed', {
    completed: report.completed,
    sourcePages: report.sourcePageCases.length,
    joinedComparisons: report.comparisons.length,
    uiGroups: report.uiGroups.length,
  });
}
