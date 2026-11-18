// Full source-handler, serialized-service and authenticated-HTTP observations.
// The three boundaries stay separate: no unmatched-boundary/global speedup claim.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, fork, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism, cpus, loadavg, totalmem } from 'node:os';
import { z } from 'zod';
import { readConfig } from '../../src/config.ts';
import { createDatabases } from '../../src/db/pools.ts';
import { identityService } from '../../src/auth/identity.ts';
import { mysqlSessions } from '../../src/auth/sessions.ts';
import { seal } from '../../src/auth/crypto.ts';
import { catalogDetailsService } from '../../src/modules/catalog-details/service.ts';
import { inventoryMatrixService } from '../../src/modules/catalog-details/matrix.ts';
import { productSearchInput } from '../../src/modules/catalog-details/contracts.ts';
import { inventoryMatrixInput } from '../../src/modules/catalog-details/matrix.ts';
import { createWorkflowFixture, mysqlImage } from './workflow-fixture.mjs';
import { workflowCounters } from './workflow-counters.mjs';

const sourcePin = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a';
const here = dirname(fileURLToPath(import.meta.url)),
  backend = resolve(here, '../..'),
  repository = resolve(backend, '..');
const configSchema = z
  .object({
    database: z.url(),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().regex(/^[a-f0-9]{12}$/),
    python: z.string().min(1),
    sourceRoot: z.string().min(1),
    output: z.string().min(1),
    mode: z.enum(['validate', 'measure']),
    quiescentConfirmed: z.boolean(),
    samples: z.number().int().min(216).max(648).multipleOf(6).default(216),
    warmups: z.number().int().min(12).max(24).multipleOf(6).default(12),
  })
  .strict();
