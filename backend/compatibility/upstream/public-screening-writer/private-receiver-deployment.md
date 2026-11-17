# Private source receiver image

Build from `backend/` with the same reviewed, digest-pinned source dependency
image used for the cache consumer:

```sh
docker build -f compatibility/upstream/public-screening-writer/Containerfile \
  --target private-source-receiver \
  --build-arg SOURCE_DEPENDENCY_IMAGE="$POS_SOURCE_DEPENDENCY_IMAGE" \
  -t pos-private-source-receiver .
```

This target selects the owned `runtime.create_application()` WSGI factory on
port 4423. The pinned original API image uses Gunicorn; no dependency install
or original-source copy occurs during this build. Mount the qualified original
source read-only at `/opt/pos-original-source`, with the writer/broker/Redis CA
files and separately provisioned secrets. The process runs as UID/GID 65532.
The two source/runtime root variables must refer to that same mounted source.

Use a private authenticated ingress with the reviewed transport policy. Do not
publish this port as the customer API. Each resource also enforces its independent
caller key and purpose-bound contract. Source/import/model selection, physical
schema, source pins, current writer coverage and retained proof keys remain
mandatory; mounting the image cannot replace those prerequisites.

The server uses one synchronous worker and the bounded private database pool.
Gunicorn access/error streams are suppressed because they can include request
details or raw source exceptions. Owned resource handlers emit the structured
request/resource events through their retained safe stream. Supervise process
startup and shutdown; there is no fabricated HTTP readiness response for an
unqualified source. SIGTERM stops the worker, and in-flight native stages retain
their original receipt/reconciliation semantics after lost responses.

Run migrations as the separate explicit deployment step before selecting new
work. No constructor executes DDL. The container definition has been authored
only; build, startup, real ingress and financial acceptance remain for the final
validation/deployment phase.
