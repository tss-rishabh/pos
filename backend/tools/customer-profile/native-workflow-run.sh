#!/bin/sh
set -eu
profile_backend=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
profile_repository=$(CDPATH= cd -- "$profile_backend/.." && pwd)
if [ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]; then
  echo 'The native profile workflow requires Node 24.' >&2
  exit 1
fi
node "$profile_backend/tools/dependency-security/verify.mjs"
node "$profile_repository/frontend/tools/dependency-security/verify.mjs"
export CUSTOMER_PROFILE_SOURCE_ROOT="${CUSTOMER_PROFILE_SOURCE_ROOT:-$profile_repository/../backend-pos-web}"
git -C "$CUSTOMER_PROFILE_SOURCE_ROOT" cat-file -e 78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:users/views.py
profile_temporary=$(mktemp -d /tmp/pos-profile-native-workflow.XXXXXX)
profile_container=''
cleanup() {
  if [ -n "$profile_container" ]; then docker rm -f "$profile_container" >/dev/null 2>&1 || true; fi
  rm -rf "$profile_temporary"
}
trap cleanup EXIT HUP INT TERM
if [ -z "${CUSTOMER_PROFILE_SOURCE_PYTHON:-}" ]; then
  export UV_CACHE_DIR="$profile_temporary/uv-cache"
  uv venv --python 3.12 "$profile_temporary/python"
  uv pip install --python "$profile_temporary/python/bin/python" --requirement "$profile_backend/tools/customer-profile/native-workflow-requirements.txt"
  CUSTOMER_PROFILE_SOURCE_PYTHON="$profile_temporary/python/bin/python"
fi
export CUSTOMER_PROFILE_SOURCE_PYTHON
profile_container=$(docker create --pull=never --name "pos-profile-workflow-$$" \
  -p 127.0.0.1::3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes \
  -e MYSQL_DATABASE=pos_rewrite_profile_workflow \
  mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97)
docker start "$profile_container" >/dev/null
profile_attempt=0
until docker exec "$profile_container" mysql --protocol=TCP -h 127.0.0.1 -uroot -D pos_rewrite_profile_workflow -e 'SELECT 1' >/dev/null 2>&1; do
  profile_attempt=$((profile_attempt + 1))
  if [ "$profile_attempt" -ge 60 ]; then
    echo 'The isolated profile database did not become ready.' >&2
    exit 1
  fi
  sleep 1
done
profile_port=$(docker port "$profile_container" 3306/tcp | cut -d: -f2)
export CUSTOMER_PROFILE_WORKFLOW_MYSQL_URL="mysql://root@127.0.0.1:$profile_port/pos_rewrite_profile_workflow"
cd "$profile_backend"
node ../frontend/node_modules/vitest/vitest.mjs run --config ../frontend/tests/customer-profile/native-workflow.config.ts
