# Public membership cache worker

Implementation validation is deferred. Build from `backend/` using the approved
original-source dependency image, including its immutable SHA-256 digest:

```sh
docker build -f compatibility/upstream/public-screening-writer/Containerfile \
  --build-arg SOURCE_DEPENDENCY_IMAGE="$POS_SOURCE_DEPENDENCY_IMAGE" \
  -t pos-public-membership-cache-worker .
```

The build packages only owned adapter modules and patches. It does not install
dependencies, copy the original source, or include credentials. Mount the exact
qualified API source read-only at `/opt/pos-original-source`. Its source/runtime
paths intentionally match; the runtime verifies the pinned source before import.
Supply the reviewed MySQL/broker CA files and deployment secrets separately.
The image runs as UID/GID 65532; mounts must be readable by that identity.
The inherited API entrypoint and health check are cleared. Supervise this
process as a queue consumer, with SIGTERM and enough termination time for its
bounded task and database cleanup; an API health URL does not measure it.

The worker is disabled by default. Enable only with
`POS_PUBLIC_SCREENING_MEMBERSHIP_WORKER_ENABLED=true` and
`POS_PUBLIC_SCREENING_MEMBERSHIP_WORKER_CONTRACT=pos-public-screening-membership-cache-worker-v1`.
Configure `POS_PUBLIC_SCREENING_MEMBERSHIP_CACHE_QUEUE` as one of the explicitly
qualified private broker queues in `POS_LEGACY_IMPORT_EFFECT_QUEUES`, together
with the existing source, AMQPS, Redis and writer-connection contracts. Apply the
registered additive public-benefit migration first. No startup DDL is performed.

Run the cache consumer separately from the public API and the warehouse history
publisher. It consumes only the configured queue with one task at a time. The
task authenticates the original completed benefit evidence before invalidation.
An uncertain outcome stays in review; restarting does not authorize another
financial action. Keep the durable evidence and proof keys across restarts.

Logs contain fixed lifecycle/resource events, request IDs, event-instance IDs
and operator IDs. Customer contact, task arguments, credentials, SQL and raw
exceptions are excluded. No worker build, startup, provider action or deployment
was executed while authoring this packaging change; final verification remains
required after the remaining implementation work.
