#!/bin/sh
# Complete bounded source/API/UI proof; all databases and Python caches are owned.
set -eu
lookup_backend=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
lookup_repository=$(CDPATH= cd -- "$lookup_backend/.." && pwd)
lookup_source=${LOOKUP_WORKFLOW_SOURCE_ROOT:-"$lookup_repository/../backend-pos-web"}
test -f "$lookup_source/core/views.py" || { echo 'Pinned Django source checkout is required.' >&2; exit 1; }
node --input-type=module -e 'if(process.versions.node.split(".")[0]!=="24")process.exit(1)'
node "$lookup_backend/tools/dependency-security/verify.mjs"
node "$lookup_repository/frontend/tools/dependency-security/verify.mjs"
lookup_work=$(mktemp -d /tmp/pos-lookup-workflow.XXXXXX)
chmod 700 "$lookup_work"
lookup_container=
cleanup() {
  if [ -n "$lookup_container" ]; then docker rm -f "$lookup_container" >/dev/null 2>&1 || true; fi
  rm -rf "$lookup_work"
}
trap cleanup EXIT HUP INT TERM
export UV_CACHE_DIR="$lookup_work/uv-cache"
export UV_PYTHON_INSTALL_DIR="$lookup_work/python-toolchain"
uv venv --python 3.12.15 "$lookup_work/python"
uv pip install --python "$lookup_work/python/bin/python" --requirement "$lookup_backend/tools/lookup-workflow/requirements.txt"
lookup_container=$(docker run -d --pull=never -p 127.0.0.1::3306 \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% \
  mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97)
lookup_attempt=0
until docker exec "$lookup_container" mysql --protocol=TCP -h 127.0.0.1 -u root -e 'SELECT 1' >/dev/null 2>&1; do
  lookup_attempt=$((lookup_attempt+1))
  test "$lookup_attempt" -lt 60 || exit 1
  sleep 1
done
lookup_port=$(docker port "$lookup_container" 3306/tcp | cut -d: -f2)
export LOOKUP_WORKFLOW_BROWSER_TESTS=true
export LOOKUP_WORKFLOW_MYSQL_URL="mysql://root@127.0.0.1:$lookup_port/pos_rewrite_lookup_workflow_test"
export LOOKUP_WORKFLOW_SOURCE_ROOT="$lookup_source"
export LOOKUP_WORKFLOW_PYTHON="$lookup_work/python/bin/python"
export LOOKUP_WORKFLOW_EVIDENCE="$lookup_work/observations.json"
cd "$lookup_repository/frontend"
node node_modules/vitest/vitest.mjs run tests/lookup-workflow/workflow.test.ts \
  --reporter=json --outputFile="$lookup_work/vitest.json"
node --input-type=module - "$lookup_work" <<'JS'
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const directory = process.argv[2];
const repository = resolve('..');
const result = JSON.parse(readFileSync(join(directory, 'vitest.json'), 'utf8'));
const observed = JSON.parse(readFileSync(join(directory, 'observations.json'), 'utf8'));
if (!result.success || result.numPassedTests !== 4 || result.numFailedTests !== 0 ||
    !observed.observations.lookupRowsUnchanged)
  throw new Error('Complete lookup workflow evidence did not qualify.');
const inputs = new Set([
  'backend/package-lock.json', 'frontend/package-lock.json', 'backend/parity/legacy-inventory.json',
  'backend/parity/lookup-workflows.md',
  'backend/tools/administration/barcodes/fixture.ts', 'backend/tools/operational-reports/verified-mysql-fixture.ts',
  'backend/evidence/mysql-schema.json', 'backend/evidence/mysql-extra-schema.json',
  'backend/evidence/mysql-inventory-workbooks-schema.json',
  'backend/migrations/0002_auth_sessions.sql', 'backend/migrations/0006_operator_auth_epochs.sql',
]);
function tree(path) {
  for (const entry of readdirSync(join(repository, path), { withFileTypes: true })) {
    const name = path + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Lookup proof inputs must be regular files.');
    if (entry.isDirectory()) {
      if (!['.venv', '__pycache__'].includes(entry.name)) tree(name);
    } else if (entry.isFile() && !name.endsWith('.pyc')) inputs.add(name);
  }
}
for (const path of ['backend/src', 'frontend/src', 'backend/tools/lookup-workflow', 'frontend/tests/lookup-workflow']) tree(path);
const checksums = Object.fromEntries([...inputs].sort().map((name) => [name,
  createHash('sha256').update(readFileSync(join(repository, name))).digest('hex')]));
const evidence = { version: 1, ...observed, exitCode: 0,
  rewriteBaseCommit: execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tests: { passed: result.numPassedTests, failed: result.numFailedTests }, checksums,
  module: 'parity', resource: 'lookup-workflows', eventId: 'parity.lookup-workflows.completed',
  eventInstanceId: randomUUID(), requestId: null, userId: null,
  recordedAt: new Date().toISOString(), releaseLedgerPromoted: false };
if (process.env.LOOKUP_WORKFLOW_RECEIPT)
  writeFileSync(process.env.LOOKUP_WORKFLOW_RECEIPT, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
process.stdout.write(JSON.stringify(evidence) + '\n');
JS
