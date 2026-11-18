#!/bin/sh
# Authoring only until Root releases this native slot.
set -eu
umask 077
test "$#" -eq 1 || { echo 'Supply the absolute pinned POS source checkout.' >&2; exit 2; }
test "${CATALOG_NATIVE_UI_SLOT_RELEASED:-}" = yes || { echo 'Native slot release required.' >&2; exit 1; }
case "$1" in /*) ;; *) exit 2;; esac
case "${CATALOG_NATIVE_UI_OUTPUT:-}" in /*) ;; *) echo 'Supply a new absolute output file.' >&2; exit 2;; esac
test ! -e "$CATALOG_NATIVE_UI_OUTPUT"
ui_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ui_backend=$(CDPATH= cd -- "$ui_here/../../.." && pwd)
ui_root=$(CDPATH= cd -- "$ui_backend/.." && pwd)
ui_mode=${CATALOG_NATIVE_UI_MODE:-canonical}
case "$ui_mode" in canonical|debug) ;; *) exit 2;; esac
ui_work=$(mktemp -d /tmp/pos-catalog-native-ui.XXXXXX)
ui_nonce=$(node --input-type=module -e 'import {randomBytes} from "node:crypto";process.stdout.write(randomBytes(6).toString("hex"))')
ui_container=
cleanup() {
  ui_status=$?
  ui_cleanup_ok=true
  if [ -f "$ui_work/container.cid" ]; then
    ui_container=$(cat "$ui_work/container.cid")
    case "$ui_container" in ''|*[!0-9a-f]*) ui_container=;; esac
    if [ "${#ui_container}" -eq 64 ] && \
      [ "$(docker inspect --format '{{index .Config.Labels "pos-rewrite.catalog-native-ui-nonce"}}' "$ui_container" 2>/dev/null || true)" = "$ui_nonce" ]; then
      docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "$ui_container" > "$ui_work/volumes"
      docker rm -fv "$ui_container" >/dev/null 2>&1 || { ui_status=1; ui_cleanup_ok=false; }
      if docker inspect "$ui_container" >/dev/null 2>&1; then ui_status=1; ui_cleanup_ok=false; fi
      while IFS= read -r ui_volume; do
        test -n "$ui_volume" || continue
        if docker volume inspect "$ui_volume" >/dev/null 2>&1; then ui_status=1; ui_cleanup_ok=false; fi
      done < "$ui_work/volumes"
    else
      ui_status=1
      ui_cleanup_ok=false
    fi
  fi
  # Retain private fixture ownership/cleanup evidence even for a failed target.
  node --input-type=module - "$ui_work/cleanup.json" "$ui_container" "$ui_nonce" "$ui_status" "$ui_cleanup_ok" <<'JS'
import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2],JSON.stringify({container:process.argv[3],nonce:process.argv[4],exitCode:Number(process.argv[5]),cleanupPassed:process.argv[6]==='true'})+'\n',{mode:0o600});
JS
  echo "Private native UI setup/cleanup evidence: $ui_work" >&2
  trap - EXIT
  exit "$ui_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
node --input-type=module -e 'if(process.versions.node!=="24.22.3")process.exit(1)'
node "$ui_backend/tools/dependency-security/verify.mjs"
node "$ui_root/frontend/tools/dependency-security/verify.mjs"
if [ "$ui_mode" = debug ]; then
  ui_python=${CATALOG_NATIVE_UI_DEBUG_PYTHON:?Supply a previous OWN private pinned oracle Python}
  case "$ui_python" in /tmp/pos-catalog-native-ui.*/python/bin/python) ;; *) exit 2;; esac
  test -f "$ui_root/frontend/dist/index.html"
  git -C "$ui_root" diff --quiet e58b207 -- frontend/src frontend/public frontend/package.json frontend/package-lock.json frontend/vite.config.ts
  "$ui_python" -B -c 'import importlib.metadata,platform; assert platform.python_version()=="3.12.15"; assert importlib.metadata.version("Django")=="4.2.5"; assert importlib.metadata.version("PyMySQL")=="1.1.1"'
else
  export UV_CACHE_DIR="$ui_work/uv-cache"
  uv venv --no-python-downloads --python 3.12.15 "$ui_work/python"
  uv pip install --python "$ui_work/python/bin/python" --require-hashes \
    --requirement "$ui_backend/tools/catalog-details/workflow-requirements.txt"
  ui_python="$ui_work/python/bin/python"
  (
    cd "$ui_root/frontend"
    node node_modules/typescript/bin/tsc --noEmit
    node node_modules/vite/bin/vite.js build
  ) >&2
fi
ui_container=$(docker run -d --pull=never --cpus=2 --memory=2g \
  --cidfile "$ui_work/container.cid" \
  --label "pos-rewrite.catalog-native-ui-nonce=$ui_nonce" \
  --tmpfs /var/lib/mysql:rw,size=1g -p 127.0.0.1::3306 \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% \
  mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97)
ui_attempt=0
until docker exec "$ui_container" mysql --protocol=TCP -h127.0.0.1 -uroot -e 'SELECT 1' >/dev/null 2>&1; do
  ui_attempt=$((ui_attempt+1)); test "$ui_attempt" -lt 60 || exit 1; sleep 1
done
ui_port=$(docker port "$ui_container" 3306/tcp | cut -d: -f2)
case "$ui_port" in ''|*[!0-9]*) exit 1;; esac
test "$ui_port" != 54777
node --input-type=module - "$ui_work/config.json" "$ui_port" "$ui_container" "$ui_nonce" "$ui_python" "$1" "$CATALOG_NATIVE_UI_OUTPUT" <<'JS'
import {writeFileSync} from 'node:fs';
const [path,port,container,nonce,python,sourceRoot,output]=process.argv.slice(2);
writeFileSync(path,JSON.stringify({database:`mysql://root@127.0.0.1:${port}/pos_rewrite_catalog_workflow_test`,container,nonce,python,sourceRoot,output}),{mode:0o600});
JS
cd "$ui_backend"
if [ "$ui_mode" = debug ]; then
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
    node --import ./node_modules/tsx/dist/loader.mjs "$ui_here/run.mjs" "$ui_work/config.json" --debug-browser
else
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
    node --import ./node_modules/tsx/dist/loader.mjs "$ui_here/run.mjs" "$ui_work/config.json"
fi
