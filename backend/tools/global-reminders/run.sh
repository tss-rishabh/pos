#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  echo 'Usage: run.sh /absolute/pinned/backend-pos-web' >&2
  exit 2
fi
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
task_temporary=$(mktemp -d "${TMPDIR:-/tmp}/pos-global-reminders.XXXXXX")
. "$task_root/backend/tools/workflow-fixtures/mysql.sh"
cleanup(){ workflow_mysql_cleanup; rm -rf "$task_temporary"; }
trap cleanup EXIT HUP INT TERM
cd "$task_root"
node -e 'if (process.versions.node.split(".")[0] !== "24") throw new Error("Node24 required")'
node backend/tools/dependency-security/verify.mjs
node frontend/tools/dependency-security/verify.mjs
if [ -z "${GLOBAL_REMINDERS_MYSQL_URL:-}" ]; then
  workflow_mysql_start pos_rewrite_global_reminders
  GLOBAL_REMINDERS_MYSQL_URL=$workflow_mysql_url
fi
UV_CACHE_DIR="$task_temporary/uv-cache" uv venv --no-python-downloads \
  --python "${GLOBAL_REMINDERS_PYTHON_VERSION:-3.12}" "$task_temporary/oracle-venv" >&2
UV_CACHE_DIR="$task_temporary/uv-cache" uv pip install --python "$task_temporary/oracle-venv/bin/python" \
  django==4.2.5 asgiref==3.7.2 sqlparse==0.4.4 pymysql==1.1.1 >&2
node frontend/node_modules/typescript/bin/tsc -p frontend/tests/global-reminders/tsconfig.native.json
npm --prefix frontend run build >&2
cd "$task_root/backend"
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
  HL_EXPIRY_POLL_INTERVAL_MS=5000 GLOBAL_REMINDERS_MYSQL_URL="$GLOBAL_REMINDERS_MYSQL_URL" \
  GLOBAL_REMINDERS_ORACLE_PYTHON="$task_temporary/oracle-venv/bin/python" \
  node --import ./node_modules/tsx/dist/loader.mjs ../frontend/tests/global-reminders/native-app.ts "$1"
