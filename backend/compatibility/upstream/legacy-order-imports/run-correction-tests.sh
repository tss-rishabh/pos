#!/bin/sh
set -eu
correction_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
correction_backend=$(CDPATH= cd -- "$correction_root/../../.." && pwd)
"$correction_root/../offline-cash-pricing/.venv/bin/python" -B "$correction_root/prepare.py"
correction_work=$(mktemp -d /tmp/pos-import-correction.XXXXXX)
trap 'rm -rf "$correction_work"' EXIT HUP INT TERM
cp -R "$correction_root/../go/." "$correction_work/"
git -C "$correction_work" apply "$correction_root/payments-import-overlay.patch"
cp "$correction_root/import_correction_test.go" "$correction_work/internal/poscheckout/sourcefixture/"
case $(uname -s) in Darwin)correction_os=darwin;; Linux)correction_os=linux;; *)exit 1;; esac
case $(uname -m) in arm64|aarch64)correction_arch=arm64;; x86_64|amd64)correction_arch=amd64;; *)exit 1;; esac
docker run --rm --network none -v "$correction_work:/work" \
 -v pos-rewrite-membership-go-modules:/go/pkg/mod -v pos-rewrite-membership-go-build:/root/.cache/go-build \
 -w /work -e GOPROXY=off -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
 -e "GOOS=$correction_os" -e "GOARCH=$correction_arch" \
 golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d \
 go test -mod=readonly -c -o /work/correction.test ./internal/poscheckout/sourcefixture
cd "$correction_backend"
POS_IMPORT_CORRECTION_GO_BINARY="$correction_work/correction.test" \
 npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run \
 tests/legacy-import-financial/source.mysql.test.ts -t 'accepted-go' --maxWorkers=1
