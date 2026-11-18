# Other-origin Go verification orchestration

This wrapper is authored for registration in the full verifier. Native execution
has not been performed for this wrapper. The three phases are separate bounded
checks; passing them does not establish complete public HTTP/controller/provider
parity or authorize deployment, schema installation, or live financial writes.

Supply both paths explicitly. There are no developer-specific default paths:

```sh
export POS_ORIGIN_PAYMENTS_SOURCE_ROOT=/absolute/clean-pinned-payments-checkout
export POS_ORIGIN_GO_MODULE_CACHE_SOURCE=/absolute/caller-owned-offline-module-cache
sh tools/other-origin-verification/run.sh preflight
sh tools/other-origin-verification/run.sh general
sh tools/other-origin-verification/run.sh head
sh tools/other-origin-verification/run.sh calendar
```

Run from an existing backend checkout with Node 24 on PATH and its already
installed `tsx`/`mysql2` dependencies. No package installation is attempted.
The payments checkout must be clean at
`434f3e438d1cb48c64e5723222c6efda506db571`. The module-cache directory must be
caller-owned, contain `cache/download`, and contain no symlinks. Its complete
offline contents are a prerequisite; missing modules fail offline compilation.
Preflight inspects the two exact locally cached image digests below. It never
pulls an image, contacts a module proxy, compiles, assembles source, or starts a
container. Actual phases need the coordinated native execution slot.

- Go `1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d`
- MySQL `8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902`

Each phase creates a mode-0700 nonce directory under the system temporary
directory, copies the module cache, and assembles a fresh payments tree using
the existing `assemble_payments(..., generate=...)` API. Its AST callback uses
the pinned Go image, read-only source/staging mounts, no network, and its own
producer build cache. It never uses the assembler CLI's shared cache volume.
The source/producer hash maps, immutable assembly manifest, private diagnostics,
resource journal, and final result remain in that directory for review. Console
output contains a fixed event ID, phase result and evidence directory only.
Runner output is limited to 32 MiB; exceeding the bound fails the phase instead
of accepting a silently truncated log. Remove the private invocation directory
after retaining the required evidence; it contains copied source and caches.

## Phase boundaries

`general` invokes the unchanged `go/run-native-tests.sh`, requiring its six
engine/funding/key groups and two TLS gateway cases to pass. This runner's
dedicated head preparation/FirstStart skips are expected here; they are covered
by the separate `head` phase. Its disposable loader replacement remains the
existing general-runner fixture boundary.

`head` first builds and vets the untouched fresh assembly offline. It then
copies it into a separate runtime input and replaces **only** `config/env.go`
with a guard requiring `ENV=POS_ORIGIN_HEAD_FIXTURE` and
`DB=root@tcp(mysql:3306)/native_head_go_validation?parseTime=true`. The head
runner creates and uses exactly `native_head_go_validation`; its host installer
URL remains the required passwordless-root loopback
`/pos_rewrite_checkout_test` URL on this phase's ephemeral loopback relay port.
The owned Docker proxy forwards those fixture-only Go environment settings.
The original and replacement loader hashes are recorded, and original source
bootstrap behavior is explicitly excluded from the result. The actual unchanged
`run-head-native-tests.mjs` installs its native authority fixture and runs all
four required head/capacity/FirstStart groups. Any skipped head case or missing
required pass fails orchestration. Diagnostic vet bypass is never forwarded.

The host installer uses `relay.py`, which streams protocol bytes through a fixed
`docker exec -i <nonce-owned-mysql-id> /bin/bash -c <fixed-/dev/tcp-command>`.
No database port is published from the internal network, no additional image
is needed, and the Go tests continue connecting directly to the same native
server at `mysql:3306`. The relay binds only `127.0.0.1`, limits concurrent
connections to 32 and each direction's pending buffer to approximately 1 MiB,
uses `os.read`/nonblocking writes, and never logs SQL or protocol bytes.
COM_QUIT and server EOF are streamed normally. Client write-half-close closes
Docker stdin while retaining server output; bash `/dev/tcp` cannot propagate
an exact TCP `shutdown(SHUT_WR)`, so arbitrary TCP half-close equivalence is
excluded. This is a MySQL fixture transport seam with no latency claim.
The exact exec shell emits only its numeric PID on a private stderr control
pipe; validated numeric PID termination stops that shell and its reader cat
when a connection ends or the phase is interrupted. Accepted sockets, exec
clients, worker threads and the listener close before owned Docker cleanup;
the result records these lifecycle postconditions without protocol contents.

`calendar` invokes the unchanged current `expiry-review/run-active-calendar.sh`
with all five explicit paths: fresh assembly, private offline module cache,
nonexistent fresh build cache, pinned source checkout, and nonexistent private
calendar evidence directory. Its case/financial-policy logic is owned by that
runner; this wrapper does not duplicate it. The existing slot acknowledgement
is set only inside the actual phase invocation. Its own receipt remains the
authority for the exact wallet/TLS case set and financial acceptance limits.

All container/network creates performed through the phase-private Docker proxy
receive the nonce ownership label. Only the exact pinned images are accepted;
pulls are disabled, Go toolchain/proxy/sumdb downloads are disabled, and every
created network is internal. The proxy records persistent container IDs and
their actual anonymous volume names before existing runner cleanup. Final
cleanup validates nonce ownership, removes remaining owned containers/networks
and only the recorded owned volumes, then verifies their absence. No global
prune or unrelated dangling-volume cleanup occurs. Catchable interruption stops
the active runner process group before resource cleanup; SIGKILL/host failure
still requires inspecting the retained journal/nonce label manually.

## Minimal full-verifier registration

Root should validate and explicitly forward only the two path variables above
into its sanitized child environment, following existing source-root handling.
Under `--mysql`, register `sh tools/other-origin-verification/run.sh preflight`
as a prerequisite and register three serial checks with final argument
`general`, `head`, and `calendar`. Keep distinct IDs/results and retain each
private receipt. Do not reuse successful prior runs, prior assemblies, build
caches, default shared Go volumes, or the unrelated public-screening bridge as
evidence for these phases. No shared verifier/config edits are included here.
