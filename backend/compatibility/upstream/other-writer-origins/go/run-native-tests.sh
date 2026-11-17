#!/bin/sh
set -eu
origin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
origin_assembly=${1:?Supply an independently assembled payments tree}
origin_modules=${2:?Supply a task-only pinned Go module cache}
origin_build=${3:?Supply a task-only Go build cache}
origin_work=$(mktemp -d /tmp/pos-origin-native.XXXXXX)
origin_name="pos-origin-native-$$"
cleanup(){ docker rm -f "$origin_name" >/dev/null 2>&1 || true; docker network rm "$origin_name" >/dev/null 2>&1 || true; rm -rf "$origin_work"; }
trap cleanup EXIT HUP INT TERM
cp -R "$origin_assembly/." "$origin_work/"
cp "$origin_root/origin_native_test.go" "$origin_work/internal/poscheckout/origin_native_test.go"
cp "$origin_root/origin_gateway_test.go" "$origin_work/juspay/origin_gateway_test.go"
# Compile and vet the actual composed source before any fixture-only startup shim.
docker run --rm --network none -v "$origin_work:/work:ro" -v "$origin_modules:/go/pkg/mod" -v "$origin_build:/root/.cache/go-build" -w /work -e GOPROXY=off \
 golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d go build -mod=readonly ./internal/poscheckout ./juspay
docker run --rm --network none -v "$origin_work:/work:ro" -v "$origin_modules:/go/pkg/mod" -v "$origin_build:/root/.cache/go-build" -w /work -e GOPROXY=off \
 golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d go vet -mod=readonly ./internal/poscheckout ./juspay
# The original app's package init overwrites DB/provider env and AutoMigrates.
# Only this disposable test copy replaces its ENV loader, accepting precisely
# the internal fixture DSN. All provider/financial/native methods stay intact.
cat > "$origin_work/config/env.go" <<'GO'
package config
import "os"
func InitEnv(){if os.Getenv("ENV")!="POS_ORIGIN_FIXTURE"||os.Getenv("DB")!="root@tcp(mysql:3306)/pos_origin_contract_test?parseTime=true"{panic("refusing non-isolated origin fixture startup")}}
GO
docker network create --internal "$origin_name" >/dev/null
docker run -d --name "$origin_name" --network "$origin_name" --network-alias mysql \
 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_origin_contract_test \
 mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 >/dev/null
origin_attempt=0
until docker exec "$origin_name" mysql --protocol=TCP -h127.0.0.1 -uroot -Dpos_origin_contract_test -e 'SELECT 1' >/dev/null 2>&1; do
 origin_attempt=$((origin_attempt+1));if [ "$origin_attempt" -ge 60 ];then exit 1;fi;sleep 1
done
for origin_package in ./internal/poscheckout ./juspay; do
 docker run --rm --network "$origin_name" -v "$origin_work:/work:ro" -v "$origin_modules:/go/pkg/mod" -v "$origin_build:/root/.cache/go-build" -w /work -e GOPROXY=off \
  -e ENV=POS_ORIGIN_FIXTURE -e 'DB=root@tcp(mysql:3306)/pos_origin_contract_test?parseTime=true' -e 'POS_ORIGIN_MYSQL_DSN=root@tcp(mysql:3306)/pos_origin_contract_test?parseTime=true' \
  golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d \
  go test -mod=readonly -race -count=1 -run '^TestOrigin' -v "$origin_package"
done
