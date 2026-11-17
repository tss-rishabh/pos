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
cp "$import_root/import_native_test.go" "$import_work/internal/poscheckout/sourcefixture/import_receiver_test.go"
cp "$import_root/import_codec_test.go" "$import_work/internal/poscheckout/import_codec_test.go"
cp "$import_root/screening_native_test.go" "$import_work/internal/poscheckout/sourcefixture/screening_native_test.go"
docker network create "$import_name" >/dev/null
docker run -d --name "$import_name" --network "$import_name" --network-alias mysql \
 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_checkout_contract_test \
 mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 >/dev/null
import_attempt=0
until docker exec "$import_name" mysql --protocol=TCP -h 127.0.0.1 -u root -D pos_checkout_contract_test -e 'SELECT 1' >/dev/null 2>&1; do
 import_attempt=$((import_attempt+1));if [ "$import_attempt" -ge 60 ];then exit 1;fi;sleep 1
done
docker run --rm --network "$import_name" -v "$import_work:/work" -v pos-rewrite-membership-go-modules:/go/pkg/mod \
 -v pos-rewrite-membership-go-build:/root/.cache/go-build -w /work -e GOPROXY=off \
 -e 'POS_CHECKOUT_MYSQL_DSN=root@tcp(mysql:3306)/pos_checkout_contract_test?parseTime=true' \
 golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d \
 go test -mod=readonly -race -count=1 -run "$import_pattern" -v ./internal/poscheckout ./internal/poscheckout/sourcefixture
