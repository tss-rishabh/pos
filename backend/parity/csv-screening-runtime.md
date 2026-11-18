# Private CSV screening runtime selection

The production Node import factory now installs the existing screening profile,
and the private Python WSGI factory wraps its actual SourceRuntime with the
existing ScreeningSourceRuntime. Neither path selects screening by default.

Both processes require these explicit server values:

```text
POS_LEGACY_IMPORT_SCREENING_CONTRACT=pos-csv-screening-2960-v1
POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT=pos-screening-schema-v1
POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT=pos-screening-all-writers-v1
POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED=0
POS_SCREENING_COUNTER_CONTRACT=pos-screening-current-counter-v1
```

Set the line-mode value to exactly `0` or `1`, matching the actual source
`bool(settings.IS_LINE_ITEM_ENABLED)`. The source factory refuses disagreement.
Node passes that trusted boolean into reservations; the source admission and
Node receipt reader independently require the retained mode to agree. No request
body selects a profile or line mode.

The independent counter publication key and complete native-head configuration
are also required: isolated audit/origin/counter owners, explicit administrator
accounts, and declarations for every installed membership/coupon/publisher
participant. The publication key must differ from financial/source/capability
keys. Selection does not install tables, grants, functions, triggers or a seed.
The actual transaction still qualifies the full current head metadata, counter
writers, complete independent baseline, customer scope and existing reservations.
Missing coverage never becomes zero or a historical MySQL fallback.

An invalid selected Node configuration retains the adapter used to authenticate
committed financial receipts and blocks new financial work. An absent selection
keeps ordinary imports available while refusing ticket imports. The private
source factory refuses invalid selection before opening its writer connection.
The source keeps its existing current authority, owned RC transaction, exact
cart/calculation/profile checks, immutable receipts and once-only effect rules.

Scoped validation: production factory installation and both line modes, missing
contracts/counter/head options, retained adapter and unselected behavior passed
20 focused Node tests. Four Python tests exercise the actual selector and wrapper,
source-mode disagreement, default-disabled behavior and removal of only the
specific screening rejection. A focused TypeScript check passed in an isolated
Root f5d3e56 snapshot with these changes. Source manifest generation succeeded
against an immutable API2960 archive; screening_runtime.py is explicitly hashed
under privateRuntime.files. No live database, provider or deployment was used.

These checks establish configuration and composition boundaries. Existing native
profile/counter tests remain separate evidence. Shared writer cutover, approved
schema/function/definer installation, complete historical publications, actual
source/broker/provider acceptance and release gates remain required; this document
adds no workflow or production certification.
