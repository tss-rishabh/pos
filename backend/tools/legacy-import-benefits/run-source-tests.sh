#!/bin/sh
# No pulls, installations, live services or host timezone-table mutations.
set -eu
source_benefits_backend=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$source_benefits_backend"
if [ -z "${POS_LEGACY_IMPORT_SOURCE_ROOT:-}" ] || [ ! -d "$POS_LEGACY_IMPORT_SOURCE_ROOT" ]; then
  printf '%s\n' 'An explicit pinned legacy source fixture is required.' >&2
  exit 1
fi
PYTHONPATH="$source_benefits_backend/compatibility/upstream/legacy-order-imports:$source_benefits_backend/compatibility/upstream/screening-origins${PYTHONPATH:+:$PYTHONPATH}" \
  compatibility/upstream/offline-cash-pricing/.venv/bin/python -B \
  compatibility/upstream/legacy-order-imports/test_order_preparation_metadata.py
source_benefits_container="pos-source-benefits-$$"
source_benefits_cleanup() {
  docker rm -f "$source_benefits_container" >/dev/null 2>&1 || true
}
trap source_benefits_cleanup EXIT
trap 'exit 130' INT TERM
docker run --rm -d --pull=never --name "$source_benefits_container" \
  -p 127.0.0.1::3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% \
  -e MYSQL_DATABASE=pos_rewrite_checkout_test \
  mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 \
  --innodb-buffer-pool-size=134217728 >/dev/null
source_benefits_ready=false
source_benefits_attempt=0
while [ "$source_benefits_attempt" -lt 60 ]; do
  source_benefits_attempt=$((source_benefits_attempt + 1))
  # The initialization-only socket server can already have timezone data but
  # restarts before accepting host connections. Require the final TCP server.
  source_benefits_zone=$(docker exec "$source_benefits_container" mysql --protocol=tcp -h127.0.0.1 -uroot --batch --skip-column-names \
    -e "SELECT CONVERT_TZ('2026-06-15 12:00:00','UTC','Asia/Kolkata')" 2>/dev/null || true)
  if [ "$source_benefits_zone" = '2026-06-15 17:30:00' ]; then
    source_benefits_ready=true
    break
  fi
  sleep 1
done
if [ "$source_benefits_ready" != true ]; then
  printf '%s\n' 'The isolated timezone-aware MySQL fixture did not become ready.' >&2
  exit 1
fi
source_benefits_port=$(docker port "$source_benefits_container" 3306/tcp | sed 's/^127\.0\.0\.1://')
case "$source_benefits_port" in ''|*[!0-9]*) exit 1;; esac
SOURCE_BENEFITS_MYSQL_TEST_URL="mysql://root@127.0.0.1:$source_benefits_port/pos_rewrite_checkout_test" \
  npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run \
    tests/legacy-import-preparation/benefit-source.mysql.test.ts --maxWorkers=1
