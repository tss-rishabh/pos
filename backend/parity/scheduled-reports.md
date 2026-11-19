# Scheduled Slack reports (§2.8)

Legacy `backend-pos-web@78d5b63`: seven views called by an external scheduler run synchronously in the HTTP
request, authenticated by the `apikey` header (`REPORTS_API_KEY`, `helpers/helpers.py:1713-1717`), and post Slack
inline (`report/views.py:810-1876`, URLs `report/urls.py:40-45,84`). The caller and schedule are unknown
(phase-c-legacy-jobs.md §2.8). User decision (19 Nov 2026): scheduled Slack reports run inline.

Current code: `src/modules/operational-reports/{scheduled-routes,scheduled-data,scheduled-domain,scheduled-options,slack}.ts`.

- `POST /api/v1/report-deliveries` (service authentication by the `apikey` header) builds the report for the
  requested kind and day and posts it to Slack within the request. It answers the legacy outcomes `Data Sent`,
  `Data Updated In DB` (CRM tickets) or `Data Not Found`.
- Deleted (rewrite-only): the scheduled-report loop and worker, the delivery ledger and reconciliation routes,
  and the tables `pos_rewrite_scheduled_reports`, `_targets` and `_channels`.

## Deliberate differences (security)

- The `apikey` header is compared in constant time and is accepted only as a header. A wrong key gets
  401 `SERVICE_AUTHENTICATION_REQUIRED`; legacy answers 200 `{"status":"failed","message":"wrong api key"}`.
- Slack calls go only to HTTPS `hooks.slack.com` webhooks, without redirects or unfurls, with escaped store names.

## Configuration

`REPORTS_API_KEY`, `SLACK_URL`, `SLACK_DEMO_URL`, `DAYS_BEFORE_FOR_MIN_MAX`, `FRESHDESK_TICKET_URL` with
`FRESHDESK_BASIC_AUTH_*`, `SCHEDULED_REPORT_MAX_CRM_TICKETS` and the `BQ_HYPERLOCAL_*_VIEW` warehouse views
(`scheduled-options.ts`).

## Evidence and limits

`tests/operational-reports/scheduled-data.mysql.integration.test.ts` and the route tests use fake Slack and
Freshdesk adapters. Real Slack, Freshdesk and the external scheduler are not exercised.
