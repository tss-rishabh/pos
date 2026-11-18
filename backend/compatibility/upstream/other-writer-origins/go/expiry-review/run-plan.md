# Active calendar expiry verification preflight

Authored after approval/activation `b30b679`. **Runner not executed.** Native
execution remains held until notification verification terminates and Root
releases the native slot. This is a run plan, not a verification receipt.

The existing `../run-native-tests.sh` supplies the pinned Go 1.25.4/MySQL 8.4
isolation/startup contract, but does not copy the expiry review fixture and runs
a broader suite. `run-active-calendar.sh` uses the unchanged retained
`expiry_candidate_test.go` and `../origin_gateway_test.go`, with exact case
selection and calendar expectation mode. Original-bug expectation mode and the
historical failing/default-vet evidence remain unchanged. No fixture assertions
are removed or weakened, and no source/prod/provider endpoint is accepted.

The ten retained wallet subcases invoke the two generated selected methods.
The additive `active-original-calendar_test.go` invokes both original methods
with the same five-date vectors, adding ten more wallet cases. All cases require
cashback7. Original methods temporarily receive the same strictly isolated ORM
through their argument and `utils.Db`, with the global restored by cleanup and
no parallel execution. The original reward-history mirror remains asserted as a
retained source contract and flagged for separate financial acceptance; selected
generated Money retains its existing absence of that mirror. Both original and
generated methods receive exact DateOnly/clock-site assertions, assembly-file
hashes and complete build/vet before clock/environment substitution.

## Requirements and preparation

- Finish implementation first. Wait for the active native notification run and
  other competing native workloads to end. Set the slot acknowledgement only
  after Root confirms this condition.
- Preserve the original clean payments checkout at
  `434f3e438d1cb48c64e5723222c6efda506db571`. The runner rejects another HEAD or
  tracked modifications. It never mutates the checkout.
  The existing checkout at
  `/Users/rishabhbhatia/code/security-scans-20261113/backend-tss-domestic_payments_api`
  currently has that HEAD; the later preflight must also confirm clean bytes.
- Use locally cached digest-pinned images from `../run-native-tests.sh`:
  Go `1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d`
  and MySQL `8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902`.
  Pulls, module proxies and automatic toolchain downloads remain disabled.
- Prepare a task-owned copy of the existing complete offline module cache and a
  fresh build-cache path. The module cache is mounted read-only. No shared cache
  mutation or dependency installation is part of this verification.
  An existing source cache is `/private/tmp/pos-origin-module-cache-20261118`;
  copy it into the new task's directory rather than mutate that cache. The
  previous candidate's source/runtime trees are historical and must not be
  reused as the fresh active assembly.
- Assemble fresh from the current approved producer graph using
  `compatibility/upstream/assemble_payments.py::assemble_payments(...)`. Supply
  its existing `generate(args)` callback with the pinned Go image, network none,
  read-only contract/reference/build-tree mounts and a **task-owned** build cache.
  The CLI's default Docker producer names a shared cache volume, so use the
  callback instead of silently writing that shared volume. Generation is deferred
  alongside native execution. The existing payments-assembly documentation
  defines source pins and overlay ordering.
- The fresh assembly must contain a valid complete
  `pos-composed-payments-manifest.json`. The runner checks every file hash and
  the current composer hash before touching its disposable copy. Both original
  and generated methods must contain exactly two DateOnly literals and one
  current-clock comparison each; stale swapped layouts fail preflight.

## Single canonical invocation after release

From `backend`, with all five absolute paths supplied explicitly:

```sh
POS_EXPIRY_NATIVE_SLOT_RELEASED=yes \
  sh compatibility/upstream/other-writer-origins/go/expiry-review/run-active-calendar.sh \
  /absolute/fresh-owned-payments-assembly \
  /absolute/task-owned-offline-module-cache \
  /absolute/new-task-owned-go-build-cache \
  /absolute/clean-pinned-payments-checkout \
  /absolute/new-private-expiry-evidence-directory
```

The runner creates one private copied tree, one unique internal-only Docker
network and one disposable MySQL database without published host ports. It first
builds and vets `./internal/poscheckout ./juspay` with the active four methods
unchanged. It then freezes exactly one clock comparison in each of the four
original/generated restoration methods in the disposable test copy, matching
the retained fixture's 2026-11-18 clock. No other `time.Now()` site is replaced.
The disposable loader guard permits only the exact
fixture DSN, avoiding original package startup overwriting provider/database env.

One `go test -mod=readonly -race -count=1 -timeout=5m -json ./juspay` execution,
with default vet, selects exactly both wallet fixture parents and two retained
TLS gateway cases. Success requires all twenty wallet child cases, both TLS
cases, both parents and the package pass (24 named pass events); any failure,
skip, missing or duplicate case fails
the receipt. Raw JSON events, stderr, build/vet logs and hashed preflight/result
receipts remain in the private evidence directory; do not paste raw diagnostics
or synthetic request values into public logs. The runner cleans its own network,
containers and copy on exit and leaves the owned build cache for review/cleanup.

No benchmark execution is implied. No production readiness, live provider
qualification or broad source parity follows from this bounded result.
