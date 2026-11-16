# Reader and infrastructure evidence

Read-only AWS metadata was checked at 2026-11-16T02:21:09.726499+00:00 in `ap-south-1`. The visible cluster is `tss-live-rep-cluster`, `aurora-mysql` version `8.0.mysql_aurora.3.08.2`, with 3 members. No infrastructure changes, stored routine execution or live database writes were made.

| Endpoint                                                                    | Type       | Members                                  |
| --------------------------------------------------------------------------- | ---------- | ---------------------------------------- |
| `tss-live-rep-cluster.cluster-c8eicndimk7g.ap-south-1.rds.amazonaws.com`    | WRITER     | cluster-managed                          |
| `tss-live-rep-cluster.cluster-ro-c8eicndimk7g.ap-south-1.rds.amazonaws.com` | READER     | cluster-managed                          |
| `data-team-reader.cluster-custom-c8eicndimk7g.ap-south-1.rds.amazonaws.com` | CUSTOM ANY | static: data-team-reader                 |
| `reader.cluster-custom-c8eicndimk7g.ap-south-1.rds.amazonaws.com`           | CUSTOM ANY | excludes: tss-live-rep, data-team-reader |

The provided `data-team-reader-mysql.thesouledstore.com` connection exposes schema `tss`. This cluster is not yet confirmed as the operational POS writer. The visible writer and provided reader both reported the current `tss.pos_stock_syncer` unavailable with the supplied credentials. A source backup procedure self-commits and cannot be assumed safe for atomic inventory writes. Inventory writers remain gated until the actual deployed procedure and writer schema are verified.

`MYSQL_PRIMARY_READER_URL` serves active operational reads; `MYSQL_DATA_READER_URL` serves current-day reports. Historical report and export adapters require explicit BigQuery view contracts and freshness/parity acceptance. Authentication, authorization, financial proof and consistency checks use current writer state. The routing policy has no MySQL fallback for unavailable historical BigQuery contracts.

The supplied read-only BigQuery account can access project `tssgcp2025`, dataset `tss_mysql_raw_layer`, in `asia-south1`. SDK metadata inspection found 220 tables. Source coverage identifies 71 of 106 required tables and 35 missing tables; individual CDC watermarks do not establish one consistent publication across the required facts. The SDK parameter transport was separately verified with generated values. The customer-history raw queries exceed the unchanged 1 GB query guard and require the reviewed partitioned projections. The NPS raw query is within that guard, with bounded current dimensions and generated comparison evidence. These results establish the available connection and bounded contracts, not complete historical report acceptance. See `evidence/bigquery-schema.json`, `evidence/bigquery-source-coverage.json`, `evidence/bigquery-parameter-validation.json` and the customer-history/report module runbooks.

Google is the selected SSO provider, using authorization code with PKCE and issuer `https://accounts.google.com`. The provider reference has been inspected. The production OAuth client credentials and registered HTTPS callback still need configuration and live acceptance; provider selection itself is resolved.

The source uses `REDIS_HOST` / `REDIS_PORT`, database0, for `auth_qr_<operator_id>`; this is distinct from `COMMON_REDIS_HOST` / `COMMON_REDIS_PORT`. A connected shared Redis contract has not been accepted for the rewrite.

The visible `mobile_cms` authentication group tables belong to another application and are not a valid substitute for missing POS grant metadata. Rewrite group/direct-grant import requires a complete verified source snapshot.

Production Google client/callback acceptance, missing BigQuery projections and publication/freshness guarantees, operational POS writer/procedure acceptance, provider compatibility rollout, production bucket policy/KMS acceptance and desktop signing are external release prerequisites. See `evidence/aws-readers.json`, `evidence/mysql-schema.json`, `evidence/mysql-extra-schema.json` and the module parity documents for the bounded evidence.
