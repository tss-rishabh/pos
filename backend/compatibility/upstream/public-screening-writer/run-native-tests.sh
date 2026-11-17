#!/bin/sh
set -eu
if [ -z "${CHECKOUT_MYSQL_TEST_URL:-}" ]; then
  printf '%s\n' 'An explicit guarded localhost checkout fixture URL is required.' >&2
  exit 1
fi
public_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
public_backend=$(CDPATH= cd -- "$public_root/../../.." && pwd)
public_work=$(mktemp -d /tmp/pos-public-screening.XXXXXX)
trap 'rm -rf "$public_work"' EXIT HUP INT TERM
cp -R "$public_root/../go/." "$public_work/"
git -C "$public_work" apply "$public_root/../legacy-order-imports/payments-import-overlay.patch"
cp "$public_root/public_bridge_test.go" "$public_work/internal/poscheckout/sourcefixture/"
case $(uname -s) in Darwin)public_os=darwin;;Linux)public_os=linux;;*)exit 1;;esac
case $(uname -m) in arm64|aarch64)public_arch=arm64;;x86_64|amd64)public_arch=amd64;;*)exit 1;;esac
docker run --rm --network none -v "$public_work:/work" -v pos-rewrite-membership-go-modules:/go/pkg/mod \
 -v pos-rewrite-membership-go-build:/root/.cache/go-build -w /work -e GOPROXY=off -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
 -e "GOOS=$public_os" -e "GOARCH=$public_arch" \
 golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d \
 go test -mod=readonly -c -o /work/public.test ./internal/poscheckout/sourcefixture
cd "$public_backend"
POS_PUBLIC_SCREENING_GO_BINARY="$public_work/public.test" npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run tests/public-screening-writer --maxWorkers=1
