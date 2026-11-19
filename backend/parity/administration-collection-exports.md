> **Deleted (19 November 2026).** The administration list "queue all matching CSV" export is removed (user
> decision N4): legacy has no such job. Lists keep the client-side "Export visible page CSV". This note is
> historical evidence.

# Current administration collections in the shared export queue

`administration-list` is a date-free kind in the existing `report-exports` API and worker. Its strict resource/sort/column/filter schema is owned by `administration/collection-export-contracts.ts`. It has no `from`/`to` fields and cannot enter a dated report or historical-warehouse branch. Native queue and artifact metadata remain current operational state.

`reportExportBuilder` calls `administrationCollectionExport(config,db)`. It can also receive the same typed renderer via its internal `administration` dependency for isolated fixtures. The administration renderer owns current primary collection reads, finite columns, 500-row keyset batches, 70,000-row/byte limits and source authorization. This is one queue, storage implementation, worker and receipt lifecycle; no migration, registrar or worker flag is added.

The shared service calls `assertAdministrationCollectionExport` under writer-current actor/assignment locks before enqueue, build, heartbeat, file reservation, receipt read and download. Frozen store scope is supplied for selected-store collections. Internal manager all-store exports retain `requiresGlobal`; restricted store snapshots cannot broaden during a later worker pass. Recent/archive `canDownload` metadata runs the same native resource authority, deduplicated per scope in one transaction; only explicit 401/403 becomes unavailable, while unexpected database failures propagate. Disabling source admin permission cannot leave a misleading permitted download or leak the file through a stale principal.

The frontend helper `queueAdministrationCollectionExport(ownerId,input)` uses the exact existing `pos-report-export-command:<owner>:<hash>` journal and UUID/digest shape. It binds resource, actual scope, filters, sort and visible columns before POST, omits dates, and retains the same UUID after a lost response. It stores no list rows, contacts, names or search text. Old report helpers use the same dispatcher with unchanged normalized input order/absent options, preserving their existing retry hashes. Date-free downloads use `administration-<jobId>.csv` instead of fabricated dates.

Dependencies: administration implementation `dedd21e` and scope/privacy follow-up `59dfcb1`; the client helper is `225fee5`. The shared backend hookup follows those commits. Root owns integration and aggregate validation; the administration agent owns list UI and actual reader/source comparisons.

Focused evidence: `tests/operational-reports/administration-queue.test.ts` checks finite strict date-free input, old/current scope boundaries and dispatch without entering report/warehouse readers. The native export fixture queues, deduplicates, builds, reads and downloads an actual shared artifact, then revokes the current source role and verifies receipt/file/metadata denial without a second render. `frontend/tests/operational-reports/export-commands.test.ts` covers the same-command lost-response path and digest-only persistence. These local fixtures do not certify production S3, target deployment or full original administration workflows.
