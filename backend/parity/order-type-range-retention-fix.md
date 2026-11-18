# Preserve the active source form window across order types

The pinned original `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` has one reachable store-page placement window. `users/templates/admin/includes/sidebar.html:341` links `orders_store`. `order/templates/order/index.html:66` guards the filter/table controls to `/orders/store/`; its N/ST/HE radios at 157–174 change type without changing dates. The real `OrdersView.post` (views.py:143–228) retains submitted `order_date_range`; the rendered inline DataTable request at index.html:424 sends that exact range. Thus the initial store-page +1 ending minute remains when switching to N. HL is selected by queue controls and also retains form state until the queue intentionally ignores placement.

`OnlineOrdersView.get` computes unused time strings, but its context explicitly sends an empty range and HL (views.py:254–268). The shared template's store-path guards suppress its list controls and initial DataTable request. Its `#btn-online-orders` handler has no corresponding element/menu link in the inspected active templates. Arithmetic from that unused prefix must not determine the active form's N controls.

The correction removes type-triggered placement resets and unused online metadata. The sole `defaults.store` field describes the store-page window for every selectable type. Explicit or operator-edited bounds remain unchanged. N now accepts the same tightly bounded original future-midnight endpoint as other types; all cap, date agreement, span, report, scope and authority checks remain. Ordinary historical/common-checkpoint routing and bounded native supplementary reads are unchanged.

## Focused execution after the correction

Own fix worktree, Node 24.22.3, mitigated dependency copies, pinned source, private Django environment, explicitly owned loopback MySQL/Redis fixtures. No live MySQL/provider writes, cloud queries or customer data.

- Backend/frontend main strict TypeScript and changed ESLint: passed.
- `backend/tests/order-search/default-ranges.test.ts`: 10 passed, active original store helper/view prefix across midnight/year/leap-day/DST; all types share the same admitted future plan and tampered/report/date/span inputs remain denied.
- `backend/tests/order-search/default-range.mysql.test.ts`: 4 passed. Original `OrdersView` inherited MRO GET and POST execute over actual native ORM and real Redis check-in. The original feature template is rendered for N→ST→HE→N POSTs, proving the input and inline AJAX placement literal remain identical. Original Django datatable query/native N comparison includes the exact midnight row; +1 second, non-global N and report/future tampering remain rejected. Previous duplicate-association and authorized-detail boundary cases remain intact.
- `frontend/tests/order-history/client.test.ts`: 3 passed.
- Existing `frontend/tests/order-search/browser-check.mjs`: 17 assertion groups passed. Five added groups exercise actual React type controls across N/HE/HL/ST, submit exact retained midnight bounds, and retain an edited start after a further N switch. This is explicitly a component/request-contract test with its pre-existing response seam, not full native-App N acceptance.
- Production Vite build and real routed-App/real demo-cookie/backend HTTP `e2e/order-default-ranges.spec.ts`: 2 passed (8.0 seconds), including explicit detail GET bounds. No response interception in these App cases; demo exposes ST only.

The source-form harness uses an explicit shared-shell/URL-reversing carrier and native established identity before actual LoginRequiredMixin/View dispatch. It does not claim global ASGI/identity-provider, complete detail financial actions, or browser execution of every original third-party plugin. The old datatable oracle used in native row comparison retains its previously documented method-boundary limits. Full App→warehouse N joining remains the separate unfinished order-discovery proof.

This follow-up was **not** executed by the frozen caba871 r9 run. Its results and original receipts must not be relabeled as validation of this later source graph.

Retained logs: `/tmp/pos-order-type-native-20261118.log`, `/tmp/pos-order-type-component-20261118.log`, `/tmp/pos-order-type-build-20261118.log`, `/tmp/pos-order-type-app-20261118.log`.

To run the additional source form case, supply `ORDER_DEFAULT_FORM_REDIS_URL=redis://127.0.0.1:<owned-port>` alongside the existing native-test MySQL/Python/source variables from the prior fix record. The test uses only the explicitly seeded `check_in_9` key on that disposable broker and removes it afterward. The helper and API/browser fixtures have no production configuration switch.
