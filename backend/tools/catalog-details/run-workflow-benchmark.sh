#!/bin/sh
# Invoke only after full verification and other local workloads have stopped.
# All setup/install/DDL is outside measured requests and owned by this runner.
set -eu
catalog_backend=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
catalog_repository=$(CDPATH= cd -- "$catalog_backend/.." && pwd)
catalog_source=${CATALOG_WORKFLOW_SOURCE_ROOT:-"$catalog_repository/../backend-pos-web"}
catalog_mode=${CATALOG_WORKFLOW_MODE:-validate}
case "$catalog_mode" in validate|measure) ;; *) echo 'Invalid workflow mode.' >&2; exit 1;; esac
test "${CATALOG_WORKFLOW_QUIESCENT:-}" = yes || {
  echo 'Run only after full verification and other workloads stop; set CATALOG_WORKFLOW_QUIESCENT=yes.' >&2; exit 1;
}
test -n "${CATALOG_WORKFLOW_OUTPUT:-}" || { echo 'Set a fresh absolute CATALOG_WORKFLOW_OUTPUT file.' >&2; exit 1; }
case "$CATALOG_WORKFLOW_OUTPUT" in /*) ;; *) echo 'Output must be absolute.' >&2; exit 1;; esac
test ! -e "$CATALOG_WORKFLOW_OUTPUT" || { echo 'Output must be a new file.' >&2; exit 1; }
test -f "$catalog_source/core/datatables/products_datatable.py" || { echo 'Pinned Django checkout required.' >&2; exit 1; }
node --input-type=module -e 'if(process.versions.node.split(".")[0]!=="24")process.exit(1)'
node "$catalog_backend/tools/dependency-security/verify.mjs"
catalog_work=$(mktemp -d /tmp/pos-catalog-workflow.XXXXXX)
chmod 700 "$catalog_work"
catalog_container=
cleanup() {
  if [ -n "$catalog_container" ]; then docker rm -f "$catalog_container" >/dev/null 2>&1 || true; fi
  rm -rf "$catalog_work"
}
trap cleanup EXIT HUP INT TERM
export UV_CACHE_DIR="$catalog_work/uv-cache"
export UV_PYTHON_INSTALL_DIR="$catalog_work/python-toolchain"
uv venv --python 3.12.15 "$catalog_work/python"
uv pip install --python "$catalog_work/python/bin/python" --requirement "$catalog_backend/tools/lookup-workflow/requirements.txt"
catalog_nonce=$(node --input-type=module -e 'import {randomBytes} from "node:crypto"; process.stdout.write(randomBytes(6).toString("hex"))')
catalog_container=$(docker run -d --pull=never --cpus=2 --memory=2g \
  --label "pos-rewrite.catalog-workflow-nonce=$catalog_nonce" \
  --tmpfs /var/lib/mysql:rw,size=1g \
  -p 127.0.0.1::3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% \
  mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97 \
  --performance-schema=ON --max-connections=32 --innodb-buffer-pool-size=268435456)
catalog_attempt=0
until docker exec "$catalog_container" mysql --protocol=TCP -h 127.0.0.1 -u root -e 'SELECT 1' >/dev/null 2>&1; do
  catalog_attempt=$((catalog_attempt+1))
  test "$catalog_attempt" -lt 60 || { echo 'Disposable MySQL startup failed.' >&2; exit 1; }
  sleep 1
done
catalog_port=$(docker port "$catalog_container" 3306/tcp | cut -d: -f2)
node --input-type=module - "$catalog_work/config.json" "$catalog_port" "$catalog_container" \
  "$catalog_nonce" "$catalog_work/python/bin/python" "$catalog_source" "$CATALOG_WORKFLOW_OUTPUT" "$catalog_mode" <<'JS'
import {writeFileSync} from 'node:fs';
const [path, port, containerId, nonce, python, sourceRoot, output, mode] = process.argv.slice(2);
if (!/^\d+$/.test(port)) throw new Error('Invalid disposable port.');
writeFileSync(path, JSON.stringify({database: `mysql://root@127.0.0.1:${port}/pos_rewrite_catalog_workflow_test`,
  containerId, nonce, python, sourceRoot, output, mode, quiescentConfirmed: true,
  samples: 216, warmups: 12}), {mode: 0o600, flag: 'wx'});
JS
cd "$catalog_backend"
CI=true NODE_ENV=test TZ=UTC node --import tsx tools/catalog-details/workflow-benchmark.mjs "$catalog_work/config.json"
