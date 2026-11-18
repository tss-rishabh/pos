# Native membership revision fences through readonly metadata

The application can no longer discover the four revision fences directly from
`INFORMATION_SCHEMA.TRIGGERS`: MySQL hides them when the caller has no `TRIGGER`
permission. The existing two fixed readonly metadata functions now expose a
seventeenth closed section, `membershipRevisionTriggers`. This is separate from
the seven delivered-order membership-history triggers.

The four entries use the unnormalized `ACTION_STATEMENT` SHA-256 values from
`pending-cancellation/membership-fence.sql` and its existing generated contract:

| Name                         | Table      | Event        |
| ---------------------------- | ---------- | ------------ |
| `pos_rewrite_mem_eav_insert` | `user_eav` | AFTER INSERT |
| `pos_rewrite_mem_eav_update` | `user_eav` | AFTER UPDATE |
| `pos_rewrite_mem_eav_delete` | `user_eav` | AFTER DELETE |
| `pos_rewrite_mem_user_email` | `users`    | AFTER UPDATE |

`POS_MEMBERSHIP_REVISION_TRIGGER_DEFINER` / Node `membershipRevisionDefiner` must
name a separate locked account with no roles or proxies. Its complete allowed
and required rights are:

- `SELECT, TRIGGER` on `users` and `user_eav`;
- column-scoped `UPDATE(id)` on `users`;
- `SELECT, INSERT, UPDATE` on `pos_rewrite_membership_versions`;
- implicit global `USAGE`, with no additional executable objects or grants.

The column right is necessary on pinned MySQL 8.0.39 for the original trigger's
`SELECT ... FOR UPDATE`. A disposable native probe demonstrated that `SELECT`
alone fails with 1142 and `UPDATE(id)` succeeds. Table-wide `UPDATE users`,
`UPDATE(email)`, other column rights, `DELETE`, `EXECUTE`, grant option and roles
are refused. No application `TRIGGER` or global `LOCK TABLES` grant is introduced,
and the source locking query remains unchanged.

Every `privileges` item now has eight exact fields:
`grantee, scope, schema, table, column, privilege, grantable, target`. `column` is
the actual column name for column scope and exactly empty for other scopes.
Keeping the native table and column separate prevents a grant on another column
from masquerading as the one required locking right.

Node, Python and Go validate the same current owners, objects, raw hashes, strict
SQL mode, complete grants, bounded arrays and two function identities. They pin
`users`, `user_eav` and the version table before reading metadata, retain native
metadata locks until the caller ends its transaction and refuse temporary-table
shadows. The version table remains ordinary native concurrency state: legitimate
activation/restoration application increments are retained. It is not added to
the protected history-head set.

The section is always present on the wire. An empty array is accepted only by
profiles that do not require these fences when no revision owner or fences are
installed. Membership consumers must still require all four exact entries. A
partial family, installed but undeclared family, old sixteen-section function,
root-owned trigger or unknown object cannot qualify.

The generic Go `readNativeHeadMetadata(ctx, tx, requireRC)` now lives in the base
`go/internal/poscheckout` package, with a generated identical legacy review copy.
It has no counter-only regex, hashing or SQL dependencies. `requireRC=true`
retains actual native READ COMMITTED qualification for screening; `false` accepts
the ordinary caller's actual active RR or RC transaction. Session isolation
variables cannot substitute for the instrumented transaction proof. The legacy
overlay must not redeclare the base helper or descriptor.

The Node environment factory and background source-capture child propagate the
new owner. The generated source `pos_screening_origins` entry exports
`qualified_head_metadata` through its existing explicit helper-root resolution,
so ordinary producer adapters need no ambient import-order dependency.

Deployment still requires reviewed installation of the locked account, exact
fences and updated fixed metadata function. The new function/qualifier and
participant hashes invalidate old captures; independently recapture and
requalify publications before selecting them. No automatic legacy DDL, grant
changes, permission bypass or compatibility fallback is installed by this code.
Root-owned source bundle/manifests must include the existing helper dependencies
and regenerated base Go files.

The new disposable MySQL checks exercise actual application authority with zero
visible trigger rows: exact four-fence qualification, original EAV increments,
explicit version increments and rollback, missing/extra locking rights,
application TRIGGER refusal, role edges, altered/missing/non-strict/root fences,
locked-owner enforcement, old function refusal and table MDL through commit.
These checks prove the local contract; deployed account/function acceptance and
full source workflow qualification remain separate.
