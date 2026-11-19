# Current-inventory workbook (deleted)

The rewrite-only current-inventory XLSX workbook export (`src/modules/inventory-workbooks`, export kind
`current-inventory-workbook`, `tools/inventory-workbooks`, their tests and goldens) is deleted by the user
decision of 19 November 2026 (AGENTS.md, "Background jobs"). Legacy reaches its inventory export only through a
commented-out URL (`report/urls.py:26`), so its Celery family R1–R5 (`report/tasks.py`) is dormant
(phase-c-legacy-jobs.md §2.5). `inventory-workbooks-query-improvements.md`, `inventory-workbooks-query-plans.json`
and `inventory-workbooks-source.json` are historical evidence only.
