#!/bin/sh
set -eu
ordinary_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ordinary_name="pos-checkout-contract-$$"
cleanup(){ docker rm -f "$ordinary_name" >/dev/null 2>&1 || true; docker network rm "$ordinary_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker network create "$ordinary_name" >/dev/null
docker run -d --name "$ordinary_name" --network "$ordinary_name" --network-alias mysql \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_checkout_contract_test \
  mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 >/dev/null
ordinary_attempt=0
until docker exec "$ordinary_name" mysql --protocol=TCP -h 127.0.0.1 -u root -D pos_checkout_contract_test -e 'SELECT 1' >/dev/null 2>&1; do
  ordinary_attempt=$((ordinary_attempt+1))
  if [ "$ordinary_attempt" -ge 60 ];then exit 1;fi
  sleep 1
done
docker run --rm --network "$ordinary_name" -v "$ordinary_root/go:/work:ro" -v pos-rewrite-membership-go-modules:/go/pkg/mod -v pos-rewrite-membership-go-build:/root/.cache/go-build -w /work \
  -e 'POS_CHECKOUT_MYSQL_DSN=root@tcp(mysql:3306)/pos_checkout_contract_test?parseTime=true' \
  golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d \
  go test -mod=readonly -race -count=1 -v ./internal/poscheckout/...
