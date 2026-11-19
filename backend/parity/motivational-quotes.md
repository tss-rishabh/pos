# Customer-service thoughts

> **Removed, 20 November 2026 (user decision, W27 UI cleanup).** The motivational quote card (counter and dashboard) and its `GET /api/v1/motivational-quotes/random` route are deleted from the rewrite. This document is kept as the historical parity record of the legacy behaviour; nothing below describes current rewrite code. See `backend/parity/w27-ui-report.md`.


The pinned `core/views.py:970` randomly chooses one of the 83 exact strings in
`core/quotes.py`; the dashboard rotates it every seven seconds and the counter
loads it when opened. `/api/v1/motivational-quotes/random` keeps the authenticated
source pool, with static resource tracing and no database query. The React card
loads asynchronously, provides an explicit refresh control, renders plain text
and retains an already loaded thought when offline. Dashboard rotation pauses
while hidden or offline.

The source differential test executes the original Python handler against every
source choice. HTTP checks cover unauthenticated access, malformed query fields
and the resource event contract. Two production-build browser scenarios cover real authenticated backend
display/refresh, responsive typing during a delayed refresh, HTML escaping and
offline retention. The release gate accepts only the standalone
`core/urls.py:66` route certificate using
`evidence/quotes-route-01da4ea.json`; unrelated dashboard/cashier templates and
other workflows remain uncertified.
