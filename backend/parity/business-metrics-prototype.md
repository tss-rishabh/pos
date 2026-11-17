# Business-metrics upload reachability

At source `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, the two BD metric
templates belong to a commented prototype. They remain individually recorded
in the complete template inventory; no working source uploader or report
endpoint is removed from the rewrite.

- `report/views.py:1350–1424`: the whole `DailyRetailMetricsReport` class,
  including its upload and render handlers, is commented Python text.
- `report/datatables/bd_report.py:16`: `AjaxDailyRetailMetricsReport` and its
  implementation are also commented text, without a class in the Python AST.
- `report/urls.py:57–58`: both named routes are commented and absent from the
  complete route inventory and executable URL syntax.
- `users/templates/admin/includes/sidebar.html:694–731`: the sole sidebar
  reverse link is inside a Django `{% comment %}` block. An HTML comment alone
  would not suppress Django URL resolution; this is the Django block itself.
- The preview template reverses the unregistered
  `ajax_daily_retail_metrics_report` name. The source exposes no callable
  upload/preview workflow through these templates.

`tools/parity/check_business_metrics_reachability.py` reads the pinned files
through `git show`, checks syntax without importing source settings/application,
verifies inactive routes and navigation, and retains both template hashes. Its
regression fails if a class, route, render reference or sidebar entry becomes
active at a new baseline. It performs no provider request or database operation.

This is an explicit inactive-source disposition, not a working replacement UI
or an original-template certification. The two templates remain marked
unverified in the release inventory. Current DSR footfall/target inputs retain
their independent implemented reader contracts. A new writable upload product
would need a defined source, authority and data contract; none is inferred from
this disabled prototype.
