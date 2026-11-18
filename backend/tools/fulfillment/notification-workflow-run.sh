#!/bin/sh
set -eu
notification_backend=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
notification_repository=$(CDPATH= cd -- "$notification_backend/.." && pwd)
if [ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]; then
  echo 'The native notification workflow requires Node 24.' >&2
  exit 1
fi
node "$notification_backend/tools/dependency-security/verify.mjs"
node "$notification_repository/frontend/tools/dependency-security/verify.mjs"
export NOTIFICATION_SOURCE_ROOT="${NOTIFICATION_SOURCE_ROOT:-$notification_repository/../backend-pos-web}"
git -C "$NOTIFICATION_SOURCE_ROOT" cat-file -e 78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:notification/consumers.py
notification_temporary=$(mktemp -d /tmp/pos-notification-native-workflow.XXXXXX)
notification_container=''
cleanup() {
  if [ -n "$notification_container" ]; then docker rm -f "$notification_container" >/dev/null 2>&1 || true; fi
  rm -rf "$notification_temporary"
}
trap cleanup EXIT HUP INT TERM
if [ -z "${NOTIFICATION_SOURCE_PYTHON:-}" ]; then
  export UV_CACHE_DIR="$notification_temporary/uv-cache"
  uv venv --python 3.12 "$notification_temporary/python"
  uv pip install --python "$notification_temporary/python/bin/python" --requirement "$notification_backend/tools/fulfillment/notification-workflow-requirements.txt"
  NOTIFICATION_SOURCE_PYTHON="$notification_temporary/python/bin/python"
fi
export NOTIFICATION_SOURCE_PYTHON
notification_container=$(docker create --pull=never --name "pos-notification-workflow-$$" \
  -p 127.0.0.1::3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes \
  -e MYSQL_DATABASE=pos_rewrite_notification_workflow \
  mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97)
docker start "$notification_container" >/dev/null
notification_attempt=0
until docker exec "$notification_container" mysql --protocol=TCP -h 127.0.0.1 -uroot -D pos_rewrite_notification_workflow -e 'SELECT 1' >/dev/null 2>&1; do
  notification_attempt=$((notification_attempt + 1))
  if [ "$notification_attempt" -ge 60 ]; then
    echo 'The isolated notification database did not become ready.' >&2
    exit 1
  fi
  sleep 1
done
notification_port=$(docker port "$notification_container" 3306/tcp | cut -d: -f2)
export NOTIFICATION_WORKFLOW_MYSQL_URL="mysql://root@127.0.0.1:$notification_port/pos_rewrite_notification_workflow"
cd "$notification_backend"
node ../frontend/node_modules/vitest/vitest.mjs run --config ../frontend/tests/fulfillment/notification-workflow.config.ts "$@"
