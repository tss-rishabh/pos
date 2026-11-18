# Express single-store search validation

Original `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, `order/templates/order/index.html:375–390`, prevents non-queue HE form submission unless exactly one store is selected, including searches by explicit order IDs. The rewrite omitted this form constraint and could silently use the first supplied store.

The client now refuses that submission and the typed API returns 400 for a non-queue HE request with zero or multiple distinct stores. Queue requests still resolve to HL and retain their existing store/check-in authority. This API rejection is deliberate input hardening of the broader original raw datatable method; it preserves the reachable source form's behavior.

Focused source-derived tests execute the literal pinned submit handler with a named form-control carrier for zero/one/two stores and explicit IDs. The React request-contract browser adds rejection/no-request cases, valid single-store submissions and the unchanged queue case. These component tests retain their existing response seam; they are not native feature admission. The prior native source-bypass case now supplies the valid single-store form context while preserving both original bypass rows and candidate ownership denial assertions.

Checks on the authored combined worktree: source validation 4 and existing default-range 10 tests passed; component browser 22 groups passed; the one affected prior native bypass case passed. The new online-detail feature in the same worktree remains a separate change and is not certified by these counts. Detail links must bind to the applied HE store rather than a different selected workspace; that binding is part of the separate detail feature.
