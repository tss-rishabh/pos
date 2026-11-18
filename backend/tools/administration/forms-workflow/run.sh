#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then echo 'Usage: run.sh /absolute/pinned/backend-pos-web' >&2; exit 2; fi
forms_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
forms_work=$(mktemp -d "${TMPDIR:-/tmp}/pos-forms-workflow.XXXXXX")
forms_nonce=$(basename "$forms_work")
forms_container=''
forms_cleanup_receipt=${FORMS_WORKFLOW_CLEANUP_RECEIPT:-}
mkdir -p "$forms_work/tmp"
if [ -n "${FORMS_WORKFLOW_RECEIPT:-}" ]; then test ! -e "$FORMS_WORKFLOW_RECEIPT"; fi
cleanup() {
  if [ -n "$forms_container" ] && [ "$(docker inspect --format '{{index .Config.Labels "pos.forms-workflow"}}' "$forms_container" 2>/dev/null)" = "$forms_nonce" ]; then
    docker inspect --format '{{json .Mounts}}' "$forms_container" > "$forms_work/mounts.json"
    docker rm -fv "$forms_container" >/dev/null
    forms_remaining=$(docker ps -aq --no-trunc --filter "id=$forms_container")
    test -z "$forms_remaining"
    if [ -n "$forms_cleanup_receipt" ]; then
      node --input-type=module - "$forms_container" "$forms_nonce" "$forms_work/mounts.json" "$forms_cleanup_receipt" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [id, nonce, mountsFile, output] = process.argv.slice(2);
const mounts = JSON.parse(readFileSync(mountsFile, 'utf8'));
if (mounts.some((mount) => mount.Type === 'volume')) throw new Error('Unexpected anonymous volume');
writeFileSync(output, JSON.stringify({ containerId: id, ownershipNonce: nonce,
  containerAbsent: true, anonymousVolumes: 0, removedWithVolumes: true,
  limits: { cpus: 2, memoryBytes: 1073741824, data: 'tmpfs' } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
JS
    fi
  fi
  rm -rf "$forms_work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
cd "$forms_root"
node -e 'if(process.versions.node.split(".")[0]!=="24")throw new Error("Node24 required")'
node backend/tools/dependency-security/verify.mjs
node frontend/tools/dependency-security/verify.mjs
if [ -n "${FORMS_WORKFLOW_PYTHON:-}" ]; then
  forms_python=$FORMS_WORKFLOW_PYTHON
else
  UV_CACHE_DIR="$forms_work/uv-cache" uv venv --no-python-downloads --python 3.12.15 "$forms_work/python" >&2
  forms_python="$forms_work/python/bin/python"
  UV_CACHE_DIR="$forms_work/uv-cache" uv pip install --python "$forms_python" -r backend/tools/administration/forms-workflow/requirements.txt >&2
fi
node backend/node_modules/typescript/bin/tsc -p backend/tools/administration/forms-workflow/tsconfig.json
node frontend/node_modules/typescript/bin/tsc -p frontend/tests/administration/forms-workflow/tsconfig.json
NODE_ENV=production npm --prefix frontend run build >&2
forms_container=$(docker create --pull=never --cpus=2 --memory=1g \
  --tmpfs /var/lib/mysql:rw,size=512m --label "pos.forms-workflow=$forms_nonce" \
  -p 127.0.0.1::3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% \
  mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97 \
  --innodb-buffer-pool-size=134217728)
docker start "$forms_container" >/dev/null
forms_attempt=0
until docker exec "$forms_container" mysql --protocol=TCP -h127.0.0.1 -uroot -e 'SELECT 1' >/dev/null 2>&1; do
  forms_attempt=$((forms_attempt+1)); test "$forms_attempt" -lt 60; sleep 1
done
forms_port=$(docker port "$forms_container" 3306/tcp | cut -d: -f2)
forms_receipt=${FORMS_WORKFLOW_RECEIPT:-"$forms_work/receipt.json"}
cd "$forms_root/backend"
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$forms_work/tmp" NODE_ENV=test CI=true TZ=UTC \
  FORMS_WORKFLOW_MYSQL_URL="mysql://root@127.0.0.1:$forms_port/pos_rewrite_forms_workflow" \
  FORMS_WORKFLOW_PYTHON="$forms_python" FORMS_WORKFLOW_RECEIPT="$forms_receipt" \
  FORMS_WORKFLOW_DIAGNOSTIC_CASE="${FORMS_WORKFLOW_DIAGNOSTIC_CASE:-}" \
  STOREDEFAULTUSER=default-contact@example.test,archived-default@example.test \
  node --import ./node_modules/tsx/dist/loader.mjs ../frontend/tests/administration/forms-workflow/run.ts "$1"
