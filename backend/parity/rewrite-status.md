# POS rewrite milestone

Source baseline: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. Reviewed implementation snapshot: `5f9c757`, 18 November 2026. This document separates implemented code, executed checks and release acceptance. Production readiness remains false.

## Implementation

The [source map](source-surface-map.md) retains all **396 surfaces**: 255 leaf routes, 32 jobs, 106 templates, one WebSocket and two administration registrations. Its current classification is 100 implementation-present, 292 external-acceptance and four explicit inactive/diagnostic dispositions. No additional active source-feature code gap is identified by that map. These are implementation classifications, not certified workflows or a completion percentage.

The four dispositions retain the diagnostic account task, the inactive upload-log template and two inactive business-metrics templates. Their original IDs remain visible; the rewrite does not invent credential logging, account creation or upload functionality from commented source behavior.

The latest membership port closes a real runtime-authority incompatibility in Node, Python and Go. It authenticates four native revision fences through the shared 17-section metadata contract without granting application accounts TRIGGER privileges. The [review](membership-revision-head-metadata.md) records the exact owner, body, grant, isolation and rollback requirements. The regenerated 114-file payments assembly compiled offline with locked Go modules; [its bounded receipt](evidence/membership-revision/assembly-contract.json) does not certify deployment or complete financial workflows.

A separate security implementation gap remains: the reviewed development-toolchain picomatch mitigation has not yet been integrated into both dependency locks and build contexts. Integration is underway in an isolated worktree. The [security review](../tools/dependency-security/README.md) keeps the advisory and compatibility restrictions explicit. Runtime exposure and development-toolchain exposure must not be conflated. The standing user order remains: complete implementation first, then full parity and verification.

## Executed validation

The frozen `b201724` r5 run executed 130 project checks: 123 passed and seven failed. Backend results were 2,688 passed, one stale route-count assertion failed and 90 skipped. Generic app browser checks were not executed after earlier failures. All seven failures have integrated fixes with targeted evidence in [CHECKPOINT.md](../../CHECKPOINT.md); the original complete run remains failed.

The `5f9c757` r6 run was deliberately interrupted when the unintegrated security mitigation was confirmed. [Its original report](../evidence/verification-5f9c757-r6-interrupted.json) remains failed, interrupted and productionReady false, with unchanged inputs. A reporting defect omitted prepared parallel compiler results from that partial JSON; the private stdout records 48 successful project checks and two signal-stopped compiler checks. The verifier has been corrected to retain those results and record termination signals. No backend/native/browser completion is claimed for r6.

Desktop CI run `44235902175` passed Windows and macOS on `cd179c5`, including unsigned packaging, native/offline and integrity checks. It predates the metadata port. Run `44242069782` targets pre-mitigation `5f9c757`; consult its actual terminal status rather than treating an in-progress job as passed. Signing, installed-device/printer acceptance and production distribution remain separate requirements.

## Current parity and release evidence

The [release ledger](release-coverage.json) contains one historical verified quote-route entry. Its [receipt](../evidence/quotes-route-01da4ea.json) is now stale because the referenced authentication module changed. There are **zero currently valid source-surface certificates**; the old 1/396 statement did not account for that checksum failure. Preserve the old receipt. Re-execute its pinned handler/API/browser scope and issue a fresh bounded receipt before restoring a current certification.

The [gate](../tools/parity-gate.ts) requires current source identity, exact inventory coverage, implementation/test paths and successful checksum-bound evidence. Those mechanical checks do not establish workflow scope themselves: a broad green test run cannot justify bulk promotion of unrelated source surfaces. Every workflow still needs actual source-equivalent response/error, scope, money, ordering and side-effect evidence as required by [spec.md](../../spec.md).

After security integration and full verification, the closest self-contained admission work is the quote route, followed by the eight surfaces covering country/postal lookup, product feedback, shortcut help and parent-association repair. Existing source/native and browser checks must be joined through actual authenticated APIs and shared fixtures; intercepted browser responses alone do not prove that link. Store/operator administration, terminal/settings, shell/dashboard, jobs and all external cohorts retain their own complete workflows and retry/failure obligations.

The 12 release requirements remain independently pending or blocked. Real Google tenant/callback acceptance, warehouse business-row parity and freshness/publication, coordinated inventory and financial writers, provider/broker/receiver contracts, physical offline devices and printers, signing, measured performance, security closure and deployment/rollback rehearsal remain unproven. Read-only warehouse access, an opt-in adapter, successful compilation or unsigned desktop CI does not complete those requirements.

The known source wallet calendar defect also retains its [pending policy decision](../compatibility/upstream/other-writer-origins/go/expiry-review/parity-decision.md). Its correction remains inactive; default full upstream vet and defect-free wallet behavior must not be claimed.
