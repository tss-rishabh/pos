#!/bin/sh
set -eu
import_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
import_work=$(mktemp -d /tmp/pos-import-go.XXXXXX)
import_name="pos-import-contract-$$"
import_pattern='^Test(Import|Screening)'
if [ "$#" -gt 0 ]; then import_pattern=$1; fi
cleanup(){ docker rm -f "$import_name" >/dev/null 2>&1 || true; docker network rm "$import_name" >/dev/null 2>&1 || true; rm -rf "$import_work"; }
trap cleanup EXIT HUP INT TERM
cp -R "$import_root/../go/." "$import_work/"
git -C "$import_work" apply "$import_root/payments-import-overlay.patch"
cp "$import_root/import_head_fixture_test.go" "$import_work/internal/poscheckout/sourcefixture/import_head_fixture_test.go"
cp "$import_root/../../../src/modules/legacy-order-imports/authority-succession/migration.sql" "$import_work/internal/poscheckout/sourcefixture/import_authority_migration.sql"
cp "$import_root/import_native_test.go" "$import_work/internal/poscheckout/sourcefixture/import_receiver_test.go"
cp "$import_root/import_codec_test.go" "$import_work/internal/poscheckout/import_codec_test.go"
cp "$import_root/coupon_codec_test.go" "$import_work/internal/poscheckout/coupon_codec_test.go"
cp "$import_root/screening_fixture_writer.go" "$import_work/internal/poscheckout/screening_fixture_writer.go"
cp "$import_root/screening_fixture_writer_test.go" "$import_work/internal/poscheckout/sourcefixture/screening_fixture_writer_test.go"
cp "$import_root/screening_native_test.go" "$import_work/internal/poscheckout/sourcefixture/screening_native_test.go"
docker network create "$import_name" >/dev/null
docker run -d --name "$import_name" --network "$import_name" --network-alias mysql \
 -p 127.0.0.1::3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_checkout_contract_test \
 mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 >/dev/null
import_attempt=0
until docker exec "$import_name" mysql --protocol=TCP -h 127.0.0.1 -u root -D pos_checkout_contract_test -e 'SELECT 1' >/dev/null 2>&1; do
 import_attempt=$((import_attempt+1));if [ "$import_attempt" -ge 60 ];then exit 1;fi;sleep 1
done
import_port=$(docker port "$import_name" 3306/tcp | sed 's/.*://')
cd "$import_root/../../.."
node --import tsx "$import_root/run-go-native-fixture.mjs" "$import_work" "$import_name" "$import_port" "$import_pattern"
