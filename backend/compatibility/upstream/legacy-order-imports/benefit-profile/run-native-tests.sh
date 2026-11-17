#!/bin/sh
set -eu
benefit_profile=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
benefit_backend=$(CDPATH= cd -- "$benefit_profile/../../../.." && pwd)
benefit_name="pos-import-benefits-$$"
benefit_image='mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902'
cleanup() { docker rm -f "$benefit_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
# Existing image only. No dependency install/pull or connection to a real DB.
docker image inspect "$benefit_image" >/dev/null 2>&1
docker run --pull=never -d --name "$benefit_name" -p 127.0.0.1::3306 \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_rewrite_integration \
  "$benefit_image" >/dev/null
benefit_attempt=0
while true; do
  benefit_probe=$(docker exec "$benefit_name" mysql --protocol=TCP -h127.0.0.1 -uroot -N \
    -e "SELECT CONVERT_TZ('2026-06-15 06:30:00','UTC','Asia/Kolkata')" 2>/dev/null || true)
  if [ "$benefit_probe" = '2026-06-15 12:00:00' ]; then break; fi
  benefit_attempt=$((benefit_attempt+1))
  if [ "$benefit_attempt" -ge 40 ]; then
    printf '%s\n' 'The isolated source timezone fixture did not become ready.' >&2
    exit 1
  fi
  sleep 1
done
benefit_port=$(docker port "$benefit_name" 3306/tcp | cut -d: -f2)
export IMPORT_BENEFITS_MYSQL_TEST_URL="mysql://root@127.0.0.1:$benefit_port/pos_rewrite_integration"
cd "$benefit_backend"
npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run tests/legacy-import-benefits --maxWorkers=1
