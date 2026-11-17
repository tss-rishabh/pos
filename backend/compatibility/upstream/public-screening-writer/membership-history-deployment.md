# Public membership history publisher

This separate Node process prepares reusable membership history generations.
Checkout reads the qualified warehouse generation and can enqueue a validated
missing-generation request; it does not capture historical MySQL data inline.
Implementation validation is deferred until feature integration is complete.

From `backend/`, build the `membership-history-worker` Docker target or run the
compiled application with `npm run worker:membership-history`. Both select
`dist/modules/checkout/screening-writer/membership-generation-main.js`.
The process is disabled by default and accepts no command-line arguments.

Use the deployment secret mechanism for the source-proof, history, publication
and independent journal keys. Mount distinct reader and publisher service-account
files through `PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_READER_KEY_FILE` and
`PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_WRITER_KEY_FILE`. The supplied reporting
account is read-only and cannot serve as the publisher. Credentials belong only
in the worker deployment; checkout needs its own read-only warehouse identity.

Apply the registered additive `membership-generation-migration.sql` before
enabling operational demand. Configure
`PUBLIC_SCREENING_MEMBERSHIP_DEMAND_CONTRACT=pos-public-membership-generation-demand-v1`
on checkout with its journal key. No constructor or application startup creates
database tables. The source writer-origin identity, reviewed trigger definer,
read-only source connection and CA must match the actual qualified deployment.

Configure the dedicated `BQ_PUBLIC_SCREENING_MEMBERSHIP_*` views and publication
table. These differ from the CSV import publication schema. The review SQL is
an explicit warehouse deployment input; naming a view does not populate it.
The independent comparison must establish complete matching source primitives
before any usable publication is sealed.

`PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_ENABLED=true` selects the process.
`PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_NEW_WORK_ENABLED` separately selects new
capture/publication intent creation. Keep new work disabled during recovery of
retained journal jobs. Preserve those records and their original keys/configuration
across restarts. Unknown jobs reconcile under the original deterministic job ID;
GET/404 does not authorize another INSERT. Configure all selectors and limits
using the blank/default-off examples in `backend/.env.example`.

Supervise the worker with SIGTERM and enough time for its bounded active work
and pool cleanup. It exposes no HTTP endpoint. Keep this process separate from
the source membership cache consumer. Its logs contain resource events, opaque
trace IDs and operator IDs; customer contact, payloads, SQL and credentials are
excluded. No build, worker invocation or live publication was performed while
authoring these deployment inputs.
