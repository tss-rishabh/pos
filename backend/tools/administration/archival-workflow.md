# Reversible store/operator archival workflow

This independent harness targets only `stores/urls.py:15`, `stores/urls.py:16`,
`users/urls.py:19` and `users/urls.py:20` at source commit
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. It does not certify all administration.

The source oracle executes complete pinned Store/PosUser model classes on real
Django QuerySets/MySQL, actual lifecycle class dispatch and permission decorators,
the original connection wrapper and selected URL declarations/mounts. Native
signed-cookie authentication uses Django's actual ModelBackend and current native
rows. Unrelated applications/templates/providers are omitted. Twelve deterministic
cases cover archive/reactivation, role restrictions, self-archive denial and
anonymous operator denial. Native financial rows and assignment rows must survive.

The replacement runs DEMO_MODE=false buildApp with real MySQL identities and signed
sessions. Playwright opens the built production App and uses its navigation, tabs,
filters and Archive/Activate controls. HTTP is forwarded to the real backend without
response substitution. A proxy discards exactly one already-committed operator
archive reply to check authoritative reload recovery without a second mutation.
The original cookie must remain revoked after reactivation. Separate native cases
exercise stale actor demotion and archived store check-in rejection. Store 1 stays
active while store 2 is archived so administrative navigation remains available.

Intentional boundary differences: source errors may use status=success despite
permission denial or redirect rather than 401/403. The comparison binds native
postconditions and policy outcomes, and expects explicit replacement denial codes.
The rewrite also hardens organizational/current-writer authority and permanently
revokes old authentication credentials; those are additional assertions, not claims
that the source implemented monotonic authentication epochs. Explicit status routes
have no operation receipt: lost-response recovery is an authoritative read of the
requested state. Generic destructive Django collector actions are excluded under
the user's approved archive/deleted-flag policy. No financial action is dispatched.

## Reproduction

Requires Node 24, the mitigated locked backend/frontend dependencies, Chromium,
`uv`, Python 3.12 and an owned disposable MySQL 8 endpoint. Never use a live DB or
the shared validation fixture on port 54777. The URL must have host 127.0.0.1, an
explicit private port and database name `pos_rewrite_archival_workflow`. The harness
creates/drops its own random schema using the existing source-verified physical
fixture builder; the URL's named database is an admission marker, not mutated.

From backend:

```sh
ARCHIVAL_WORKFLOW_MYSQL_URL="$PRIVATE_ARCHIVAL_MYSQL_URL" \
  sh tools/administration/archival-workflow-run.sh /absolute/backend-pos-web
```

The runner uses a private temporary Python dependency cache, checks strict types and
builds the frontend before executing. Output contains source hashes, exact route IDs
and named checks only. No credentials, cookies, source/native row contents, contacts,
request payloads or opaque identifiers are printed. This file is an authored proof
plan until execution passes; no release ledger or certification is advanced by it.
