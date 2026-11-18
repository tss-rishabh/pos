#!/bin/sh
set -eu
ordinary_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ordinary_name="pos-checkout-contract-$$"
ordinary_work=$(mktemp -d /tmp/pos-checkout-go.XXXXXX)
cp -R "$ordinary_root/go/." "$ordinary_work/"
cleanup(){ docker rm -f "$ordinary_name" >/dev/null 2>&1 || true; docker network rm "$ordinary_name" >/dev/null 2>&1 || true; rm -rf "$ordinary_work"; }
trap cleanup EXIT HUP INT TERM
docker network create "$ordinary_name" >/dev/null
docker run -d --name "$ordinary_name" --network "$ordinary_name" --network-alias mysql -p 127.0.0.1::3306 \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_checkout_contract_test \
  mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 >/dev/null
ordinary_attempt=0
until docker exec "$ordinary_name" mysql --protocol=TCP -h 127.0.0.1 -u root -D pos_checkout_contract_test -e 'SELECT 1' >/dev/null 2>&1; do
  ordinary_attempt=$((ordinary_attempt+1))
  if [ "$ordinary_attempt" -ge 60 ];then exit 1;fi
  sleep 1
done
ordinary_port=$(docker port "$ordinary_name" 3306/tcp | sed 's/.*://')
cd "$ordinary_root/../.."
node --import tsx "$ordinary_root/legacy-order-imports/run-go-native-fixture.mjs" "$ordinary_work" "$ordinary_name" "$ordinary_port" '^Test' ordinary
