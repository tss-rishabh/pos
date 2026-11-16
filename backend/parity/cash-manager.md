# Offline cash manager screen

`frontend/src/pages/checkout/offline-cash/manager.tsx` exports
`CashManagerDialog({ user, storeId, online, onClose })`. Checkout's CashTools owns
the Counter entry point. This is an extension for the explicitly requested
offline cash workflow, rather than a claim that the legacy application supported
this receipt protocol.

The screen supports the following behavior:

- Server receipt lists use the existing strict HTTP contracts, four statuses,
  25-row cursor pagination, current captured operator headers, and explicit
  detail refresh. Receipt and order identifiers remain strings.
- Local handoff reads the saved store index only after a current, unexpired
  cached manager session matches operator, role, user type and the complete
  assigned-store scope. Internal role 1 has the existing global exception;
  franchise role 1 remains assignment scoped. Roles 1–4 can hand off another
  operator's receipt after that operator logs out. A role/scope change, logout,
  expiry or actor switch hides the workspace and aborts continuations.
- The local view verifies the original Ed25519 device signature, ownership,
  store/counter identity and receipt metadata. Unreadable evidence remains on
  the device and is counted explicitly; it is not deleted or relabeled paid.
  Handoff delegates to the shared claim/lease replay implementation, preserving
  the original operator, signed envelope and exact received cash.
- A manager review adds an audited, versioned note. It does not resolve a
  conflict, change cash or create an order. Import approval is separately bound
  to the exact receipt version and approving manager. Invalid device clocks
  require an explicit valid second inside the original authorization window,
  expressed in the server-supplied business time zone.
- Review, approval and import use stable operation UUIDs and original expected
  versions across uncertain responses. The local marker stores a hash and opaque
  identifiers, never the manager note or receipt payload. Audit metadata confirms
  a lost review/approval acknowledgment. An explicit import retry reuses its
  original approval and command identity; there is no automatic order retry.
- Confirmed actions reconcile an existing local receipt through the shared
  GET-only signature/scope/money/version verifier. The screen requires both
  `orderId` and proof-backed `importedAt` before presenting an imported order.
  It never fabricates a local receipt or changes its original ownership.
- Original cash printing reuses `CashReceiptDialog`. Authoritative invoices
  remain an online action for a proof-backed imported order.

All mutations remain subject to the backend's current checked-in manager,
version, source-template, stock projection, schema and immutable import-proof
checks. A UI approval alone does not bypass those gates. The screen does not
implement a receipt deletion, cash rewrite, offline refund or cash-out action.

## Verification

`frontend/tests/checkout-manager/manager.test.ts` has eight real IndexedDB and
WebCrypto checks covering RBAC, stale cached sessions, other-owner handoff,
signature/ownership anomalies, 25-row pagination, cancellation and clock bounds.
The strict test configuration is `frontend/tests/checkout-manager/tsconfig.json`.

`frontend/tests/checkout-manager/browser-check.mjs` runs against an isolated Vite
development server on port 4490. It uses real device keys/signatures and mocked
HTTP transport. Ten workflows cover pagination/statuses, saved receipt display,
manager handoff, a committed review with a lost acknowledgment, unchanged cash
and conflicts after approval, an uncertain import with the exact explicit retry,
proof-bearing local reconciliation, expired/changed scope, actor switching and
offline controls. The fixture blocks external requests and asserts current actor
headers. Evidence is in `parity/evidence/checkout-manager/`.

These browser fixtures do not certify a deployed provider, production session,
live stock routine or deployed warehouse. Native atomic importer and sealed
finance/report evidence are recorded separately by their owning suites.

Run from `frontend/` with the project's Node 24 LTS version:

```sh
npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/checkout-manager/manager.test.ts tests/offline-cash.test.ts
npx -y node@24.22.3 node_modules/typescript/bin/tsc --noEmit -p tests/checkout-manager/tsconfig.json
npx -y node@24.22.3 node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4490 --strictPort
# In another shell:
npx -y node@24.22.3 tests/checkout-manager/browser-check.mjs
```

The harness honors `PLAYWRIGHT_CHROMIUM_EXECUTABLE`; a macOS Chrome fallback is
used only when present on macOS, otherwise bundled Playwright Chromium is used.
