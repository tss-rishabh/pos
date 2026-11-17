# Legacy POS origin effects worker

This is a dedicated postcommit consumer for the original Django POS cash
receipts. It does not replace the rewritten Node server or desktop/web app.
The source worker is still being integrated; container build, startup and
acceptance are deferred until implementation is complete.

Build from `backend/` using the reviewed legacy POS dependency image:

```sh
docker build -f compatibility/upstream/screening-origins/LegacyContainerfile \
  --target legacy-origin-effects-worker \
  --build-arg LEGACY_POS_DEPENDENCY_IMAGE="$POS_LEGACY_DEPENDENCY_IMAGE" \
  -t pos-legacy-origin-effects .
```

The supplied image must be pinned by digest and contain the actual legacy POS
Python dependencies. It is separate from the Falcon API dependency image.
No package installation or original source copy occurs in this adapter layer.
The worker runs as UID/GID 65532, has no listener and starts disabled.

Mount the reviewed legacy POS candidate source read-only at
`/opt/pos-legacy-source`, generated from source commit
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` with `legacy-pos-origin.patch`.
The packaged `legacy-manifest.json` must match that candidate. The worker uses
the actual `POSAdmin.settings` and the selected Django database alias; mount
the required CA files and supply the normal database configuration separately.
Do not mount a substituted API-v2 source tree at this legacy path.

Select the base `POS_SCREENING_ORIGIN_CONTRACT=pos-screening-origins-v1` with
the retained independent `POS_SCREENING_ORIGIN_PROOF_KEY`. Enable the consumer
only after reviewing/applying its registered additive control migrations and
qualifying original effect recipients. Its selectors are
`POS_SCREENING_ORIGIN_LEGACY_EFFECTS_WORKER_ENABLED=true` and
`POS_SCREENING_ORIGIN_LEGACY_EFFECT_HTTP_CONTRACT=pos-screening-origin-legacy-effects-v1`.
It reads the original configured producer and engagement URLs; the container
does not create endpoints or credentials. Those receivers require the reviewed
origin-effect transport contract.

The image runs
`python3 /opt/pos-source-adapters/screening-origins/legacy_worker.py`.
An explicit supervisor invocation can append `--once` for one bounded batch.
No constructor applies DDL, and a lost effect response must retain its original
effect reference for reconciliation. A process exit is not delivery proof.
Runtime, privacy, shutdown and actual receiver acceptance remain part of the
final validation phase.
