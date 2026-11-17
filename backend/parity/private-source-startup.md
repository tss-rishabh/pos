# Private source database/session bootstrap

The original2960 artifact has `database.database` and `database.WriteDbConn`; it has no `database.ReadDbConn`. The old private SourceRuntime imported that missing module. It also imported original credential-bearing SQL engine/session construction before replacing selected aliases. This could not qualify the dedicated private factory's startup boundary.

`bind_source_sessions` now verifies and executes the three actual pinned database definitions, including package `make_sessions`. Only their SQLAlchemy engine/session constructor calls are substituted. Constructor arguments are removed too, so original SQL credential/URI expressions are not evaluated. An original engine alias cannot connect or create an independent pool. Unqualified preloaded database modules are refused because replacing their exports would not repair aliases already captured by controllers.

All actual SQL aliases—`Session`, `SessionR`, `SessionC`, `SessionReadCMS` and WriteDbConn `Session`—use the existing private transaction proxy. Factory calls outside the owned frame fail closed. Inside it they resolve to the same supplied writer Session; no replica or original database session can escape. SQL/business constructors, query bodies, membership, price/date decisions and source settings are unchanged. The existing owned transaction/commit guards remain mandatory.

All eight actual Redis client exports are wrapped using the existing `ReadOnlyCache`, including previously omitted `payment_redis_object`, `redis_buffer_object` and `blacklist_redis_object`. Allowed read methods retain source behavior. Raw writes, scripts, command dispatch, transactions and pipelines cannot mutate a cache, including if a later source profile rejects. Membership's independently journaled post-commit invalidation remains separate.

The database definition pins are:

| Source file | SHA256 |
| --- | --- |
| database/__init__.py | 9b066628cd3e7e28e9337f9daa883b3e8d763292be2d47b1d8b869d06cd03fe3 |
| database/database.py | 328a8519f8a7d37f2374e57ead0ea7dbe074ef6a056f981ca51befb2ba9348f0 |
| database/WriteDbConn.py | e5da9b24e91a4eaf202d73a4c069b796b4e387eedeae1cab057497a7ca4625d1 |

The compatibility manifest retains the updated source_runtime hash. No source repository, database, provider, migration or app route changes. No new constructor/config/queue hook is required. Root should register the scoped check:

```sh
POS_LEGACY_IMPORT_SOURCE_ROOT='<immutable2960-source-archive>' \
  compatibility/upstream/offline-cash-pricing/.venv/bin/python -B \
  compatibility/upstream/legacy-order-imports/test_source_sessions.py -v
```

Five startup checks and the nine existing protocol/privacy checks pass. They execute the actual pinned database definitions, forbid original SQL engine/factory/credential construction, verify all five aliases in/out of the private frame, reject preimported/changed modules, and execute the real SourceRuntime constructor's import flow with inert controller/model/provider dependencies. Every Redis export preserves a read while denying write/script/pipeline/transaction dispatch. No main module or live provider/database is invoked.

This qualifies the import/session boundary, not the entire production factory or source runtime. Actual source dependencies/settings, Redis/broker/TLS behavior, current schema and full private cart/order sandbox acceptance remain required. Public all-writer transaction assembly is separate code work and no profile is enabled by this change.
