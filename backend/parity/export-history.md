# Export history

The export history page lists `report_exports` through `GET /api/v1/report-exports` and
`POST /api/v1/report-exports/search`, and downloads through `GET /api/v1/report-exports/:exportId/file`.
The rows are written by the E1–E6 jobs (`report-exports.md`). The rewrite-only BigQuery historical archive,
legacy-file streaming route and administration list exports are deleted (W8).

Visibility differs from legacy on purpose: internal superadmins see every row and everyone else only their
own (legacy `report/datatables/export_datatable.py:33` lists every row to every user). See
`report-exports.md` for the download rules and messages.
