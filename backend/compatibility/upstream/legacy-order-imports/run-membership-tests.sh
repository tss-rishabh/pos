#!/bin/sh
set -eu
member_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
member_backend=$(CDPATH= cd -- "$member_root/../../.." && pwd)
member_work=$(mktemp -d /tmp/pos-csv-member.XXXXXX)
member_name="pos-csv-member-$$"
cleanup(){ docker rm -f "$member_name" >/dev/null 2>&1 || true; docker network rm "$member_name" >/dev/null 2>&1 || true; rm -rf "$member_work"; }
trap cleanup EXIT HUP INT TERM
cp -R "$member_root/../go/." "$member_work/"
git -C "$member_work" apply "$member_root/payments-import-overlay.patch"
cp "$member_root/import_native_test.go" "$member_work/internal/poscheckout/sourcefixture/import_receiver_test.go"
cp "$member_root/import_membership_test.go" "$member_work/internal/poscheckout/sourcefixture/import_membership_test.go"
docker network create "$member_name" >/dev/null
docker run -d --name "$member_name" --network "$member_name" --network-alias mysql -p 127.0.0.1::3306 \
 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_checkout_contract_test \
 mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 >/dev/null
member_attempt=0
until docker exec "$member_name" mysql --protocol=TCP -h127.0.0.1 -uroot -Dpos_checkout_contract_test -e 'SELECT 1' >/dev/null 2>&1;do
 member_attempt=$((member_attempt+1));if [ "$member_attempt" -ge 60 ];then exit 1;fi;sleep 1
done
member_port=$(docker port "$member_name" 3306/tcp | cut -d: -f2)
export MEMBERSHIP_NATIVE_URL="mysql+pymysql://root@127.0.0.1:$member_port/pos_checkout_contract_test"
export MEMBERSHIP_NATIVE_NODE_URL="mysql://root@127.0.0.1:$member_port/pos_checkout_contract_test"
export POS_MEMBERSHIP_PROOF_KEY=fixture-independent-membership-key-0123456789
export POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT=pos-membership-native-revision-v1
export POS_MEMBERSHIP_PRODUCT_IDS='["10"]'
export POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT=pos-legacy-import-membership-v1
export POS_MEMBERSHIP_FRESH_READER_CONTRACT=pos-membership-fresh-reader-v1
export POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY=isolated-purpose-specific-membership-history-key-012345
export POS_LEGACY_IMPORT_KEY=fixture-independent-private-import-key-0123456789
export POS_LEGACY_IMPORT_PROOF_KEY=fixture-independent-private-import-proof-0123456789
export POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT=pos-legacy-order-import-confirmation-v1
member_image=golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d
member_python="$member_root/../offline-cash-pricing/.venv/bin/python"
docker run --rm -v "$member_work:/work" -v pos-rewrite-membership-go-modules:/go/pkg/mod -v pos-rewrite-membership-go-build:/root/.cache/go-build \
 -w /work -e GOPROXY=off "$member_image" go test -mod=readonly -c -o /work/member.test ./internal/poscheckout/sourcefixture
bridge(){
 docker run --rm --network "$member_name" -v "$member_work:/work:ro" \
  -e POS_CSV_MEMBERSHIP_BRIDGE=1 -e POS_CSV_MEMBERSHIP_KIND \
  -e POS_MEMBERSHIP_PROOF_KEY -e POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT -e POS_MEMBERSHIP_PRODUCT_IDS \
  -e POS_LEGACY_IMPORT_KEY -e POS_LEGACY_IMPORT_PROOF_KEY -e POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT \
  -e POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT -e POS_MEMBERSHIP_FRESH_READER_CONTRACT \
  -e "EXCLUSIVE_PRODUCT_ID=$member_new" -e "EXCLUSIVE_QUARTERLY_ID_FREE=$member_free" -e "EXCLUSIVE_UPGRADE_IDS=$member_upgrade" -e "EXCLUSIVE_UPGRADE_365=$member_upgrade" \
  -e 'POS_CHECKOUT_MYSQL_DSN=root@tcp(mysql:3306)/pos_checkout_contract_test?parseTime=true' \
  "$member_image" /work/member.test -test.v -test.run "^TestImportMembership$1$"
}
cd "$member_backend"
for POS_CSV_MEMBERSHIP_KIND in new upgrade auto-free auto-history shopify-new shopify-upgrade shopify-auto-free shopify-auto-history;do
 export POS_CSV_MEMBERSHIP_KIND
 member_new=;member_upgrade=;member_free=
 case "$POS_CSV_MEMBERSHIP_KIND" in *upgrade)member_upgrade=10;; *auto-free|*auto-history)member_free=10;; *)member_new=10;; esac
 bridge Initialize
 "$member_python" -B "$member_root/native_membership_profile.py" stage
 npx -y node@24.22.3 node_modules/tsx/dist/cli.mjs tools/legacy-import-membership/native-bridge.ts staged
 case "$POS_CSV_MEMBERSHIP_KIND" in
  shopify*)bridge ShopifyRemainsPending;;
  *)bridge ActivationRollback;bridge Activate;npx -y node@24.22.3 node_modules/tsx/dist/cli.mjs tools/legacy-import-membership/native-bridge.ts activated;;
 esac
 "$member_python" -B "$member_root/native_membership_profile.py" cache
 if [ "$POS_CSV_MEMBERSHIP_KIND" = new ];then
  bridge Initialize
  "$member_python" -B "$member_root/native_membership_profile.py" stage
  "$member_python" -B "$member_root/native_membership_profile.py" cache-uncertain
  bridge MissingDescriptor
  bridge Initialize
  "$member_python" -B "$member_root/native_membership_profile.py" stage
  bridge ExternalWriter
  npx -y node@24.22.3 node_modules/tsx/dist/cli.mjs tools/legacy-import-membership/native-bridge.ts reject-stale
 fi
done
