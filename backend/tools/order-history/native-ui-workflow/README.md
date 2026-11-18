# Order discovery and authorized detail entry — authoring candidate

This is unfinished, unexecuted authoring on e58b207. No feature is admitted and no test/job/build/DB/cloud execution has occurred. The existing full r9 verifier does not include this independent supplement.

The proposed original scope is order/urls.py:8–12, preserving the actual class MRO, route binding, original POST serialization, native check-in, filter/template controls, authorized detail entry, five-day defaults and historical/mixed routing. The final proof must use the real built/routed App, native cookies, actual buildApp and physical native rows. No Principal/service/API response replacements are permitted.

The installed BigQuery SDK 9.6.1 officially supports BIGQUERY_EMULATOR_HOST in build/src/bigquery.js:185–202. The proof-only backend child may point that hook to an owned loopback proxy. A separate proxy child must have the emulator variable absent, use the explicitly authorized read-only key, and forward real SELECT-only jobs/results to HTTPS BigQuery. This avoids production testability changes and unsafe global interception. The private endpoint carries a random capability over IPC only; neither it nor credentials, headers, SQL, bodies, customer values or SDK errors may enter logs.

Current authored parts:

- fixture-sql.ts: strict native-owned manifest, exact pre-generated statement hashes and literal CTE construction. No dataset/table object is created.
- query-shapes.ts: allowlists actual production search SQL by static AST evaluation and invokes the original public-history SQL builders. It never learns allowed SQL from incoming requests or fabricates reader responses.
- proxy.ts: official SDK endpoint transport, fixed project/location, request limits, exact statement guards, byte/deadline gates, real Cloud dry-run SELECT classification, and real response forwarding. Only jobs created by this owned proxy may be polled. This code has not been typechecked or executed yet.
- source.py: owned native MySQL/Redis guards and real original AjaxOrderListView class/MRO/URL/POST dispatch, with genuine Django projected ORM relations and exact native Redis helper. GET/default form/detail/template assembly is explicitly not yet implemented; unassembled paths refuse execution rather than return synthetic success.

Still required: complete typed native row/generation builder, both publication families and all five-day completeness manifests from the same native rows; source GET/detail helpers and original rendered control assembly; actual production backend child/proxy orchestration; real App browser driver and receipt/cleanup harness. All statements, schemas, installed SDK bytes and production inputs must be bound before execution.

A genuine production gap was found while preparing this proof: current plain /orders defaults to today, while original OrdersView and OnlineOrdersView use a rolling five-day timestamp range (store end adds one minute; online does not). This was reported before business edits. The production correction is separately owned and must close before full validation; the harness must not bypass it with today-only navigation.

Actual query/parameter/shaping acceptance over synthetic CTEs does not certify a production historical publication, source/customer dataset rows, financial actions embedded in detail templates, shared producers, or the complete original application. Those limits must remain explicit even after the joined supplement passes.
