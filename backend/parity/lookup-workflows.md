# Country and postal source-to-UI workflow evidence

The [runner](../tools/lookup-workflow/README.md) joins the original Django lookup
views, a shared synthetic native MySQL dataset, the actual authenticated
TypeScript application and the existing React lookup/store-editor components.
Its exact source scope is `core/urls.py:31` and `core/urls.py:167` at
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. No release ledger promotion is made.

The [bounded execution receipt](evidence/lookup-workflow/actual-workflow.json)
records the four passing workflows, exact original hashes, runtime versions,
native read/write counts, negative request checks and unchanged final lookup
rows. Current application source, test harness, schema evidence, auth migrations,
both package locks and inventory are checksum-bound. The runner generates its
receipt only after inspecting the successful Vitest JSON result and native
fingerprint. Source/candidate data comes from real queries, not intercepted
browser responses or an ORM double.

Covered behavior includes missing/empty/case/diacritic/literal-wildcard country
search, independent `sec_status` and normal `status` profiles, all five roles for
both valid user types, real signed native session validation and revocation,
strict transport/body validation, origin and operator binding, postal joins
and first indexed duplicate, Python title casing, exact coordinate strings,
no-match UI feedback, and preservation of existing city/address fields.

The source classes retain the real Django login mixin, but fixture users are
already authenticated; the candidate similarly seeds sessions through its real
native session service. This is not password/MFA/SSO certification. The source
GET-to-POST, JSON error/empty-result and DTO naming mappings are explicit in the
runner documentation. The full legacy ASGI middleware stack, complete store
administration workflow, deployed reader identities and production data are
outside this receipt. They retain their separate acceptance gates.
