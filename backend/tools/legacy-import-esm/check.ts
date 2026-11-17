import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const esmImportEntries = [
  'financial-adapter-crypto.ts',
  'financial-adapter-contracts.ts',
  'benefit-profile/contracts.ts',
  'benefit-profile/crypto.ts',
  'benefit-profile/completion.ts',
  'benefit-profile/history.ts',
  'benefit-profile/history-publication.ts',
  'benefit-profile/history-source.ts',
  'benefit-profile/history-bigquery.ts',
  'benefit-profile/history-warehouse-source.ts',
  'benefit-profile/bridge.ts',
  'membership-profile/domain.ts',
  'membership-profile/completion.ts',
  'membership-profile/history.ts',
  'membership-profile/publication.ts',
  'membership-profile/publication-native.ts',
  'membership-profile/publication-warehouse.ts',
  'membership-profile/bridge.ts',
] as const;
export function isolatedEnvironment(): NodeJS.ProcessEnv {
  // No inherited DB/provider/cloud credentials, NODE_OPTIONS or dotenv input.
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test', TZ: 'UTC', TSX_DISABLE_CACHE: '1' };
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
    if (process.env[name]) environment[name] = process.env[name];
  return environment;
}
export function checkEsmImports() {
  const output = mkdtempSync(join(backend, '.esm-import-check-')),
    base = join(backend, 'src/modules/legacy-order-imports'),
    probe = join(backend, 'tools/legacy-import-esm/probe.mjs'),
    environment = isolatedEnvironment(),
    results: { entry: string; mode: 'tsx' | 'emitted'; passed: boolean }[] = [];
  const run = (entry: string, mode: 'tsx' | 'emitted') => {
    let passed = false;
    try {
      const target =
        mode === 'tsx'
          ? join(base, entry)
          : join(output, 'modules/legacy-order-imports', entry.replace(/\.ts$/, '.js'));
      const response = execFileSync(
        process.execPath,
        [...(mode === 'tsx' ? ['--import', 'tsx'] : []), probe, target],
        {
          cwd: backend,
          env: environment,
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 16000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      passed = response === 'IMPORT_OK\n';
    } catch {
      /* No raw exception, nested cause, child body or stderr is logged. */
    }
    results.push({ entry, mode, passed });
  };
  try {
    for (const entry of esmImportEntries) run(entry, 'tsx');
    const configuration = ts.readConfigFile(join(backend, 'tsconfig.json'), ts.sys.readFile);
    if (configuration.error) throw new Error('ESM_EMIT_CONFIGURATION_FAILED');
    const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, backend);
    const program = ts.createProgram(
      [
        ...esmImportEntries.map((entry) => join(base, entry)),
        join(backend, 'src/fastify-extensions.ts'),
      ],
      {
        ...parsed.options,
        rootDir: join(backend, 'src'),
        outDir: output,
        noEmit: false,
        emitDeclarationOnly: false,
        declaration: false,
        sourceMap: false,
        incremental: false,
        types: ['node', '@fastify/cookie'],
      },
    );
    if (ts.getPreEmitDiagnostics(program).length || program.emit().emitSkipped)
      throw new Error('ESM_EMIT_TYPECHECK_FAILED');
    for (const entry of esmImportEntries) run(entry, 'emitted');
    return { checks: results.length, passed: results.filter((row) => row.passed).length, results };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const requestId = randomUUID();
  try {
    const result = checkEsmImports(),
      passed = result.checks === result.passed;
    process.stdout.write(
      JSON.stringify({
        module: 'legacy-order-imports',
        resource: 'esm-startup',
        eventId: `legacy-order-imports.esm-startup.${passed ? 'verified' : 'failed'}`,
        eventInstanceId: randomUUID(),
        requestId,
        userId: null,
        ...result,
      }) + '\n',
    );
    if (!passed) process.exitCode = 1;
  } catch {
    process.stderr.write(
      JSON.stringify({
        module: 'legacy-order-imports',
        resource: 'esm-startup',
        eventId: 'legacy-order-imports.esm-startup.failed',
        eventInstanceId: randomUUID(),
        requestId,
        userId: null,
        code: 'ESM_ISOLATION_CHECK_FAILED',
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
