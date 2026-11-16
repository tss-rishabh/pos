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
