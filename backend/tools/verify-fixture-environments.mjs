/** Check local source-oracle prerequisites before expensive verification. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profiles = [
  {
    resource: 'pricing-source-oracle',
    executable: 'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
    python: '3.12.15',
    modules: ['sqlalchemy', 'pymysql'],
    packages: { SQLAlchemy: '2.1.8', PyMySQL: '1.2.4' },
  },
  {
    resource: 'workbook-source-oracle',
    executable: 'tools/inventory-workbooks/.venv/bin/python',
    python: '3.10.22',
    modules: ['openpyxl', 'et_xmlfile'],
    packages: { openpyxl: '3.1.2', 'et-xmlfile': '1.1.0' },
  },
];
const results = profiles.map((profile) => {
  const executable = resolve(backend, profile.executable);
  if (!existsSync(executable))
    return { resource: profile.resource, valid: false, reason: 'MISSING_ORACLE_ENVIRONMENT' };
  const probe = spawnSync(
    executable,
    [
      '-B',
      '-c',
      'import importlib,importlib.metadata,json,platform,sys; ' +
        'p=json.loads(sys.argv[1]); ' +
        '[importlib.import_module(m) for m in p["modules"]]; ' +
        'print(json.dumps({"python":platform.python_version(),"packages":' +
        '{name:importlib.metadata.version(name) for name in p["packages"]}}))',
      JSON.stringify(profile),
    ],
    {
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 16000,
    },
  );
  try {
    assert.equal(probe.status, 0);
    const installed = JSON.parse(probe.stdout);
    assert.equal(installed.python, profile.python);
    assert.deepEqual(installed.packages, profile.packages);
    return { resource: profile.resource, valid: true, ...installed };
  } catch {
    return { resource: profile.resource, valid: false, reason: 'ORACLE_ENVIRONMENT_MISMATCH' };
  }
});
const valid = results.every((result) => result.valid);
process.stdout.write(
  JSON.stringify({
    module: 'verification',
    resource: 'fixture-environments',
    eventId: 'verification.fixture-environments.completed',
    eventInstanceId: randomUUID(),
    requestId: null,
    userId: null,
    valid,
    environments: results,
  }) + '\n',
);
process.exitCode = valid ? 0 : 1;
