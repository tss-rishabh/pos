#!/bin/sh
set -eu
coupon_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
coupon_backend=$(CDPATH= cd -- "$coupon_root/../../.." && pwd)
"$coupon_root/../offline-cash-pricing/.venv/bin/python" -B "$coupon_root/prepare.py"
coupon_work=$(mktemp -d /tmp/pos-import-coupon.XXXXXX)
coupon_name="pos-import-coupon-$$"
cleanup(){ docker rm -f "$coupon_name" >/dev/null 2>&1 || true;rm -rf "$coupon_work"; }
trap cleanup EXIT HUP INT TERM
coupon_mysql='mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902'
docker image inspect "$coupon_mysql" >/dev/null 2>&1
docker run --pull=never -d --name "$coupon_name" -p 127.0.0.1::3306 \
 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_rewrite_checkout_test \
 "$coupon_mysql" >/dev/null
cp -R "$coupon_root/../go/." "$coupon_work/"
git -C "$coupon_work" apply "$coupon_root/payments-import-overlay.patch"
cp "$coupon_root/coupon_bridge_test.go" "$coupon_work/internal/poscheckout/sourcefixture/"
cp "$coupon_root/coupon_codec_test.go" "$coupon_work/internal/poscheckout/"
case $(uname -s) in Darwin)coupon_os=darwin;;Linux)coupon_os=linux;;*)exit 1;;esac
case $(uname -m) in arm64|aarch64)coupon_arch=arm64;;x86_64|amd64)coupon_arch=amd64;;*)exit 1;;esac
docker run --rm --network none -v "$coupon_work:/work" \
 -v pos-rewrite-membership-go-modules:/go/pkg/mod -v pos-rewrite-membership-go-build:/root/.cache/go-build \
 -w /work -e GOPROXY=off -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
 -e "GOOS=$coupon_os" -e "GOARCH=$coupon_arch" \
 golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d \
 go test -mod=readonly -c -o /work/coupon.test ./internal/poscheckout/sourcefixture
coupon_attempt=0
while true;do
 coupon_ready=$(docker exec "$coupon_name" mysql --protocol=TCP -h127.0.0.1 -uroot -N -e "SELECT CONVERT_TZ('2026-06-15 06:30:00','UTC','Asia/Kolkata')" 2>/dev/null || true)
 if [ "$coupon_ready" = '2026-06-15 12:00:00' ];then break;fi
 coupon_attempt=$((coupon_attempt+1));if [ "$coupon_attempt" -ge 40 ];then exit 1;fi;sleep 1
done
coupon_port=$(docker port "$coupon_name" 3306/tcp | cut -d: -f2)
export CHECKOUT_MYSQL_TEST_URL="mysql://root@127.0.0.1:$coupon_port/pos_rewrite_checkout_test"
cd "$coupon_backend"
POS_IMPORT_COUPON_GO_BINARY="$coupon_work/coupon.test" npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run tests/legacy-import-coupon-go --maxWorkers=1 "$@"
