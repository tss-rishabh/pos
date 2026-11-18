#!/bin/sh
# Authoring only until the native execution slot is released by Root.
set -eu
umask 077
expiry_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
expiry_assembly=${1:?Supply a fresh independently assembled payments tree}
expiry_modules=${2:?Supply an owned offline module cache}
expiry_build=${3:?Supply a new owned build cache path}
expiry_reference=${4:?Supply the immutable pinned payments checkout}
expiry_evidence=${5:?Supply a new absolute evidence directory}
test "${POS_EXPIRY_NATIVE_SLOT_RELEASED:-}" = yes || { echo 'Native slot release is required.' >&2; exit 1; }
case "$expiry_evidence" in /*) ;; *) exit 1;; esac
test ! -e "$expiry_evidence" && test ! -e "$expiry_build"
test -d "$expiry_modules"
mkdir -m 700 "$expiry_evidence" "$expiry_build"
expiry_work=$(mktemp -d /tmp/pos-expiry-active.XXXXXX)
expiry_nonce=${expiry_work##*.}
expiry_name="pos-expiry-active-$expiry_nonce"
expiry_network_id=
expiry_mysql_id=
expiry_go_id=
expiry_compile_count=0
expiry_go='golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d'
expiry_mysql='mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902'
cleanup() {
  # cidfiles also cover interruption after creation but before shell assignment.
  for expiry_cidfile in "$expiry_work"/*.cid; do
    test -f "$expiry_cidfile" || continue
    expiry_owned_id=$(cat "$expiry_cidfile")
    case "$expiry_owned_id" in ''|*[!0-9a-f]*) continue;; esac
    test "${#expiry_owned_id}" -eq 64 || continue
    expiry_owned_label=$(docker inspect --format '{{index .Config.Labels "pos-rewrite.expiry-nonce"}}' "$expiry_owned_id" 2>/dev/null || true)
    if [ "$expiry_owned_label" = "$expiry_nonce" ]; then
      docker rm -fv "$expiry_owned_id" >/dev/null 2>&1 || true
    fi
  done
  if [ -f "$expiry_work/network.id" ]; then
    expiry_owned_network=$(cat "$expiry_work/network.id")
    case "$expiry_owned_network" in ''|*[!0-9a-f]*) expiry_owned_network=;; esac
    if [ "${#expiry_owned_network}" -eq 64 ]; then
      expiry_owned_label=$(docker network inspect --format '{{index .Labels "pos-rewrite.expiry-nonce"}}' "$expiry_owned_network" 2>/dev/null || true)
      if [ "$expiry_owned_label" = "$expiry_nonce" ]; then
        docker network rm "$expiry_owned_network" >/dev/null 2>&1 || true
      fi
    fi
  fi
  rm -rf "$expiry_work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
python3 - "$expiry_assembly" "$expiry_reference" "$expiry_here" "$expiry_evidence/preflight.json" <<'PY'
import hashlib, json, pathlib, re, subprocess, sys
assembly, reference, here = map(lambda v: pathlib.Path(v).resolve(strict=True), sys.argv[1:4])
pin = '434f3e438d1cb48c64e5723222c6efda506db571'
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def check(value):
    if not value: raise RuntimeError('ACTIVE_EXPIRY_PREFLIGHT_FAILED')
check(assembly != reference and reference not in assembly.parents and assembly not in reference.parents)
check(subprocess.check_output(['git','-C',str(reference),'rev-parse','HEAD'], text=True).strip() == pin)
check(not subprocess.check_output(['git','-C',str(reference),'status','--porcelain','--untracked-files=no'], text=True).strip())
manifest = json.loads((assembly/'pos-composed-payments-manifest.json').read_text())
check(manifest['sourceCommit'] == pin)
check(manifest['originComposerSha256'] == digest(here.parent/'compose.py'))
for name, expected in manifest['files'].items():
    path = assembly/name
    check(path.resolve().is_relative_to(assembly) and path.is_file() and not path.is_symlink() and digest(path) == expected)
methods = {'juspay/model.go':['RevertTssMoney','RevertTssPoints'],
           'juspay/origin_source.go':['revertOtherOriginMoney','revertOtherOriginPoints']}
sites = {}
for name, selected in methods.items():
    text = (assembly/name).read_text()
    for method in selected:
        matches = list(re.finditer(r'(?m)^func \(o \*Order\) '+method+r'\(', text))
        check(len(matches) == 1)
        start = matches[0].start()
        next_function = re.search(r'(?m)^func ', text[matches[0].end():])
        end = matches[0].end()+next_function.start() if next_function else len(text)
        body = text[start:end]
        check(body.count('.Format("2006-01-02")') == 2 and '2006-02-01' not in body)
        check(body.count('time.Now().Format("2006-01-02")') == 1)
        if method in ('RevertTssMoney','revertOtherOriginMoney'):
            check(body.count('"UPDATE users SET tss_money=? WHERE id=? LIMIT 1"') == 1)
            check('"UPDATE users SET cashback' not in body)
        if method == 'RevertTssMoney':
            check(body.count('rh := RewardPointHistory{') == 2 and body.count('utils.Db.Create(&rh)') == 2)
        if method == 'revertOtherOriginMoney':
            check('RewardPointHistory' not in body)
        sites[method] = {'sha256':hashlib.sha256(body.encode()).hexdigest(),'calendarLiterals':2,'clockSites':1}
inputs = {str(path.relative_to(here.parent)):digest(path) for path in
          [here.parent/'compose.py',here.parent/'transform_source.go',here/'expiry_candidate_test.go',
           here.parent/'origin_gateway_test.go',here/'run-active-calendar.sh']}
inputs['expiry-review/active-original-calendar_test.go'] = digest(here/'active-original-calendar_test.go')
pathlib.Path(sys.argv[4]).write_text(json.dumps({'sourcePin':pin,'assemblyManifestSha256':digest(assembly/'pos-composed-payments-manifest.json'),
    'inputHashes':inputs,'sites':sites,'scope':{'nativeGeneratedExpirySubcases':10,'nativeOriginalExpirySubcases':10,'tlsGatewayCases':2,
    'originalHistoryMirror':'retained source contract; separate financial acceptance required'}}, indent=2)+'\n')
PY
cp -R "$expiry_assembly/." "$expiry_work/"
cp "$expiry_here/expiry_candidate_test.go" "$expiry_work/juspay/expiry_candidate_test.go"
cp "$expiry_here/active-original-calendar_test.go" "$expiry_work/juspay/active-original-calendar_test.go"
cp "$expiry_here/../origin_gateway_test.go" "$expiry_work/juspay/origin_gateway_test.go"
expiry_assert_exited_successfully() {
  test "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$1")" = 'exited 0'
}
expiry_compile() {
  expiry_compile_count=$((expiry_compile_count+1))
  expiry_compile_cidfile="$expiry_work/compile-$expiry_compile_count.cid"
  docker create --pull=never --network none --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m \
    --label "pos-rewrite.expiry-nonce=$expiry_nonce" --cidfile "$expiry_compile_cidfile" \
    -v "$expiry_work:/work:ro" -v "$expiry_modules:/module-cache:ro" -v "$expiry_build:/build-cache" \
    -w /work -e GOMODCACHE=/module-cache -e GOCACHE=/build-cache -e GOTOOLCHAIN=local \
    -e GOPROXY=off -e GOSUMDB=off -e GOWORK=off "$expiry_go" go "$@" >/dev/null
  expiry_go_id=$(cat "$expiry_compile_cidfile")
  docker start -a "$expiry_go_id"
  expiry_assert_exited_successfully "$expiry_go_id"
  docker rm -v "$expiry_go_id" >/dev/null
  expiry_go_id=
}
# These gates see all four active methods before any test clock/env substitution.
expiry_compile build -mod=readonly ./internal/poscheckout ./juspay >"$expiry_evidence/build.log" 2>&1
expiry_compile vet -mod=readonly ./internal/poscheckout ./juspay >"$expiry_evidence/vet.log" 2>&1
python3 - "$expiry_work/juspay" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1]); replaced = 0
for filename, methods in {'model.go':('RevertTssMoney','RevertTssPoints'),
                          'origin_source.go':('revertOtherOriginMoney','revertOtherOriginPoints')}.items():
    path = root/filename; text = path.read_text()
    for method in methods:
        matches = list(re.finditer(r'(?m)^func \(o \*Order\) '+method+r'\(', text))
        if len(matches) != 1: raise RuntimeError('DISPOSABLE_CLOCK_SCOPE_CHANGED')
        begin = matches[0].start(); tail = re.search(r'(?m)^func ', text[matches[0].end():])
        end = matches[0].end()+tail.start() if tail else len(text)
        body = text[begin:end]; old = 'time.Now().Format("2006-01-02")'
        if body.count(old) != 1: raise RuntimeError('DISPOSABLE_CLOCK_COUNT_CHANGED')
        text = text[:begin]+body.replace(old,'originExpiryFixtureNow().Format("2006-01-02")',1)+text[end:]
        replaced += 1
    if text.count('originExpiryFixtureNow().Format("2006-01-02")') != 2:
        raise RuntimeError('DISPOSABLE_FILE_CLOCK_TOTAL_CHANGED')
    path.write_text(text)
if replaced != 4:
    raise RuntimeError('DISPOSABLE_CLOCK_TOTAL_CHANGED')
PY
# Existing package init would overwrite provider/DB env and AutoMigrate live DSNs.
# Replace only the disposable copy's loader with the existing isolated contract.
cat > "$expiry_work/config/env.go" <<'GO'
package config
import "os"
func InitEnv(){if os.Getenv("ENV")!="POS_ORIGIN_FIXTURE"||os.Getenv("DB")!="root@tcp(mysql:3306)/pos_origin_contract_test?parseTime=true"{panic("refusing non-isolated origin fixture startup")}}
GO
docker network create --internal --label "pos-rewrite.expiry-nonce=$expiry_nonce" "$expiry_name" >"$expiry_work/network.id"
expiry_network_id=$(cat "$expiry_work/network.id")
docker create --pull=never --network "$expiry_network_id" --network-alias mysql \
  --label "pos-rewrite.expiry-nonce=$expiry_nonce" --cidfile "$expiry_work/mysql.cid" \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=pos_origin_contract_test \
  "$expiry_mysql" >/dev/null
expiry_mysql_id=$(cat "$expiry_work/mysql.cid")
docker start "$expiry_mysql_id" >/dev/null
expiry_attempt=0
until docker exec "$expiry_mysql_id" mysql --protocol=TCP -h127.0.0.1 -uroot -Dpos_origin_contract_test -e 'SELECT 1' >/dev/null 2>&1; do
  expiry_attempt=$((expiry_attempt+1)); test "$expiry_attempt" -lt 60 || exit 1; sleep 1
done
docker create --pull=never --network "$expiry_network_id" --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m \
  --label "pos-rewrite.expiry-nonce=$expiry_nonce" --cidfile "$expiry_work/native-go.cid" \
  -v "$expiry_work:/work:ro" -v "$expiry_modules:/module-cache:ro" -v "$expiry_build:/build-cache" \
  -w /work -e GOMODCACHE=/module-cache -e GOCACHE=/build-cache -e GOTOOLCHAIN=local \
  -e GOPROXY=off -e GOSUMDB=off -e GOWORK=off -e ENV=POS_ORIGIN_FIXTURE \
  -e POS_ORIGIN_EXPIRY_CANDIDATE=1 -e 'DB=root@tcp(mysql:3306)/pos_origin_contract_test?parseTime=true' \
  -e 'POS_ORIGIN_MYSQL_DSN=root@tcp(mysql:3306)/pos_origin_contract_test?parseTime=true' \
  "$expiry_go" go test -mod=readonly -race -count=1 -timeout=5m \
  -run '^(TestOriginExpiryReviewNativeWallets|TestOriginActiveOriginalCalendarWallets|TestOriginGatewayLostOrderACKRecoversOnlyGET|TestOriginGatewayDirectRecoveryCannotCreateCustomer)$' \
  -json ./juspay >/dev/null
expiry_go_id=$(cat "$expiry_work/native-go.cid")
docker start -a "$expiry_go_id" >"$expiry_evidence/native.jsonl" 2>"$expiry_evidence/native.stderr"
expiry_assert_exited_successfully "$expiry_go_id"
docker rm -v "$expiry_go_id" >/dev/null
expiry_go_id=
python3 - "$expiry_evidence" "$expiry_assembly" "$expiry_reference" "$expiry_here" <<'PY'
import hashlib, json, pathlib, subprocess, sys
directory = pathlib.Path(sys.argv[1]); events = [json.loads(line) for line in (directory/'native.jsonl').read_text().splitlines()]
parents = ('TestOriginExpiryReviewNativeWallets','TestOriginActiveOriginalCalendarWallets')
expected = {*parents, 'TestOriginGatewayLostOrderACKRecoversOnlyGET','TestOriginGatewayDirectRecoveryCannotCreateCustomer'}
expected.update(parent+'/'+asset+'/'+date for parent in parents for asset in ('money','points') for date in
                ('2026-12-01','2026-10-20','2026-11-18','2026-11-17','2027-01-01'))
passed = [event['Test'] for event in events if event.get('Action') == 'pass' and 'Test' in event]
if len(passed) != 24 or set(passed) != expected or any(event.get('Action') in ('fail','skip') for event in events):
    raise RuntimeError('EXACT_ACTIVE_CALENDAR_SCOPE_DID_NOT_PASS')
if not any(event.get('Action') == 'pass' and 'Test' not in event for event in events):
    raise RuntimeError('NATIVE_PACKAGE_DID_NOT_PASS')
evidence = json.loads((directory/'preflight.json').read_text())
assembly, reference, here = map(lambda value: pathlib.Path(value).resolve(strict=True), sys.argv[2:5])
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
if digest(assembly/'pos-composed-payments-manifest.json') != evidence['assemblyManifestSha256']:
    raise RuntimeError('ASSEMBLY_MANIFEST_CHANGED_DURING_RUN')
manifest = json.loads((assembly/'pos-composed-payments-manifest.json').read_text())
if any(digest(assembly/name) != expected for name, expected in manifest['files'].items()):
    raise RuntimeError('ASSEMBLY_INPUT_CHANGED_DURING_RUN')
if any(digest(here.parent/name) != expected for name, expected in evidence['inputHashes'].items()):
    raise RuntimeError('ACTIVE_PRODUCER_OR_FIXTURE_CHANGED_DURING_RUN')
if subprocess.check_output(['git','-C',str(reference),'rev-parse','HEAD'], text=True).strip() != evidence['sourcePin'] or subprocess.check_output(['git','-C',str(reference),'status','--porcelain','--untracked-files=no'], text=True).strip():
    raise RuntimeError('PINNED_SOURCE_CHANGED_DURING_RUN')
evidence.update({'completed':True,'defaultVet':True,'race':True,'generatedExpirySubcasesPassed':10,'originalExpirySubcasesPassed':10,'tlsGatewayCasesPassed':2,
    'originalMethodsNativeInvoked':True,'passedTestEvents':passed,
    'rawEventsSha256':hashlib.sha256((directory/'native.jsonl').read_bytes()).hexdigest()})
(directory/'result.json').write_text(json.dumps(evidence, indent=2)+'\n')
print('Active calendar verification passed: 10 original + 10 generated expiry subcases, 2 TLS recovery cases; retained original history mirror remains a separate financial-acceptance item.')
PY