const responseSchema = z.object({
  draw: z.number().int(),
  recordsTotal: z.number().int().nonnegative(),
  recordsFiltered: z.number().int().nonnegative(),
  data: z.array(z.record(z.string(), z.unknown())),
});
const sourceResultSchema = z.object({
  kind: z.literal('result'),
  handlerSerializedMs: z.number().finite().nonnegative(),
  queriesByAlias: z.record(z.string(), z.number().int().nonnegative()),
  logicalReads: z.number().int().nonnegative(),
  responseBytes: z.number().int().nonnegative(),
  response: responseSchema,
});
const orders = [
  ['source', 'service', 'api'],
  ['source', 'api', 'service'],
  ['service', 'source', 'api'],
  ['service', 'api', 'source'],
  ['api', 'source', 'service'],
  ['api', 'service', 'source'],
];
const webOrigin = 'http://127.0.0.1:1';
const actorId = '900001';
const productFields = [
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
];
const matrixFields = [
  'id',
  'product',
  'erp_product',
  'DT_RowId',
  'ParentProductId',
  'stores',
  'product_store_stock',
  'product_store_stock_is_avail',
  'product_store_stock_is_del',
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable); // Never sort response rows or store arrays.
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, stable(value[name])]),
    );
  return value;
}
function commonResponse(kind, raw) {
  const value = responseSchema.parse(raw),
    fields = kind === 'catalog' ? productFields : matrixFields;
  return {
    draw: value.draw,
    recordsTotal: value.recordsTotal,
    recordsFiltered: value.recordsFiltered,
    data: value.data.map((row) =>
      Object.fromEntries(
        fields.map((name) => {
          if (!Object.hasOwn(row, name)) throw new Error('COMMON_RESPONSE_FIELD_MISSING');
          return [name, row[name]];
        }),
      ),
    ),
  };
}
const responseHash = (kind, value) => digest(JSON.stringify(stable(commonResponse(kind, value))));
function workloads(profile) {
  const base = {
    storeIds: Array.from({ length: 8 }, (_, index) => String(index + 1)),
    search: '',
    sort: 'id',
    direction: 'asc',
    start: 0,
    length: 25,
    draw: 0,
  };
  if (profile === 'dense')
    return [{ name: 'dense-parent-first', kind: 'catalog', minimumRows: 25, input: base }];
  return [
    {
      name: 'parent-one-store',
      kind: 'catalog',
      minimumRows: 25,
      input: { ...base, storeIds: ['1'] },
    },
    {
      name: 'parent-eight-store-deep',
      kind: 'catalog',
      minimumRows: 25,
      input: { ...base, start: 250 },
    },
    {
      name: 'parent-selective-exclusive-price',
      kind: 'catalog',
      minimumRows: 25,
      input: { ...base, search: 'Priced ', sort: 'exclusive_price' },
    },
    {
      name: 'parent-category-aggregate-sort',
      kind: 'catalog',
      minimumRows: 25,
      input: { ...base, search: 'Tagged ', sort: 'categories' },
    },
    { name: 'matrix-first-25', kind: 'matrix', minimumRows: 25, input: base },
    {
      name: 'matrix-own-erp-100',
      kind: 'matrix',
      minimumRows: 100,
      input: { ...base, length: 100, sort: 'erp_product', direction: 'desc' },
    },
    {
      name: 'matrix-literal-wildcard',
      kind: 'matrix',
      minimumRows: 1,
      input: { ...base, search: '%_SKU', sort: 'product' },
    },
  ];
}
function inputChecksums() {
  const files = new Set([
    'backend/package-lock.json',
    'frontend/package-lock.json',
    'backend/parity/legacy-inventory.json',
    'backend/evidence/mysql-schema.json',
    'backend/evidence/mysql-extra-schema.json',
    'backend/tools/operational-reports/verified-mysql-fixture.ts',
    'backend/tools/lookup-workflow/requirements.txt',
    'backend/migrations/0002_auth_sessions.sql',
    'backend/migrations/0006_operator_auth_epochs.sql',
  ]);
  function tree(path) {
    for (const entry of readdirSync(join(repository, path), { withFileTypes: true })) {
      const name = path + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('BENCHMARK_INPUT_SYMLINK');
      if (entry.isDirectory()) {
        if (!['node_modules', '.venv', '__pycache__'].includes(entry.name)) tree(name);
      } else if (entry.isFile() && !name.endsWith('.pyc') && !name.endsWith('.png'))
        files.add(name);
    }
  }
  tree('backend/src');
  for (const file of readdirSync(here))
    if (
      file.startsWith('workflow-') ||
      ['native-workflow-oracle.py', 'run-workflow-benchmark.sh'].includes(file)
    )
      if (lstatSync(join(here, file)).isFile()) files.add('backend/tools/catalog-details/' + file);
  return Object.fromEntries(
    [...files].sort().map((name) => [name, digest(readFileSync(join(repository, name)))]),
  );
}
function verifyContainer(config) {
  const [container] = JSON.parse(
    execFileSync('docker', ['inspect', config.containerId], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  const url = new URL(config.database);
  if (
    url.protocol !== 'mysql:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/pos_rewrite_catalog_workflow_test' ||
    url.search ||
    url.hash ||
    !container?.State?.Running ||
    container.Config?.Image !== mysqlImage ||
    container.Config?.Labels?.['pos-rewrite.catalog-workflow-nonce'] !== config.nonce ||
    !container.NetworkSettings?.Ports?.['3306/tcp']?.some(
      (binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === url.port,
    ) ||
    container.Mounts?.some((mount) => mount.Type === 'bind')
  )
    throw new Error('OWN_DISPOSABLE_WORKFLOW_CONTAINER_REQUIRED');
  return {
    id: container.Id,
    ownedNonce: config.nonce,
    anonymousVolumeNames: (container.Mounts ?? [])
      .filter((mount) => mount.Type === 'volume')
      .map((mount) => mount.Name),
    image: mysqlImage,
    cpuNanoLimit: container.HostConfig.NanoCpus,
    memoryLimit: container.HostConfig.Memory,
    temporaryDataDirectory: container.HostConfig.Tmpfs?.['/var/lib/mysql'] ?? null,
  };
}
function sourceProcess(python) {
  const child = spawn(python, ['-B', join(here, 'native-workflow-oracle.py')], {
    cwd: backend,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TZ: 'UTC' },
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  let pending;
  const reject = (code) => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
      pending = undefined;
    }
  };
  lines.on('line', (line) => {
    if (!pending) return;
    if (Buffer.byteLength(line) > 2_000_000) {
      reject('SOURCE_RESPONSE_TOO_LARGE');
      child.kill('SIGTERM');
      return;
    }
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    try {
      const value = JSON.parse(line);
      if (value.kind === 'error') {
        const failure = new Error(
          'SOURCE_WORKFLOW_FAILED_' +
            String(value.driverNumber ?? value.errorKind ?? 'UNKNOWN').toUpperCase(),
        );
        failure.sourceDiagnostic = z
          .object({
            errorKind: z.string().regex(/^[A-Za-z]+$/),
            driverNumber: z.number().int().nullable(),
            locations: z.array(
              z.object({
                file: z.enum(['native-workflow-oracle.py', '<pinned-native-catalog-workflow>']),
                line: z.number().int().positive(),
              }),
            ),
            missingSymbol: z
              .string()
              .regex(/^[A-Za-z_]\w{0,63}$/)
              .optional(),
          })
          .parse(value);
        current.reject(failure);
      } else current.resolve(value);
    } catch {
      current.reject(new Error('INVALID_SOURCE_PROTOCOL_RESPONSE'));
    }
  });
  child.once('error', () => reject('SOURCE_PROCESS_START_FAILED'));
  child.once('exit', () => reject('SOURCE_PROCESS_EXITED'));
  return {
    call(value, timeout = 20000) {
      if (pending) throw new Error('SOURCE_REQUEST_ALREADY_ACTIVE');
      return new Promise((resolve, rejectRequest) => {
        pending = {
          resolve,
          reject: rejectRequest,
          timer: setTimeout(() => {
            reject('SOURCE_REQUEST_DEADLINE');
            child.kill('SIGTERM');
          }, timeout),
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
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
      lines.close();
    },
  };
}
function childReply(child, kind, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('API_PROCESS_DEADLINE'));
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      child.off('message', receive);
      child.off('exit', exit);
    }
    function exit() {
      cleanup();
      reject(new Error('API_PROCESS_EXITED'));
    }
    function receive(value) {
      if (value?.kind === 'error') {
        cleanup();
        reject(new Error('API_PROCESS_INITIALIZATION_FAILED'));
      } else if (value?.kind === kind) {
        cleanup();
        resolve(value);
      }
    }
    child.on('message', receive);
    child.once('exit', exit);
  });
}
async function apiProcess(config) {
  const child = fork(join(here, 'workflow-api.mjs'), [], {
    cwd: backend,
    execPath: process.execPath,
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', TZ: 'UTC' },
  });
  child.stdout.resume();
  child.stderr.resume();
  try {
    await childReply(child, 'awaiting-initialization');
    const ready = childReply(child, 'ready');
    child.send({ command: 'initialize', ...config });
    const value = await ready;
    const origin = z.url().parse(value.origin),
      url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port)
      throw new Error('INVALID_BENCHMARK_API_ORIGIN');
    return {
      origin,
      async close() {
        if (child.connected) {
          const closing = childReply(child, 'closed', 5000);
          child.send({ command: 'close' });
          await closing.catch(() => child.kill('SIGTERM'));
        }
        if (child.exitCode === null) child.kill('SIGTERM');
      },
    };
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}
function databaseConfig(writer, primary, secret) {
  return readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'false',
    SESSION_SECRET: secret,
    WEB_ORIGIN: webOrigin,
    MYSQL_WRITER_URL: writer,
    MYSQL_PRIMARY_READER_URL: primary,
    MYSQL_DATA_READER_URL: primary,
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    MYSQL_POOL_SIZE: '2',
    BUSINESS_TIMEZONE: 'Asia/Kolkata',
  });
}
function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    p50: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
}
function reportProgress(profile, workload, sample) {
  process.stdout.write(
    JSON.stringify({
      module: 'parity',
      resource: 'catalog-workflow',
      eventId: 'parity.catalog-workflow.progress',
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
      profile,
      workload,
      sample,
    }) + '\n',
  );
}

