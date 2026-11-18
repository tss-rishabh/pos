#!/bin/sh
set -eu
if [ "${1:-}" != --steps ]; then
membership_backend=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
membership_root="$membership_backend/compatibility/upstream"
membership_name="pos-membership-native-$$"
membership_temp=$(mktemp -d /tmp/pos-membership-native.XXXXXX)
cleanup(){ docker rm -f "$membership_name" >/dev/null 2>&1 || true; docker network rm "$membership_name" >/dev/null 2>&1 || true; rm -rf "$membership_temp"; }
trap cleanup EXIT HUP INT TERM
docker network create "$membership_name" >/dev/null
docker run -d --pull=never --name "$membership_name" --network "$membership_name" --network-alias mysql -p 127.0.0.1::3306 \
 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_checkout_contract_test \
 mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 >/dev/null
membership_attempt=0
until docker exec "$membership_name" mysql --protocol=TCP -h 127.0.0.1 -u root -D pos_checkout_contract_test -e 'SELECT 1' >/dev/null 2>&1; do
 membership_attempt=$((membership_attempt+1));if [ "$membership_attempt" -ge 60 ];then exit 1;fi;sleep 1
done
membership_port=$(docker port "$membership_name" 3306/tcp | cut -d: -f2)
export MEMBERSHIP_NATIVE_URL="mysql+pymysql://root@127.0.0.1:$membership_port/pos_checkout_contract_test"
export MEMBERSHIP_NATIVE_NODE_URL="mysql://root@127.0.0.1:$membership_port/pos_checkout_contract_test"
export POS_MEMBERSHIP_PROOF_KEY=fixture-independent-membership-key-0123456789
export POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT=pos-membership-native-revision-v1
export POS_MEMBERSHIP_PRODUCT_IDS='["10"]'
export membership_backend membership_root membership_name membership_temp membership_port
export POS_IMPORT_NATIVE_ACCOUNT_FILE="$membership_temp/fixture-bridge/account.json"
cd "$membership_backend"
node --import tsx "$membership_root/legacy-order-imports/run-go-native-fixture.mjs" "$membership_temp" "$membership_name" "$membership_port" unused ordinary-membership
exit
fi
membership_image=golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d
docker run --rm --pull=never --network none -e GOPROXY=off -e GOTOOLCHAIN=local -v "$membership_root/go:/work:ro" -v "$membership_temp:/output" -v pos-rewrite-membership-go-modules:/go/pkg/mod -v pos-rewrite-membership-go-build:/root/.cache/go-build -w /work "$membership_image" \
 go test -mod=readonly -c -o /output/membership.test ./internal/poscheckout/sourcefixture
bridge(){
 docker run --rm --pull=never --network "$membership_name" -v "$membership_temp:/output" \
  -e POS_BASE_MEMBERSHIP_HEAD_FIXTURE=1 -e POS_IMPORT_NATIVE_FIXTURE_BRIDGE=/output/fixture-bridge \
  -e POS_MEMBERSHIP_BRIDGE=1 -e "POS_MEMBERSHIP_BRIDGE_KIND=$POS_MEMBERSHIP_BRIDGE_KIND" \
  -e POS_MEMBERSHIP_PROOF_KEY -e POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT -e POS_MEMBERSHIP_PRODUCT_IDS \
  -e "EXCLUSIVE_PRODUCT_ID=$membership_new_id" -e "EXCLUSIVE_UPGRADE_IDS=$membership_upgrade_id" -e "EXCLUSIVE_UPGRADE_365=$membership_upgrade_id" \
  -e 'POS_CHECKOUT_MYSQL_DSN=root@tcp(mysql:3306)/pos_checkout_contract_test?parseTime=true' \
  "$membership_image" /output/membership.test -test.v -test.run "^TestMembershipBridge$1$"
}
cd "$membership_backend"
for POS_MEMBERSHIP_BRIDGE_KIND in new upgrade;do
 export POS_MEMBERSHIP_BRIDGE_KIND
 membership_new_id=;membership_upgrade_id=
 if [ "$POS_MEMBERSHIP_BRIDGE_KIND" = new ];then membership_new_id=10;else membership_upgrade_id=10;fi
 bridge Initialize
 "$membership_root/offline-cash-pricing/.venv/bin/python" -B "$membership_root/pending-cancellation/native_membership_driver.py" stage
 node node_modules/tsx/dist/cli.mjs tools/checkout/membership-native-bridge.ts check-staged
 bridge ActivationRollback
 bridge Activate
 node node_modules/tsx/dist/cli.mjs tools/checkout/membership-native-bridge.ts restore
 bridge ImmutableReplay
 bridge Initialize
 "$membership_root/offline-cash-pricing/.venv/bin/python" -B "$membership_root/pending-cancellation/native_membership_driver.py" stage
 "$membership_root/offline-cash-pricing/.venv/bin/python" -B "$membership_root/pending-cancellation/native_membership_driver.py" fence
 node node_modules/tsx/dist/cli.mjs tools/checkout/membership-native-bridge.ts reject-stale
 if [ "$POS_MEMBERSHIP_BRIDGE_KIND" = new ];then
  "$membership_root/offline-cash-pricing/.venv/bin/python" -B "$membership_root/pending-cancellation/native_membership_driver.py" writers
 fi
done
