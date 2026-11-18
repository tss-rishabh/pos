#!/bin/sh
set -eu
feedback_backend=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
feedback_repository=$(CDPATH= cd -- "$feedback_backend/.." && pwd)
feedback_node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$feedback_node_major" != 24 ]; then
  echo 'The native feedback workflow requires Node 24.' >&2
  exit 1
fi
node "$feedback_backend/tools/dependency-security/verify.mjs"
node "$feedback_repository/frontend/tools/dependency-security/verify.mjs"
export PRODUCT_FEEDBACK_SOURCE_ROOT="${PRODUCT_FEEDBACK_SOURCE_ROOT:-$feedback_repository/../backend-pos-web}"
git -C "$PRODUCT_FEEDBACK_SOURCE_ROOT" cat-file -e 78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:order/views.py
feedback_temporary=$(mktemp -d /tmp/pos-feedback-native-workflow.XXXXXX)
feedback_container=''
cleanup() {
  if [ -n "$feedback_container" ]; then docker rm -fv "$feedback_container" >/dev/null 2>&1 || true; fi
  rm -rf "$feedback_temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
if [ -z "${PRODUCT_FEEDBACK_SOURCE_PYTHON:-}" ]; then
  export UV_CACHE_DIR="$feedback_temporary/uv-cache"
  uv venv --python 3.12 "$feedback_temporary/python"
  uv pip install --python "$feedback_temporary/python/bin/python" --requirement "$feedback_backend/tools/product-feedback/native-workflow-requirements.txt"
  PRODUCT_FEEDBACK_SOURCE_PYTHON="$feedback_temporary/python/bin/python"
fi
export PRODUCT_FEEDBACK_SOURCE_PYTHON
feedback_container=$(docker create --pull=never --name "pos-feedback-workflow-$$" \
  -p 127.0.0.1::3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes \
  -e MYSQL_DATABASE=pos_rewrite_feedback_workflow \
  mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97)
docker start "$feedback_container" >/dev/null
feedback_attempt=0
until docker exec "$feedback_container" mysql --protocol=TCP -h 127.0.0.1 -uroot -D pos_rewrite_feedback_workflow -e 'SELECT 1' >/dev/null 2>&1; do
  feedback_attempt=$((feedback_attempt + 1))
  if [ "$feedback_attempt" -ge 60 ]; then
    echo 'The isolated feedback database did not become ready.' >&2
    exit 1
  fi
  sleep 1
done
feedback_port=$(docker port "$feedback_container" 3306/tcp | cut -d: -f2)
export PRODUCT_FEEDBACK_WORKFLOW_MYSQL_URL="mysql://root@127.0.0.1:$feedback_port/pos_rewrite_feedback_workflow"
cd "$feedback_backend"
node ../frontend/node_modules/vitest/vitest.mjs run --config ../frontend/tests/product-feedback/native-workflow.config.ts
