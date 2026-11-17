# Coupon history worker deployment

This worker prepares coupon history independently of checkout. Implementation
validation is deferred until the complete feature implementation phase ends.
These instructions do not certify this build for production.

Build from the backend directory:

```sh
docker build --target coupon-history-worker -t pos-coupon-history-worker .
```

The image runs as the unprivileged `node` user. It exposes no HTTP listener.
Provide the reviewed worker environment and read-only credential mounts through
the deployment secret mechanism. Keep `CSV_COUPON_GENERATION_WORKER_ENABLED=false`
until migrations, source controls, native writer coverage, warehouse layouts and
separate publication permissions have been deployed and validated.

Required operational dependencies are:

- The two additive rewrite migrations `coupon-generation-migration.sql` and
  `coupon-generation-demand-migration.sql`, applied through the registered
  migration command. Construction and startup do not create database tables.
- A private source controls endpoint with its independent caller key. Source
  UUID/schema and the actual writer definition must match the reviewed origin.
- Explicit `CSV_COUPON_GENERATION_READER_KEY_FILE` and
  `CSV_COUPON_GENERATION_WRITER_KEY_FILE` mounts. The reporting service account
  supplied for this project is strictly read-only and cannot serve as the writer.
- Qualified generation/candidate/primitive views and separately authorized
  append-only publication destinations. The review SQL files are deployment
  inputs; configuring their names does not create or populate them.
- Independent source-proof, coupon-history, coupon-publication and encrypted
  journal keys. Retain original keys while their outstanding jobs need recovery.

The web application may select the encrypted demand queue using
`CSV_COUPON_GENERATION_DEMAND_CONTRACT=pos-csv-coupon-generation-demands-v1`.
Validated source previews can enqueue operational demand; they do not run the
publisher. Run one or more supervised worker instances with the same durable
journal and qualified configuration. Shutdown must allow the configured work
deadline before forced termination. Preserve journal records across restarts;
unacknowledged publication jobs recover through their original IDs.

`CSV_COUPON_GENERATION_WORKER_ENABLED` controls the process. With it disabled,
the command exits without opening pools or reading credentials.
`CSV_COUPON_GENERATION_NEW_WORK_ENABLED` separately controls new capture and
publication intent creation. Keep the process enabled and new work disabled to
recover already recorded jobs with their retained configuration and keys.
New work also requires `CSV_COUPON_GENERATION_WRITER_CONTRACT` to select
`pos-csv-coupon-generation-writer-v1`, the demand contract above, the runtime
contract, and the private controls contract
`pos-csv-coupon-generation-controls-v1`. Configure the controls URL/key through
the `CSV_COUPON_GENERATION_CONTROLS_*` variables. The corresponding source service
uses its own `POS_COUPON_GENERATION_CONTROLS_*` variables.

Use `CSV_COUPON_GENERATION_SOURCE_TLS_CA_FILE` for the reviewed source MySQL CA.
The source connection reads from the explicitly identified writer origin with
read-only credentials; it never substitutes an application reader after an
identity mismatch. Configure the source UUID/schema explicitly. Never paste a
credential-bearing connection URL into a deployment log, support ticket or
command-line argument.

For an installed backend build, the equivalent command is:

```sh
npm run worker:coupon-history
```

Keep publisher credentials out of the web/desktop deployment. Follow the
application's bounded static resource-event logging; never forward credential
files, SQL, customer identifiers, preview witnesses or encrypted payload values
into logs. Physical deployment and live publication remain separate acceptance
work; no live writes were performed while preparing this artifact.
