# Cashier shortcuts

The pinned source bindings are in `order/templates/order/create_order.html:1024`
and `order/templates/order/tab.html:242`; the help table is
`order/templates/order/shortcuts.html`. The original keys R/P/F/N/E/B/S/T are
available in the counter and applicable sale-review controls. PP proceeds only
through the same currently eligible action; it does not bypass quote, consent,
approval, salesperson or payment checks.

The rewrite uses existing control handlers. F may load/quote the sale and focus
cash received; it never completes cash, takes a payment or retries a saved
financial operation. R reads current state without replaying an uncertain
command. N toggles the shopping feedback link; E uses the existing walk-in
membership action and stays disabled for a connected customer. S reveals/focuses
the current salesperson selection, B focuses barcode search, and T opens a new
local sale outside a modal. Input, contenteditable, IME, repeat, modifier and
unrelated-dialog events cannot invoke these actions. An accessible off switch
persists the device preference.

Member-benefit add/remove buttons are consolidated into one stateful toggle;
source membership metadata remains authoritative. Messages/membership sections
retain their expanded state across a versioned update. No customer identity,
amount or financial reference is stored by the keyboard controller.

Focused evidence: ten key/metadata boundary cases and three actual
production-build Chromium scenarios cover typing/off-switch persistence,
P/PP/F pricing without money dispatch, native control focus, N/E versioned
updates and no background new-sale action while a review is open. Broader
payment/recovery checks also pass together with the three shortcut scenarios:
ordinary/prepaid cash and lost note/order/payment responses retain their immutable
IDs and reviewed cart. This document does not certify the whole original cashier
workflow.

## Joined static-help proof

`tools/cashier-shortcuts/run-joined.sh /absolute/pinned/backend-pos-web` runs the
source help route and the production React help with no intercepted API
responses. It requires Node 24, `uv`, an existing Python 3.12 interpreter and
both projects' own `npm ci` installs. Set `SHORTCUT_ORACLE_PYTHON` to an explicit
existing interpreter if necessary. It creates/removes its own Python cache;
the source fixture pins Django 4.2.5, asgiref 3.7.2, sqlparse 0.4.4 and
WhiteNoise 6.12.0 from the actual source requirements. No shared dependencies,
source application, database, provider or writer is modified or started.

The oracle executes the exact committed `keyShortcutsView`, source connection
wrapper, both `/api/v1/orders/` and `/orders/` mounts, complete help/base/header
templates and source middleware list. Real Django signed-cookie and CSRF
middleware verifies anonymous/tampered-cookie redirects, authenticated GET/HEAD,
missing-CSRF rejection and method rejection after valid CSRF. Five synthetic
identities per mount use an in-memory identity adapter; deployed PosUser,
password/SSO login, database-session persistence and unrelated source routes
are outside this fixture. A dummy database engine prevents accidental queries.

The candidate is the actual production frontend build and full `buildApp`
behind a localhost-only forwarding/static fixture. It uses the actual sealed
session cookie and demo-mode synthetic identities/read data. Its seven checks
join the nine source help keys to the displayed table (P/PP share one row),
real B focus, T local-tab creation, R catalog-read refresh, ordinary typing,
modifier/repeat/IME/contenteditable/modal
pausing, persisted off preference, empty-cart action preconditions and tampered
session removal. There are zero Playwright interception handlers and zero
financial dispatches. All fixture servers/browser contexts close on completion.

The receipt `../evidence/cashier-shortcut-help-2848c69.json` records this exact
scope and current input hashes. It adds no release-ledger certification. The
subjects are `order/urls.py:57` and `order/templates/order/shortcuts.html`;
positive quoted-sale P/PP/F/N/E/S effects, identity-provider acceptance, payment
or offline settlement, and the full counter template remain separate proofs.
