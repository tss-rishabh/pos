# Source-origin recovery implementation

Pending final validation; no selectors are enabled and no live calls are made.

The current pending-credit readers in Node and Python release an original
BOUND command only for the independent Go FAILED attempt and its exact signed
`payment-outcome` pointer, `noConfirmation:true`, native status 17, and absence
of a positive confirmation seal. A timeout, unsigned phase, status alone,
authorization failure at status zero, or captured late payment retains credit.

`mpos-command.mjs` supplies a concrete browser/WebView caller after real
MPosLogin. Its metadata journal is separate from customer and legacy browser
journals. The real HttpOnly MPos session and original customer JWT remain
independent proofs. New Django grant/payment resources retain ordinary CSRF,
secure exact-origin POST checks, native actor/store/counter authority and
GET-first protected Go recovery. The GET grant resource only issues a CSRF
token and returns current actor metadata; it never creates a grant or payment.

Root's existing legacy URL bundle mounts `legacy_resources.urls()`. Package
`mpos-command.mjs` for the actual external MPos application to import, passing
its current scope and abort signal. No MPos client source checkout was present,
so this caller artifact does not establish an installed external application.

Legacy GET recovery rechecks current source scope before exposing completion.
A swallowed error in a completed original Django view is still reconciliation
required; it cannot be acknowledged as a successful order. No error body,
customer token, cart, money or contact details enter the recovery DTO/storage.
