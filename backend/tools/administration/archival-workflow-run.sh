#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  echo 'Usage: archival-workflow-run.sh /absolute/pinned/backend-pos-web' >&2
  exit 2
fi
: "${ARCHIVAL_WORKFLOW_MYSQL_URL:?An owned localhost MySQL fixture is required}"
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
task_temporary=$(mktemp -d "${TMPDIR:-/tmp}/pos-archival-workflow.XXXXXX")
cleanup(){ rm -rf "$task_temporary"; }
trap cleanup EXIT HUP INT TERM
cd "$task_root"
node -e 'if (process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 is required")'
node backend/tools/dependency-security/verify.mjs
node frontend/tools/dependency-security/verify.mjs
task_python=$(UV_CACHE_DIR="$task_temporary/uv-cache" uv run --no-python-downloads --no-project \
  --python "${ARCHIVAL_WORKFLOW_PYTHON_VERSION:-3.12}" \
  --with django==4.2.5 --with asgiref==3.7.2 --with sqlparse==0.4.4 --with pymysql==1.1.1 \
  python -c 'import sys; print(sys.executable)')
node frontend/node_modules/typescript/bin/tsc -p frontend/tests/administration/archival-workflow-tsconfig.json
npm --prefix frontend run build >&2
cd "$task_root/backend"
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
  ARCHIVAL_WORKFLOW_MYSQL_URL="$ARCHIVAL_WORKFLOW_MYSQL_URL" \
  ARCHIVAL_WORKFLOW_ORACLE_PYTHON="$task_python" \
  node --import ./node_modules/tsx/dist/loader.mjs \
  ../frontend/tests/administration/archival-workflow.ts "$1"
