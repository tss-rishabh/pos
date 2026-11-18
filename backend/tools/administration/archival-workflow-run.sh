#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  echo 'Usage: archival-workflow-run.sh /absolute/pinned/backend-pos-web' >&2
  exit 2
fi
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
task_temporary=$(mktemp -d "${TMPDIR:-/tmp}/pos-archival-workflow.XXXXXX")
. "$task_root/backend/tools/workflow-fixtures/mysql.sh"
cleanup(){ workflow_mysql_cleanup; rm -rf "$task_temporary"; }
trap cleanup EXIT HUP INT TERM
cd "$task_root"
node -e 'if (process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 is required")'
node backend/tools/dependency-security/verify.mjs
node frontend/tools/dependency-security/verify.mjs
if [ -z "${ARCHIVAL_WORKFLOW_MYSQL_URL:-}" ]; then
  workflow_mysql_start pos_rewrite_archival_workflow
  ARCHIVAL_WORKFLOW_MYSQL_URL=$workflow_mysql_url
fi
UV_CACHE_DIR="$task_temporary/uv-cache" uv venv --no-python-downloads \
  --python "${ARCHIVAL_WORKFLOW_PYTHON_VERSION:-3.12}" "$task_temporary/oracle-venv" >&2
task_python="$task_temporary/oracle-venv/bin/python"
UV_CACHE_DIR="$task_temporary/uv-cache" uv pip install --python "$task_python" \
  django==4.2.5 asgiref==3.7.2 sqlparse==0.4.4 pymysql==1.1.1 >&2
node frontend/node_modules/typescript/bin/tsc -p frontend/tests/administration/archival-workflow-tsconfig.json
npm --prefix frontend run build >&2
cd "$task_root/backend"
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
  ARCHIVAL_WORKFLOW_MYSQL_URL="$ARCHIVAL_WORKFLOW_MYSQL_URL" \
  ARCHIVAL_WORKFLOW_ORACLE_PYTHON="$task_python" \
  node --import ./node_modules/tsx/dist/loader.mjs \
  ../frontend/tests/administration/archival-workflow.ts "$1"
