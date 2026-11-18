# Online order handoff to returns and exchanges

The reachable source online detail template includes return, exchange, retry and
manager date-extension controls (`order/online/_return_exchange_cells.html`).
The rewrite already has verified receiving-store return/exchange and date
extension workflows, but its detail entry did not retain the selected order.

`frontend/src/pages/returns/order-entry.ts` builds a reloadable URL containing
only operator, receiving store/counter, order ID and return/exchange selection.
The route wrapper validates the complete selection and refuses a different
workspace before mounting the workflow. IDs preserve signed-BIGINT precision;
duplicate, unexpected, incomplete and oversized fields are rejected. These
values select UI state and do not grant server authorization.

Opening a valid link preselects the order and mode. It does not send an OTP,
create customer proof or issue a mutation. The existing server-owned check-in,
customer proof, eligibility and financial guards remain authoritative. Existing
durable recovery takes priority over the linked selection and displays a notice
when the pending order or mode differs.

Fifteen focused parser/link cases pass, along with frontend strict checking and
changed-file ESLint in the owned corrections checkout. This does not prove the
complete online template or source-to-native-browser workflow. Detail links,
per-line eligibility, failed-exchange discovery and the remaining source action
bindings still require their own review and execution.
