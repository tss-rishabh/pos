# Original API origin supervisor

`source_worker.py` supervises the actual original system-order and source-effects
ports. It does not listen for HTTP requests, accept financial payloads from CLI
arguments or replace the rewritten backend. Core registry/recovery methods are
still being integrated; this authored supervisor is pending final validation.

Build from `backend/` with the reviewed, digest-pinned original API dependency
image:

```sh
docker build -f compatibility/upstream/public-screening-writer/Containerfile \
  --target source-origin-worker \
  --build-arg SOURCE_DEPENDENCY_IMAGE="$POS_SOURCE_DEPENDENCY_IMAGE" \
  -t pos-source-origin-worker .
```

Mount two separate source trees read-only:

- The immutable API-v2 base at `/opt/pos-original-source`, revision
  `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`, matching the existing
  `POS_LEGACY_IMPORT_SOURCE_ROOT` and `POS_LEGACY_IMPORT_RUNTIME_ROOT`.
- The corresponding public API candidate at `/opt/pos-public-source`, composed
  using `public-pos-screening.patch`. The worker validates the packaged public
  manifest's candidate hashes before importing that tree's `main` module.

The candidate is distinct from the immutable base because its `main.py`, order
controller and owned bootstrap/guard entries are deliberately changed. The image
packages only owned adapters/manifests. It runs as UID/GID 65532 and starts with
the supervisor and both work lanes disabled.

Select `POS_SCREENING_ORIGIN_SOURCE_WORKER_CONTRACT` as
`pos-screening-origin-source-worker-v1`, enable `...WORKER_ENABLED=true` and
explicitly select one or both `...WORKER_SYSTEM_ENABLED` and
`...WORKER_EFFECTS_ENABLED`. It also requires the existing
`POS_SCREENING_ORIGIN_CONTRACT=pos-screening-origins-v1` and independent proof
key. The system lane additionally requires
`POS_SCREENING_ORIGIN_SYSTEM_CONTRACT=pos-screening-origin-system-v1`.
Supply the same qualified source configuration, schema/grants, private transport
contracts and separately mounted secrets used by the composed original API.
The source-owned registry remains responsible for actual broker/Redis/task
qualification; missing methods/configuration cannot produce a successful startup.

The image command is
`python3 /opt/pos-source-adapters/screening-origins/source_worker.py`.
The only optional argument is `--once`, equivalent to
`...WORKER_ONCE=true`. `...WORKER_BATCH` accepts 1–25 (default 10), and
`...WORKER_INTERVAL_MS` accepts 1000–60000 (default 2000). No credentials or
command/customer IDs are accepted as CLI arguments. Disabled/demo startup
imports no original source and opens no database/broker/Redis connection.

The system port's bounded `worker_candidates(limit)` supplies original command
UUIDs, and `run(id)` controls first-dispatch versus retained GET-only recovery.
The effects port's `effect_candidates(limit)` and `dispatch_effects(id)` retain
the source SENDING/acknowledgement semantics. The supervisor never scans JSON
payloads, guesses an unknown outcome, issues replacement command IDs or dispatches
an effect directly. An observed handler phase is logged as an observation, not
as proof of financial completion.

SIGINT/SIGTERM stops new claims, wakes polling and permits the active source
stage to finish. A 40-second shutdown limit retains the original native/remote
reconciliation boundary if the process must be killed. Source-owned cleanup
closes resources before exit; the fallback disposes the source writer engine.
Source logs/stdout/stderr remain muted through interpreter exit. The independent
allowlisted events include module/resource/event IDs, original command UUID
correlation, optional authenticated actor IDs and UTC timestamps, never payloads,
paths, tokens, URLs, raw SQL or exception text. This supervisor performs no DDL.