async function runProfile(config, profile, report, budget) {
  report.stage = profile + '.fixture';
  const fixture = await createWorkflowFixture(
    config.database,
    profile,
    randomBytes(6).toString('hex'),
  );
  let source, api, serviceDatabases, administratorDatabases;
  try {
    report.stage = profile + '.identity';
    const secret = randomBytes(40).toString('base64url');
    const serviceConfig = databaseConfig(
      fixture.accounts.service.url,
      fixture.accounts.service.url,
      secret,
    );
    serviceDatabases = createDatabases(serviceConfig);
    const adminConfig = databaseConfig(fixture.adminUrl, fixture.adminUrl, secret);
    administratorDatabases = createDatabases(adminConfig);
    const actor = await identityService(adminConfig, administratorDatabases).get(actorId);
    if (!actor) throw new Error('BENCHMARK_NATIVE_ACTOR_UNAVAILABLE');
    const credential = await mysqlSessions(administratorDatabases).create(actorId);
    const cookie = seal({ id: actorId, ...credential }, secret);
    const catalog = catalogDetailsService(serviceConfig, serviceDatabases),
      matrix = inventoryMatrixService(serviceDatabases);
    report.stage = profile + '.counter-calibration';
    const counters = workflowCounters(fixture.admin),
      calibration = await counters.calibrate(fixture.accounts.calibration);
    source = sourceProcess(config.python);
    report.stage = profile + '.native-source-initialization';
    const sourceReady = await source.call(
      {
        command: 'initialize',
        database: fixture.accounts.source.url,
        sourceRoot: config.sourceRoot,
      },
      30000,
    );
    if (sourceReady.sourcePin !== sourcePin || sourceReady.kind !== 'ready')
      throw new Error('SOURCE_READY_CONTRACT_MISMATCH');
    report.stage = profile + '.authenticated-api-initialization';
    api = await apiProcess({
      primary: fixture.accounts.api_primary.url,
      writer: fixture.accounts.api_auth.url,
      secret,
      webOrigin,
    });
    const [server] = await fixture.admin.query(
      'SELECT VERSION() AS version,@@session.sql_mode AS mode,@@session.group_concat_max_len AS concat_limit',
    );
    const entry = {
      fixture: fixture.facts,
      source: {
        runtime: sourceReady.runtime,
        profiles: sourceReady.profiles,
        sourceHashes: sourceReady.sourceHashes,
        boundary: sourceReady.boundary,
      },
      calibration: calibration.facts,
      server: server[0],
      scenarios: [],
    };
    report.profiles.push(entry);
    for (const workload of workloads(profile)) {
      report.stage = profile + '.' + workload.name;
      budget();
      const input =
        workload.kind === 'catalog'
          ? productSearchInput.parse(workload.input)
          : inventoryMatrixInput.parse(workload.input);
      const requestHash = digest(JSON.stringify(input));
      async function invoke(boundary) {
        budget();
        if (boundary === 'source') {
          const value = sourceResultSchema.parse(
            await source.call({ command: 'call', kind: workload.kind, input }),
          );
          return {
            milliseconds: value.handlerSerializedMs,
            responseBytes: value.responseBytes,
            response: value.response,
            sourceLogicalReads: value.logicalReads,
            queriesByAlias: value.queriesByAlias,
          };
        }
        if (boundary === 'service') {
          const started = performance.now();
          const value =
            workload.kind === 'catalog'
              ? await catalog.search(actor, input)
              : await matrix.search(actor, input);
          const bytes = Buffer.from(JSON.stringify(value));
          const milliseconds = performance.now() - started;
          return {
            milliseconds,
            responseBytes: bytes.length,
            response: JSON.parse(bytes.toString('utf8')),
          };
        }
        const started = performance.now();
        const response = await fetch(
          api.origin +
            (workload.kind === 'catalog'
              ? '/api/v1/catalog/products/search'
              : '/api/v1/catalog/inventory/search'),
          {
            method: 'POST',
            headers: {
              Origin: webOrigin,
              'X-Operator-ID': actorId,
              Cookie: 'pos_session=' + cookie,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(15000),
          },
        );
        const bytes = Buffer.from(await response.arrayBuffer());
        const milliseconds = performance.now() - started;
        if (response.status !== 200 || bytes.length > 2_000_000)
          throw new Error('AUTHENTICATED_API_RESPONSE_FAILED');
        return {
          milliseconds,
          responseBytes: bytes.length,
          response: JSON.parse(bytes.toString('utf8')),
        };
      }
      const names = {
        source: [fixture.accounts.source.name],
        service: [fixture.accounts.service.name],
        api: [fixture.accounts.api_auth.name, fixture.accounts.api_primary.name],
      };
      // Establish lazy connections/prepared forms outside observed intervals.
      for (const boundary of orders[0]) await invoke(boundary);
      const sessionProfiles = {};
      for (const boundary of orders[0])
        sessionProfiles[boundary] = await counters.sessionProfiles(names[boundary]);
      async function observed(boundary) {
        const before = await counters.snapshot(names[boundary]);
        const value = await invoke(boundary);
        const events = counters.delta(before, await counters.snapshot(names[boundary]));
        counters.assertReadOnly(events);
        const logicalReads = calibration.logicalReads(events);
        if (boundary === 'source' && logicalReads !== value.sourceLogicalReads)
          throw new Error('SOURCE_QUERY_COUNT_CALIBRATION_MISMATCH');
        const hash = responseHash(workload.kind, value.response);
        return {
          milliseconds: value.milliseconds,
          responseBytes: value.responseBytes,
          hash,
          logicalReads,
          nativeEvents: events,
          ...(boundary === 'source' ? { queriesByAlias: value.queriesByAlias } : {}),
          rows: value.response.data.length,
        };
      }
      const gated = {};
      for (const boundary of orders[0]) gated[boundary] = await observed(boundary);
      if (
        gated.source.rows < workload.minimumRows ||
        gated.source.hash !== gated.service.hash ||
        gated.source.hash !== gated.api.hash
      )
        throw new Error('UNTIMED_COMPLETE_RESPONSE_EQUIVALENCE_FAILED');
      const scenario = {
        name: workload.name,
        kind: workload.kind,
        requestHash,
        sessionProfiles,
        parity: {
          completeOriginalFieldsEqual: true,
          responseHash: gated.source.hash,
          rows: gated.source.rows,
          queryCounts: Object.fromEntries(
            Object.entries(gated).map(([name, value]) => [name, value.logicalReads]),
          ),
        },
        warmupTriples: config.mode === 'measure' ? config.warmups : 0,
        samples: [],
        statistics: null,
      };
      entry.scenarios.push(scenario);
      if (config.mode !== 'measure') {
        reportProgress(profile, workload.name, 'validated');
        continue;
      }
      for (let index = 0; index < config.warmups + config.samples; index++) {
        const order = orders[index % orders.length],
          trial = {};
        for (const boundary of order) {
          trial[boundary] = await observed(boundary);
          if (trial[boundary].hash !== scenario.parity.responseHash)
            throw new Error('REPEATED_RESPONSE_EQUIVALENCE_CHANGED');
        }
        if (index >= config.warmups)
          scenario.samples.push({ index: index - config.warmups, order, boundaries: trial });
        if (index % 12 === 0)
          reportProgress(profile, workload.name, Math.max(0, index - config.warmups));
      }
      scenario.statistics = Object.fromEntries(
        orders[0].map((boundary) => [
          boundary,
          {
            milliseconds: statistics(
              scenario.samples.map((row) => row.boundaries[boundary].milliseconds),
            ),
            logicalReads: statistics(
              scenario.samples.map((row) => row.boundaries[boundary].logicalReads),
            ),
            responseBytes: statistics(
              scenario.samples.map((row) => row.boundaries[boundary].responseBytes),
            ),
          },
        ]),
      );
    }
  } finally {
    await api?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
    await serviceDatabases?.close().catch(() => undefined);
    await administratorDatabases?.close().catch(() => undefined);
    await fixture.close();
  }
}

async function main() {
  if (process.versions.node.split('.')[0] !== '24' || process.argv.length !== 3)
    throw new Error('NODE_24_AND_EXPLICIT_PRIVATE_CONFIG_REQUIRED');
  const path = resolve(process.argv[2]);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('REGULAR_BENCHMARK_CONFIG_REQUIRED');
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (config.mode === 'measure' && !config.quiescentConfirmed)
    throw new Error('QUIESCENT_VERIFICATION_COMPLETE_ACK_REQUIRED');
  if (existsSync(config.output)) throw new Error('BENCHMARK_OUTPUT_MUST_BE_NEW');
  const container = verifyContainer(config);
  const head = execFileSync('git', ['-C', config.sourceRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync(
    'git',
    ['-C', config.sourceRoot, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf8' },
  ).trim();
  if (head !== sourcePin || dirty) throw new Error('CLEAN_PINNED_SOURCE_CHECKOUT_REQUIRED');
  const output = openSync(config.output, 'wx', 0o600),
    before = inputChecksums();
  const deadline = Date.now() + 30 * 60 * 1000;
  const budget = () => {
    if (Date.now() > deadline) throw new Error('BENCHMARK_WALL_BUDGET_EXCEEDED');
  };
  const report = {
    version: 1,
    sourcePin,
    rewriteCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    mode: config.mode,
    completed: false,
    exitCode: 1,
    performanceMeasured: false,
    productionReady: false,
    productionP95Claimed: false,
    applicationWidePerformanceClaimed: false,
    noMatchedBoundarySpeedupClaim: true,
    boundaries: {
      source:
        'pinned preauthenticated Django view dispatch through serialized HttpResponse.content',
      service:
        'actual pre-resolved-principal service including validation through JSON UTF-8 bytes',
      api: 'actual authenticated HTTP request through complete received bytes, including auth/identity/origin/operator/transport',
    },
    sourceAuthenticationMiddlewareMeasured: false,
    sourceProcessStartupMeasured: false,
    connectionWarmupExcluded: true,
    responseComparisonExcluded: true,
    sourceRequestConstructionExcluded: true,
    httpRequestSerializationIncluded: true,
    concurrency: 1,
    orderPolicy: 'all six permutations balanced in each six-triple block',
    requestedSamplesPerScenario: config.mode === 'measure' ? config.samples : 0,
    percentileMethod:
      'p50 middle pair mean; p95 nearest-rank ceil(0.95*n); no pooled scenario percentile',
    host: {
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      availableParallelism: availableParallelism(),
      totalMemoryBytes: totalmem(),
      cpu: cpus()[0]?.model,
      loadAverageBefore: loadavg(),
    },
    container,
    checksums: before,
    profiles: [],
    changedInputs: [],
  };
  try {
    for (const profile of ['mixed', 'dense']) await runProfile(config, profile, report, budget);
    const after = inputChecksums();
    report.changedInputs = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (name) => before[name] !== after[name],
    );
    if (report.changedInputs.length) throw new Error('BENCHMARK_INPUTS_CHANGED');
    report.completed = true;
    report.exitCode = 0;
    report.performanceMeasured = config.mode === 'measure';
  } catch (error) {
    report.failure =
      error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
        ? error.message
        : 'CATALOG_WORKFLOW_BENCHMARK_FAILED';
    report.errorKind = error instanceof Error ? error.name : 'UnknownError';
    if (error instanceof Error && error.sourceDiagnostic)
      report.sourceDiagnostic = error.sourceDiagnostic;
    if (error instanceof z.ZodError)
      report.validationIssues = error.issues.map(({ path, code }) => ({ path, code }));
    if (error instanceof Error)
      report.failureLocations = (error.stack ?? '')
        .split('\n')
        .slice(1)
        .map((line) => line.match(/(workflow-[a-z-]+\.mjs):(\d+):(\d+)/)?.slice(1))
        .filter(Boolean);
    const code =
      error !== null &&
      typeof error === 'object' &&
      typeof error.code === 'string' &&
      /^[A-Z_0-9]+$/.test(error.code)
        ? error.code
        : null;
    if (code) report.driverCode = code;
    process.exitCode = 1;
  } finally {
    report.recordedAt = new Date().toISOString();
    report.host.loadAverageAfter = loadavg();
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    closeSync(output);
    process.stdout.write(
      JSON.stringify({
        module: 'parity',
        resource: 'catalog-workflow',
        eventId: 'parity.catalog-workflow.completed',
        eventInstanceId: randomUUID(),
        requestId: null,
        userId: null,
        exitCode: report.exitCode,
        mode: report.mode,
        completed: report.completed,
        productionP95Claimed: false,
      }) + '\n',
    );
  }
}
await main().catch(() => {
  process.stderr.write('CATALOG_WORKFLOW_BENCHMARK_INITIALIZATION_FAILED\n');
  process.exitCode = 1;
});
