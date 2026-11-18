# Joined administration create/update workflows

This disposable target compares four declarations at pinned source commit
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`: `users/urls.py:17,18`
and `stores/urls.py:11,14`. Country and postal routes are dependencies, not
additional form-route certification.

`source.py` loads the complete selected source model/form/view/decorator bodies
and original child templates over the same physical synthetic fixtures used by
the candidate. It uses genuine Django authenticated sessions and CSRF POSTs.
Only unrelated base-layout chrome and unexercised redirect destinations are
excluded. Source debug output is suppressed before any credential can escape.

The candidate runs actual `buildApp` registration, native sessions, authenticated
HTTP routes and the actual built routed React application. The UI server proxies
bytes to that App; it never fulfills API responses. Each source/candidate pair
starts from the same reset fixture, compares all selected physical business
columns and checks rejected writes remain unchanged. Generated password hashes
are independently verified rather than compared by salt. Volatile timestamps
are excluded explicitly. A final receipt records source hashes, all input hashes,
actual cases and declared exceptions; it refuses overwrite.

Run from an isolated checkout with private mitigated backend/frontend dependencies,
Node24, a copied Python3.12.15 environment matching `requirements.txt`, cached
pinned MySQL8.0.39 image, and Chromium available:

```sh
FORMS_WORKFLOW_PYTHON=/absolute/private/python/bin/python \
FORMS_WORKFLOW_RECEIPT=/absolute/private/fresh-receipt.json \
FORMS_WORKFLOW_CLEANUP_RECEIPT=/absolute/private/fresh-cleanup.json \
sh backend/tools/administration/forms-workflow/run.sh /absolute/pinned/backend-pos-web
```

Without an explicit Python path, the runner creates its own environment/cache.
Use explicit external fresh receipt paths for durable evidence: its private
working directory is removed at exit. The runner checks strict types and builds
the actual frontend before provisioning a unique loopback MySQL container capped
at two CPUs, 1GiB memory and a 512MiB temporary database. Cleanup removes only the
exact created, ownership-labelled container with volumes and verifies absence.
No production database or provider configuration is inherited.

`FORMS_WORKFLOW_DIAGNOSTIC_CASE=<exact-case-id>` runs exactly one known case and
marks its receipt diagnostic-only. Failures export allowlisted field names,
types and synthetic numeric identifiers, never raw business rows or secrets.
Do not replace complete-suite evidence with this mode.

The cases include authorized roles/ownership, configured default assignments,
MUser mirror persistence, counters, country/postal resolution, franchise details,
store types, no-op edits, refusal and session invalidation. Source role-two empty
role options, separate password-change restrictions and instructed stored-city
preservation are explicit observations/exceptions. Creator races have separate
native security evidence; this target does not independently certify those
concurrency barriers. OTP/provider acceptance and unrelated global chrome are
outside this target. No release ledger is promoted automatically.
