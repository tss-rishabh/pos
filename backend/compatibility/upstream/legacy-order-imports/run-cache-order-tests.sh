#!/bin/sh
set -eu
if [ "${1:-}" != "--steps" ]; then
cache_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cache_backend=$(CDPATH= cd -- "$cache_root/../../.." && pwd)
cache_work=$(mktemp -d /tmp/pos-csv-cache.XXXXXX)
cache_name="pos-csv-cache-$$"
cache_pid=
cleanup(){ if [ -n "$cache_pid" ]; then kill "$cache_pid" >/dev/null 2>&1 || true; fi; docker rm -f "$cache_name-go" "$cache_name" >/dev/null 2>&1 || true; docker network rm "$cache_name" >/dev/null 2>&1 || true; rm -rf "$cache_work"; }
trap cleanup EXIT HUP INT TERM
cp -R "$cache_root/../go/." "$cache_work/"
git -C "$cache_work" apply "$cache_root/payments-import-overlay.patch"
cp "$cache_root/import_head_fixture_test.go" "$cache_work/internal/poscheckout/sourcefixture/import_head_fixture_test.go"
cp "$cache_root/../../../src/modules/legacy-order-imports/authority-succession/migration.sql" "$cache_work/internal/poscheckout/sourcefixture/import_authority_migration.sql"
cp "$cache_root/import_native_test.go" "$cache_work/internal/poscheckout/sourcefixture/import_receiver_test.go"
cp "$cache_root/import_membership_test.go" "$cache_work/internal/poscheckout/sourcefixture/import_membership_test.go"
cp "$cache_root/import_cache_test.go" "$cache_work/internal/poscheckout/sourcefixture/import_cache_test.go"
docker network create "$cache_name" >/dev/null
docker run -d --name "$cache_name" --network "$cache_name" --network-alias mysql -p 127.0.0.1::3306 \
 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_checkout_contract_test \
 mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 >/dev/null
cache_attempt=0
until docker exec "$cache_name" mysql --protocol=TCP -h127.0.0.1 -uroot -Dpos_checkout_contract_test -e 'SELECT 1' >/dev/null 2>&1;do
 cache_attempt=$((cache_attempt+1));if [ "$cache_attempt" -ge 60 ];then exit 1;fi;sleep 1
done
cache_port=$(docker port "$cache_name" 3306/tcp | cut -d: -f2)
export cache_root cache_backend cache_work cache_name cache_port
export POS_IMPORT_NATIVE_ACCOUNT_FILE="$cache_work/fixture-bridge/account.json"
cd "$cache_backend"
node --import tsx "$cache_root/run-go-native-fixture.mjs" "$cache_work" "$cache_name" "$cache_port" unused cache
exit
fi
export MEMBERSHIP_NATIVE_URL="mysql+pymysql://root@127.0.0.1:$cache_port/pos_checkout_contract_test"
export POS_MEMBERSHIP_PROOF_KEY=fixture-independent-membership-key-0123456789
export POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT=pos-membership-native-revision-v1
export POS_MEMBERSHIP_PRODUCT_IDS='["10"]'
export POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT=pos-legacy-import-membership-v1
export POS_MEMBERSHIP_FRESH_READER_CONTRACT=pos-membership-fresh-reader-v1
export POS_LEGACY_IMPORT_KEY=fixture-independent-private-import-key-0123456789
export POS_LEGACY_IMPORT_PROOF_KEY=fixture-independent-private-import-proof-0123456789
export POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT=pos-legacy-order-import-confirmation-v1
export POS_CSV_MEMBERSHIP_KIND=new
cache_image=golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d
cache_python="${POS_LEGACY_IMPORT_FIXTURE_PYTHON:-$cache_root/../offline-cash-pricing/.venv/bin/python}"
docker run --rm --name "$cache_name-go" -v "$cache_work:/work" -v pos-rewrite-membership-go-modules:/go/pkg/mod:ro -v "${POS_IMPORT_GO_BUILD_CACHE:-$cache_work/build-cache}:/root/.cache/go-build" \
 -w /work -e GOPROXY=off "$cache_image" go test -mod=readonly -race -c -o /work/cache.test ./internal/poscheckout/sourcefixture
bridge(){
 docker run --rm --name "$cache_name-go" --network "$cache_name" -v "$cache_work:/work" \
  -e POS_IMPORT_NATIVE_FIXTURE_BRIDGE=/work/fixture-bridge -e POS_CSV_MEMBERSHIP_BRIDGE=1 -e POS_CSV_MEMBERSHIP_KIND \
  -e POS_MEMBERSHIP_PROOF_KEY -e POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT -e POS_MEMBERSHIP_PRODUCT_IDS \
  -e POS_LEGACY_IMPORT_KEY -e POS_LEGACY_IMPORT_PROOF_KEY -e POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT \
  -e POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT -e POS_MEMBERSHIP_FRESH_READER_CONTRACT \
  -e EXCLUSIVE_PRODUCT_ID=10 -e EXCLUSIVE_QUARTERLY_ID_FREE= -e EXCLUSIVE_UPGRADE_IDS= -e EXCLUSIVE_UPGRADE_365= \
  -e 'POS_CHECKOUT_MYSQL_DSN=root@tcp(mysql:3306)/pos_checkout_contract_test?parseTime=true' \
  "$cache_image" /work/cache.test -test.v -test.run "^$1$"
}
cd "$cache_backend"
bridge TestImportMembershipInitialize
"$cache_python" -B "$cache_root/native_membership_profile.py" stage
bridge TestImportMembershipActivate
"$cache_python" -B "$cache_root/cache_lock_driver.py" race "$cache_work/customer-ready" >"$cache_work/cache.log" 2>&1 &
cache_pid=$!
cache_attempt=0
until [ -f "$cache_work/customer-ready" ]; do
 if ! kill -0 "$cache_pid" 2>/dev/null; then cat "$cache_work/cache.log"; exit 1; fi
 cache_attempt=$((cache_attempt+1));if [ "$cache_attempt" -ge 200 ];then cat "$cache_work/cache.log";exit 1;fi;sleep .05
done
bridge TestImportCacheOriginalConfirmationReplay
wait "$cache_pid";cache_pid=
cat "$cache_work/cache.log"
"$cache_python" -B "$cache_root/cache_lock_driver.py" guards
