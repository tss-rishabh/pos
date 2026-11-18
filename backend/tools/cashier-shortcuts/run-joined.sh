#!/bin/sh
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != --native-reference ]; }; then
  echo 'Usage: run-joined.sh /absolute/pinned/backend-pos-web [--native-reference]' >&2
  exit 2
fi
task_native=false
if [ "${2:-}" = --native-reference ]; then
  : "${SHORTCUT_REFERENCE_MYSQL_TEST_URL:?An owned localhost shortcut database is required}"
  task_native=true
fi
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
task_temporary=$(mktemp -d "${TMPDIR:-/tmp}/pos-shortcut-help-proof.XXXXXX")
cleanup(){ rm -rf "$task_temporary"; }
trap cleanup EXIT HUP INT TERM
cd "$task_root"
node -e 'if (process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 is required")'
node backend/tools/dependency-security/verify.mjs
node frontend/tools/dependency-security/verify.mjs
UV_CACHE_DIR="$task_temporary/uv-cache" uv run --no-python-downloads --no-project \
  --python "${SHORTCUT_ORACLE_PYTHON:-3.12}" \
  --with django==4.2.5 --with asgiref==3.7.2 --with sqlparse==0.4.4 --with whitenoise==6.12.0 \
  python -B backend/tools/cashier-shortcuts/source-help.py "$1" > "$task_temporary/source.json"
node frontend/node_modules/typescript/bin/tsc -p frontend/tools/cashier-shortcuts/tsconfig.joined.json
npm --prefix frontend run build >&2
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
  node --import ./backend/node_modules/tsx/dist/loader.mjs \
  frontend/tools/cashier-shortcuts/joined-help.ts "$task_temporary/source.json" > "$task_temporary/workflow.json"
cat "$task_temporary/source.json" "$task_temporary/workflow.json"
if [ "$task_native" = true ]; then
  cd "$task_root/backend"
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
    SHORTCUT_REFERENCE_MYSQL_TEST_URL="$SHORTCUT_REFERENCE_MYSQL_TEST_URL" \
    node --import ./node_modules/tsx/dist/loader.mjs \
    ../frontend/tools/cashier-shortcuts/native-reference.ts "$task_temporary/source.json"
fi
