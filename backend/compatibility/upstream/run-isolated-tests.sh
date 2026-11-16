#!/bin/sh
set -eu
contract_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
contract_name="pos-exchange-contract-$$"
cleanup() {
  docker rm -f "$contract_name" >/dev/null 2>&1 || true
  docker network rm "$contract_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
docker network create "$contract_name" >/dev/null
docker run -d --name "$contract_name" --network "$contract_name" --network-alias mysql \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_exchange_contract_test \
  mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 >/dev/null
contract_attempt=0
until docker exec "$contract_name" mysqladmin ping -u root --silent >/dev/null 2>&1; do
  contract_attempt=$((contract_attempt+1))
  if [ "$contract_attempt" -ge 60 ]; then printf '%s\n' 'Isolated MySQL did not become ready.' >&2; exit 1; fi
  sleep 1
done
docker run --rm --network "$contract_name" -v "$contract_root/go:/work" -w /work \
  -e 'POS_STOCK_MYSQL_DSN=root@tcp(mysql:3306)/pos_exchange_contract_test' \
  golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d \
  go test -mod=mod -race -count=1 -v ./internal/posstock
