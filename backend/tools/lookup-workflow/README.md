# Joined native lookup workflow runner

This runner proves the bounded country/postal workflows belonging to source
`core/urls.py:31` and `core/urls.py:167`. It does not certify the store CRUD
page, password/MFA login, physical reader separation or unrelated routes.

Use Node 24, Docker with the pinned MySQL 8.0.39 image already available, `uv`,
and independently installed backend/frontend locked dependencies. Chromium must
already be available to the frontend Playwright installation. The runner does
not install or modify project `node_modules` or a shared Python environment.

From the backend directory:

```sh
sh tools/lookup-workflow/run.sh
```

The default source checkout is the repository's sibling `backend-pos-web`.
An isolated worktree elsewhere can supply its location explicitly:

```sh
LOOKUP_WORKFLOW_SOURCE_ROOT=/absolute/path/backend-pos-web \
  sh tools/lookup-workflow/run.sh
```

`LOOKUP_WORKFLOW_RECEIPT=/absolute/new-file.json` optionally retains the
successful checksum-bound receipt. Existing files are refused. Without it,
the same safe JSON is printed to the verifier log. The runner publishes a
successful receipt only after the four browser tests and native fingerprint
check pass. No release ledger entry is changed.

Each run creates its own localhost-only MySQL container, random schema,
Python 3.12.15 environment and private `uv` cache. The Python packages are fully
version-pinned in `requirements.txt`; Django 4.2.5 is the immutable source
oracle's framework, not a production dependency recommendation. Cleanup removes
the created container and temporary environment. No supplied MySQL/BigQuery or
other live service credentials are used.

The source oracle verifies the original view, URL and model file hashes before
executing the exact `Country` model and both original Django view classes.
`as_view()` invokes the real `LoginRequiredMixin`; source ORM and raw postal SQL
read the same physical dataset as the candidate. It checks that anonymous
source requests redirect before business SQL runs. The async country URL
wrapper is verified as a source binding; this does not launch the full legacy
ASGI deployment or certify its authentication backend.

The candidate server is the production `buildApp`, not reimplemented handlers.
Fixture preparation creates real native `mysqlSessions` credentials; the browser
receives only the normal signed HttpOnly cookie. Requests execute the existing
session validation, identity loader, operator binding, origin checks, route
registration, input validation and ORM services. The frontend harness obtains
its principal from the actual current-session endpoint and renders the existing
country page or store editor. A local byte-forwarding HTTP proxy transports API
responses; no Playwright response interception, fixture JSON endpoint or fake
principal hook supplies lookup results.

The workflow observes eleven source business SELECTs, twelve native lookup rows,
ten country UI comparisons, ten valid role/type combinations, two postal UI
comparisons, and fifteen request refusals. Lookup rows retain the same final
SHA-256 fingerprint. Postal duplicates use the captured source indexes and
include IDs above JavaScript's safe integer range; the original first-row
selection, Unicode title casing and coordinate strings are compared directly.

Expected API design differences are explicit: source GET query parameters become
strict body-only POST resources; integer IDs become exact strings; postal keys
become camelCase and an absent postal row becomes `data: null`. Missing/empty
postal inputs are rejected rather than returning a source empty object, and
unauthenticated JSON requests receive 401 rather than a login-page redirect.
The rendered lookup facts are compared to the original source results. These
transport/validation mappings do not change tax, stock, payments or customer
data. They do not certify all possible inputs or production dataset contents.

Focused strict checks:

```sh
node node_modules/typescript/bin/tsc -p tools/lookup-workflow/backend.tsconfig.json
cd ../frontend
node node_modules/typescript/bin/tsc -p tests/lookup-workflow/tsconfig.json
```
