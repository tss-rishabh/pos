# Phase D — legacy checkout (create-order) control inventory and rewrite gap spec

Status: **read-only gap specification**. It is not parity certification and must not be used to open the release gate.

- **Legacy source:** pinned `backend-pos-web@78d5b63`. The audit used only the read-only export of that commit, never the developer checkout at a different commit.
- **Rewrite:** worktree `pos-rewrite-single-stack`, branch `refactor/single-stack-schema-freeze`.
  - Part A and Part C rewrite citations are anchored at `324d62d` (the W2 merge that removed screening, CSV import, cash-return intents, SSO and the Python/Go/PHP oracles).
  - Part B was read at `3a3acc9` plus other agents' uncommitted edits.
  - `CheckoutReview.tsx` was being edited while this was written, so its line numbers can be off by up to about 40 lines. Re-anchor citations before editing code.
- **Scope:**
  - `order/templates/order/create_order.html` (8450 lines). It has no `{% include %}`.
  - Its layout chain: `users/templates/admin/layouts/base_create_order.html`, `admin/includes/header.html` and `static/js/main.js`.
  - The `key-shortcuts` page (`order/templates/order/shortcuts.html`).
  - `CreateOrderView` (`order/views.py:1516-1691`) and every AJAX endpoint the page calls (`order`, `users` and `core` views).
- **Excluded:** screening, cash-return intents, CSV order import, Google/desktop SSO and demo mode. These features are being deleted and are never counted as gaps.
- **Flags:** the conditions come from `backend/parity/legacy-flags.md`. A repository-wide search of `backend/src` and `frontend/src` at `324d62d` finds none of these settings: `GLOBAL_SHOW_COUPON_MODULE`, `GLOBAL_SHOW_PG_DISCOUNT_MODULE`, `ENABLE_OLD_PG_DISCOUNT`, `ENABLE_NEW_PG_DISCOUNT`, `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT`, `EXCHANGE_ENABLED_STORE_IDS`.

## Status vocabulary

| Status | Meaning |
|---|---|
| DONE | A runtime-connected rewrite counterpart exists and no behavioural difference was found at the depth read. |
| PARTIAL | A counterpart exists but is missing branches, is gated by a disabled adapter, or lacks messages or states. |
| MISSING | No counterpart exists. |
| DIFFERENT | A counterpart exists but behaves differently from legacy, for example a stricter gate, different defaults, a different flow or different wording. |
| UNKNOWN | Not determinable from the source that was read. |
| N/A | Not applicable. |

Severity in the gap lists:
- **P0:** money or order correctness, or blocks billing.
- **P1:** visible behaviour missing or changed.
- **P2:** cosmetic or wording.

## Counts

| Part | Rows | DONE | PARTIAL | MISSING | DIFFERENT | UNKNOWN | N/A |
|---|---|---|---|---|---|---|---|
| A — markup `create_order.html:1-900`, `CreateOrderView` context, shortcuts K-01…K-11 | 140 | 50 | 28 | 7 | 45 | 3 | 7 |
| B — inline JS `:901-4060` and endpoints (B-01…B-55) | 55 | 12 | 12 | 4 | 25 | 2 | 0 |
| C — inline JS `:4060-8450` and endpoints (C-01…C-74) | 74 | 33 | 18 | 7 | 16 | 0 | 0 |
| **Total** | **269** | **95** | **58** | **18** | **86** | **5** | **7** |

Each part defines its own path abbreviations in its opening lines, for example `CO`/`F` = `create_order.html`, `V` = `order/views.py`, `CR` = `frontend/src/pages/checkout/CheckoutReview.tsx`.

## Where each mandated verification is answered

| Required check | Section |
|---|---|
| `create_order.html` ~165–174 (cart and complimentary rows) | Part A › Mandatory verification 1 |
| `create_order.html` 450–547 quote/summary vs `CartQuoteSummary.tsx` | Part A › Mandatory verification 2 (row-by-row table) |
| `create_order.html` ~1601 / ~2175 freebie rows and ~2583 Remove (`ajax-cart opr=delete`) | Part B › Complimentary (freebie) rows and Remove |
| Cashback eligibility gating | Part A › Mandatory verification 3 |
| Coupon | Part C › Coupon apply/remove; Part A › Mandatory verification 4 (flag gating) |
| PG discount, old and new, including manager OTP | Part C › PG discount OLD and NEW; Part A › Mandatory verification 4 |
| Voucher to money | Part B › Gift voucher apply/remove and voucher-to-money check & convert |
| Wallet (TSS Money) and reward points | Part B › Wallet: TSS Money and reward Points |
| Payment-mode controls | Part C › Payment-mode controls |
| Payment status polling and `AjaxPaymentStatusView` | Part C › Payment status polling flow. `AjaxPaymentStatusView` (`order/views.py:685`) has no caller anywhere in the pinned repository; only its URL registration (`order/urls.py:40`) exists. Callers in other services are UNKNOWN. |
| Keyboard shortcuts | Part A › Mandatory verification 5; Part C › Keyboard shortcuts |

## Architecture note

Legacy renders one page per store, counter and tab. The cart is held in API-v2 from the first scan, and every benefit, customer and payment control lives on that page.

The rewrite splits this in two:
- **Local draft counter** (`frontend/src/pages/counter.tsx`): offline-capable, with no customer and no benefits.
- **Online review modal** (`frontend/src/pages/checkout/CheckoutReview.tsx`): imports the draft into an API-v2 checkout session, and hosts the customer, benefit, discount and payment controls.

The rows compare behaviour, not layout. A control that exists only in the review modal is not a gap on that basis alone.

---

## Part A — Create-order markup, CreateOrderView context, keyboard shortcuts

Scope: legacy `create_order.html:1–900` (CSS + `maincontent` markup), its layout chain
(`base_create_order.html`, `admin/includes/header.html`, `static/js/main.js`), `CreateOrderView`
(`order/views.py:1516–1691`) and the Mousetrap/`key-shortcuts` inventory. JS handlers beyond line 900
belong to agents B/C; they are named here only (handler line) and not analysed.

Legacy pin: `78d5b63`. Rewrite: worktree `pos-rewrite-single-stack`, HEAD `324d62d` (re-anchored after
the W2 merge landed mid-review; all rewrite line numbers below are against `324d62d`).

Status counts (context table + controls A-00…A-94 + shortcuts K-01…K-11; verification
sub-tables not double-counted): DONE 50 · PARTIAL 28 · DIFFERENT 45 · MISSING 7 · UNKNOWN 3 · N/A 7.

### Path legend

| Abbrev | Path |
|---|---|
| `CO` | `L/order/templates/order/create_order.html` |
| `V` | `L/order/views.py` |
| `S` | `L/POSAdmin/settings.py` |
| `H` | `L/helpers/helpers.py` |
| `BCO` | `L/users/templates/admin/layouts/base_create_order.html` |
| `HDR` | `L/users/templates/admin/includes/header.html` |
| `MJS` | `L/static/js/main.js` |
| `SC` | `L/order/templates/order/shortcuts.html` |
| `TAB` | `L/order/templates/order/tab.html` |
| `CR` | `R/frontend/src/pages/checkout/CheckoutReview.tsx` |
| `CQS` | `R/frontend/src/pages/checkout/CartQuoteSummary.tsx` |
| `QS` | `R/frontend/src/pages/checkout/quote-summary.ts` |
| `CCL` | `R/frontend/src/pages/checkout/CheckoutCartLines.tsx` |
| `SPA` | `R/frontend/src/pages/checkout/SalespersonAssignments.tsx` |
| `GCI` | `R/frontend/src/pages/checkout/GiftCardItems.tsx` |
| `CREG` | `R/frontend/src/pages/checkout/CustomerRegistration.tsx` |
| `FC` | `R/frontend/src/pages/checkout/FastCashCheckout.tsx` |
| `CNT` | `R/frontend/src/pages/counter.tsx` |
| `BEN` | `R/frontend/src/pages/customer-insights/benefits.tsx` |
| `PRO` | `R/frontend/src/pages/customer-insights/profile.tsx` |
| `EDT` | `R/frontend/src/pages/customer-insights/editor.tsx` |
| `HIS` | `R/frontend/src/pages/customer-insights/history.tsx` |
| `INS` | `R/frontend/src/pages/customer-insights/insights.tsx` |
| `GVC` | `R/frontend/src/pages/global-vouchers/conversion.tsx` |
| `WEB` | `R/frontend/src/pages/customer-website-handoff/index.tsx` |
| `OCP` | `R/frontend/src/pages/order-copy/index.tsx` |
| `KS` | `R/frontend/src/pages/cashier-shortcuts/shortcuts.ts` |
| `KH` | `R/frontend/src/pages/cashier-shortcuts/help.tsx` |
| `APP` | `R/frontend/src/app.tsx` |
| `SVC` | `R/backend/src/modules/checkout/service.ts` |
| `QD` | `R/backend/src/domain/checkout-quote-display.ts` |
| `CFG` | `R/backend/src/config.ts` |
| `POL` | `R/backend/src/modules/checkout/discounts/policy.ts` |
| `BGW` | `R/backend/src/modules/customer-insights/benefits-gateway.ts` |
| `BNS` | `R/backend/src/modules/customer-insights/benefits.ts` |
| `BVL` | `R/backend/src/modules/customer-insights/benefits-values.ts` |
| `BRG` | `R/backend/src/modules/customer-insights/briefing-gateway.ts` |
| `GVO` | `R/backend/src/modules/global-vouchers/options.ts` |
| `WHO` | `R/backend/src/modules/customer-website-handoff/options.ts` |

Architecture note (applies to every row): legacy is one server-rendered page per (store, counter, tab)
with the cart held upstream from first scan. The rewrite splits it into the local draft counter (`CNT`,
offline-capable, no customer, no benefits) and the online review modal (`CR`) where the draft is
imported into an upstream checkout and every benefit/customer/discount/payment control lives. Rows below
compare behaviour, not layout; a control that exists only inside the review modal is not a gap by itself.

#### Inclusion check

- `CO:1` extends `BCO`; `BCO:8` includes `HDR`; `BCO:13-14,28` navbar/sidebar/footer includes are
  `{% comment %}`ed out (page has no navbar/sidebar). `BCO:70` loads `MJS`. No other `{% include %}` in
  `CO` (grep: only `{% extends %}` at `CO:1`). `CO:7` / `CO:903` add bootstrap4-toggle CSS/JS; `CO:902`
  loads Mousetrap from a third-party CDN.
- `HDR:1-33`: meta charset/viewport, favicon `image/logo.png`, Source Sans Pro, FontAwesome, sweetalert2,
  Ionicons, tempusdominus, iCheck, select2, datatables, jquery-confirm, AdminLTE, overlayScrollbars,
  daterangepicker, `css/main.css`. Pure assets — no controls.
- `MJS`: `MeasureConnectionSpeed` (`MJS:6-42`) is defined but its interval is commented out
  (`MJS:53-55`) → dead. `.alert-message-custom` fade after 3 s (`MJS:46-48`; no such element in `CO`
  markup → no-op here). `$('.select2').select2()` (`MJS:50`) styles both salesperson selects.
  `#internet-indicator` toggle every 5 s (`MJS:58-66`) → no such element on this page → no-op.

---

#### CreateOrderView context

Route: `L/order/urls.py:23` `create-order/<int:store_id>/<int:counter_id>/<int:tab_id>/`,
`CreateOrderView(LoginRequiredMixin, View)` (`V:1516`). No store-membership, counter, check-in, role or
`user_type` check in the view; the only guards are the storefront-account lookup and the cart read.

| key | computed at (file:line) | used in template at | rewrite equivalent file:line | status |
|---|---|---|---|---|
| *(guard)* storefront account `MUser(user_type=8, pos_admin_id=request.user.id)` | `V:1518-1521`; on miss renders `order/basic_error.html` with **"User doesn't have any account as store-front user in thesouledstore. Please contact administrator."** | — | `SVC:637-643` `repository.operatorIdentity` → 409 `OPERATOR_CUSTOMER_MAPPING_MISSING` "Your operator account is not connected to checkout." | DIFFERENT — same guard, different text and surfaced as an API error in the review modal, not a full-page error |
| *(guard)* access control | none beyond login (`V:1516`) | — | `SVC:632-636` `requireStore` + `assertCheckIn` + active counter "Select an active counter at this store." | DIFFERENT — rewrite is stricter (intentional hardening; confirm acceptable) |
| *(guard)* upstream cart `title` error | `V:1546-1548` renders `basic_error.html` with `user_cart["title"]` verbatim | — | No pass-through of upstream `title` found in `R/backend/src/modules/checkout/gateway.ts` | UNKNOWN — verbatim upstream message propagation not evidenced |
| *(guard)* cart read failure | `V:1550-1552` **"We have a little problem, please try again later !"**; `get_user_cart` returns False on exception/non-200/invalid JSON, 8 s timeout (`V:1677-1689`) | — | No match for the string in `R/backend/src` / `R/frontend/src` | MISSING (verbatim message) |
| `get_user_cart` URL | `V:1658-1661` `MIGRATION_TO_API_V2 ? MAIN_API_V2_URL+'cart' : API_V2_URL+'pos/cart'`; payload `{operation:get}, is_pos, store_id, custom_data`, `tab_id` only when no end user (`V:1667-1676`) | — | `SVC:115` `cartPath = migrationV2 ? 'cart' : 'pos/cart'`; `SVC:198-204` `context()` endUser = customer attached | DONE |
| `store_id` | URL kwarg, `V:1616` | `CO` JS posts (e.g. `CO:1391`) | checkout state `storeId` (`SVC:~670`) / workspace | DONE |
| `counter_id` | URL kwarg, `V:1617` | payment JS (B/C) | checkout state `counterId` | DONE |
| `tab_id` | URL kwarg; Redis `tab_id → user_id` binding `V:1529-1530` | every AJAX post | `SVC:~674` `tabId: newTabId()` per checkout; drafts are the counter "Sale NN" tabs (`CNT:653-670`) | DIFFERENT — tab identity is per checkout, not per legacy tab row |
| `is_verified` | Redis `f'{user_id}_{tab_id}'` string, truthy (`V:1531-1533`) | `CO:258, 279, 293, 386, 418, 442, 444, 657` | `checkout.verifiedCustomerUntil` (expiry timestamp) used at `CR:1385-1386, 1444-1445` | PARTIAL — gating exists; no "User is verified !" display (see A-41) |
| `auth_token` | operator storefront token `V:1522`, replaced by end-user token when tab bound `V:1534` | all AJAX posts | `SVC:205-217` `token(state)` = customer or `operatorCustomerId` | DONE (server-side only; never sent to browser — improvement) |
| `user_obj` | `MUser` by Redis user id `V:1535`; `tss_points`/`tss_money` → `Helpers.round_down` (2 dp, ROUND_DOWN) if ≥1 else 0 (`V:1536-1537`, `H:68-73`) | `CO:62-66, 86-88, 103, 257, 279, 293, 386, 398, 418, 430, 442, 444, 558, 569, 576, 587, 603-606, 615, 633, 646, 651, 657, 661, 664, 672, 686, 741` | `checkout.customerId`; balances via `BVL:6-9` `customerWalletDisplay` (same ≥1 / ROUND_DOWN rule) shown in `BEN:68-71` | PARTIAL — rounding DONE; name/email banner and inline balances not shown (A-01, A-49, A-50) |
| `exclusive_detail` | `H:254-280` `get_exclusive_user(email)`: `ExclusiveUser(entity=email, attribute='EXCLUSIVE_EXPIRY')`, three strptime formats, `member = is_active`, message "User's Membership is deactivated." when inactive and expiry in future (`V:1539`) | `CO:459, 627, 628` (+ JS `CO:907`) | `BVL:38-55` `customerMembership` (same formats, same message); `CQS:67` uses `customer.membership.active` | DONE (logic) |
| `discount_eligibility` | `H:1804-1830` `check_app_user_eligibility`: only if `TEN_PER_SWITCH` (`S:542`, default **1**); GET `STAGING_CMS_ENDPOINT/api/v2/faq/app-cashback`, last `is_app` row; eligible iff not `STORE_FRONT_USER` and row `status`; CMS error → `[]` → **False**. Stays `None` when no user (`V:1527`) | `CO:538, 630` | `BGW:5-20,79` `TEN_PER_SWITCH` parsed as `'true'/'false'`, default **false**; `BGW:46,69,74` CMS failure → `null` (unavailable); `BNS:124` storefront exclusion | DIFFERENT — default off (legacy on); `"1"` is not accepted by the zod flag; failure → unavailable rather than "not eligible" |
| `is_app_user` | `user_addons.is_app_user` raw SQL (`H:1832-1838`); `True if int(is_app_user)` (`V:1627`) | `CO:115-117` | `BNS:123` `isAppUser` | DONE (logic); display PARTIAL (A-09) |
| `cart` | upstream cart JSON (`V:1542/1544`) | `CO:81, 139-210, 237-241, 265, 279, 309, 335, 381-433, 438, 442, 449-547` | `checkout.cart` / `checkout.quote` (`SVC:2194-2199` `publicState`) | DONE |
| per-product salesperson (mutates `cart`) | Redis `f'{store_id}_{tab_id}_{prod_id}'`; **on GET, missing keys are written** with `selected_salesperson` and `REDIS_TAB_USER_OBJECT_EXPIRY` (`V:1576-1583`, complementary `V:1605-1612`) | `CO:160, 172` | `SPA:89` display fallback `lineSalespersons[id] ?? salespersonId`; complementary lines included (`salespeople.ts:45`) | DIFFERENT — fallback at display, no write-on-read; persistence at order time UNKNOWN (agent owning order submission) |
| gift-card serial/dates (mutates `cart`) | Redis `gift_card_{tab_id}_{gv_id}`, `gc_start_date_{gv_id}`, `gc_end_date_{gv_id}` (dates keyed by gv_id only) (`V:1585-1601`) | `CO:200, 205, 206` | `checkout.giftCards[gv_id]`, `checkout.giftCardDates[gv_id]` (`GCI:34-38`) | DONE (scoped per checkout) |
| `salesperson` | `StoreSalesPerson(store, salesperson__is_active=1)` (`V:1556`) | `CO:97-99, 160, 172` | `SPA:22-30` paged `readCheckoutSalespeople` | DONE (active filter not re-verified: UNKNOWN) |
| `selected_salesperson` | Redis `f'{store_id}_{tab_id}'`, default 0 (`V:1558, 1569-1571`) | `CO:98` | `checkout.salespersonId` (`SPA:85`) | DONE |
| `payment_mode` | `TerminalHelper.get_payment_mode(store_id, counter_id)` (`V:1557`; numbered "N. name (machine)" labels) | JS only (`CO:5818-5853`, B/C) | `PaymentPanel.tsx` | UNKNOWN — owned by B/C |
| `payment_status` | `PaymentStatus.objects.all()` (`V:1554`) | not referenced in `CO` | — | N/A (unused) |
| `order_status` | `OrderStatus.objects.all()` (`V:1555`) | not referenced in `CO` | — | N/A (unused) |
| `user_deatils` | `""` (`V:1629`) | not referenced | — | N/A (unused) |
| `total_item_cart` | Σ qty of products + giftvouchers + complementary (`V:1573-1614`) | `CO:112` | `CNT:807-808` Σ local draft qty; `CR:764-767` "`{n} product lines`" (line count of products only) | PARTIAL — neither counts gift cards + complimentary quantities |
| `online_order_sesion_expire` | `JWT_CUSTOM_EXPIRY_MIN`, int, default **10** (`S:444`) | `CO:661` | `WHO:29-34` `CUSTOMER_WEBSITE_HANDOFF_SESSION_SECONDS` default 300, max 900; not displayed | DIFFERENT — renamed, 5 vs 10 min, message absent |
| `cashback_credit_message` | `CASHBACK_CREDIT_MESSAGE` env, default "Cashback will be credited after 15 days post delivery/billing, if there is no return." (`S:605`) | `CO:543` | `CFG:48` same default (`QD:4-5`), returned as `quoteDisplay.cashbackCreditMessage` (`SVC:2198`, `QD:28-49`) | DONE |
| `enable_old_pg_disc` | `ENABLE_OLD_PG_DISCOUNT` `int(env,1)` (`S:611`) | `CO:303` | not read anywhere in `R/backend/src` / `R/frontend/src` | MISSING |
| `enable_new_pg_disc` | `ENABLE_NEW_PG_DISCOUNT` `int(env,1)` (`S:613`) | `CO:329` | not read | MISSING |
| `pg_disc_permission` | `PG_DISC_ROLE_PERM` JSON, default `[1,2,3,4]` (`S:616`) | `CO:310, 312, 321` (UI disable only) | `POL:55,68`; enforced server-side for **both** kinds and for removal (`SVC:1351`) | DIFFERENT — no UI disabled state/message; stricter server scope |
| `pg_disc_otp_exempt` | `PG_DISC_OTP_EXEMPT` JSON, default `[1,2,3]` (`S:617`) | JS `CO:5037, 5521, 6260` | `POL:56,69`; `discounts/repository.ts:104`; `DiscountApproval.tsx` | DONE (flow detail owned by B/C) |
| `enable_voucher_to_money_check_and_convert` | `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` `int(env,0)` (`S:622`) | `CO:287` | `GVO:3-6,22` `GLOBAL_VOUCHER_CONVERSION_ENABLED` (`'true'/'false'`, default false); panel hidden when disabled `GVC:220` | PARTIAL — renamed env, different parse; default matches |
| `show_coupon_module` | `GLOBAL_SHOW_COUPON_MODULE (int,1) or (store.category=="IN_HOUSE" and request.user.user_type==1)` (`V:1562-1566`, `S:634`) | `CO:260` | not computed; coupon form always rendered `CR:1280-1314` | MISSING |
| `show_pg_discount_module` | same formula with `GLOBAL_SHOW_PG_DISCOUNT_MODULE` (`V:1567`, `S:635`) | `CO:302` | not computed; discount form always rendered `CR:1464-1557` | MISSING |
| `show_customer_insights` | `_customer_insights_enabled(store_id)`: empty `CUSTOMER_INSIGHT_STORE_IDS` → all stores (`V:1500-1513`, `S:658`) | `CO:649, 810` (+ JS `CO:3021`) | `BRG:38-45` server 403 "Customer insights are not enabled for this store."; button always rendered `INS:240-249` | PARTIAL — gate is server-only, button not hidden |
| *(POST)* | `V:1646-1655` renders the template with only `store_id, counter_id, tab_id, cashback_credit_message, show_customer_insights` (no `cart`) | — | none | N/A — POST is a degenerate render with no caller in `CO` markup (no `<form method=post>` to this URL) |

---

#### Controls (markup)

Legend for "Rewrite" column: file:line at `324d62d`. Status: DONE / PARTIAL / MISSING / DIFFERENT / N/A.

##### Page chrome and cart header (`CO:1-131`)

| ID | Control (type) | Legacy file:line | Visible/enabled when | Handler / endpoint | Validation / messages (verbatim) | Rewrite file:line | Status — note |
|---|---|---|---|---|---|---|---|
| A-00 | Page title | `CO:4` | always | — | "POS \| Create Order" | `CNT:543` PageTitle "The counter"; modal heading `CR:581` "Confirm the sale" | DIFFERENT — P2 cosmetic |
| A-01 | Connected-user badge (green) | `CO:62-63` | `user_obj` | — | "Connected User : {firstname} {lastname} ({email}) !" | `CR:764` "Customer {customerId}" | DIFFERENT — shows ID, not name/email (P2) |
| A-02 | Not-connected badge (red/yellow) | `CO:64-65` | not `user_obj` | — | "User Not Connected! Please connect the user first" | `CR:764` "Walk-in customer"; `CNT:684-685` static "Walk-in customer / No customer attached" | DIFFERENT — P2 wording |
| A-03 | "Cart" title badge | `CO:73` | always | — | "Cart" | `CNT:675` "A little retail therapy." | N/A cosmetic |
| A-04 | NPS Feedback checkbox `#customCheckbox1.nps-feedback-switch` | `CO:76-77` | always; **`checked disabled`** (cashier cannot change it) | read by order JS `$(".nps-feedback-switch").prop("checked")` (`CO:5646, 6388, 7026, 7542`) — jQuery `.prop` returns the first match = this always-checked box → `nps_feedback_switch=true` sent to `V:2696/3170` | — | `CR:1077-1120` "Order messages": "Send the customer an order SMS" + "Include the shopping feedback link" (editable); default `npsFeedback:false` `SVC:648` | DIFFERENT — **P1**: legacy always requests NPS feedback; rewrite defaults off and adds an SMS opt-out the legacy page lacks |
| A-05 | Member Benefits switch `#customCheckbox2.exclusive-benefits-switch` | `CO:80-90` | checked iff `cart.meta.items` has `name=='exclusive_user' and active==True`; **disabled when `user_obj`** | `.change` `CO:3179` → `ajax-exclusive-benefits` (`CO:3189`); also toggles `#exclusive-color` bg | — | `CR:1316-1330` checkbox "Apply walk-in member benefits", checked from `displayedMembershipBenefits` (`cashier-shortcuts/membership.ts:5-13`), disabled when `customerId !== null` or ambiguous; caption `CR:1333` / `CR:1336-1338` | DONE (logic); label differs (P2) |
| A-06 | Master salesperson select `#salesperson` (select2) | `CO:94-100` | always; option `0` "Not Selected" selectable; preselect `selected_salesperson` | `.change` `CO:2742` → `ajax-add-salesperson` (`CO:2747`), copies value to every per-line select (`CO:2744`) | — | `SPA:85` "Sale salesperson" (`data-cashier-action="salesperson"`); placeholder option disabled `SPA:56-58` | PARTIAL — cannot reset to "Not Selected"; only inside review (P2) |
| A-07 | "Sync Order" button `#sync-cart-products` | `CO:103-108` | `user_obj` | `CO:7998` jquery-confirm "Sync Order Cart" → `ajax_fetch_the_products` (`CO:8036`) | toast "Sync any order cart" | `CR:839-913` `OrderCopyPanel` "Copy a previous order" (`OCP:348-349`), only when `customerId` | DONE (visibility); flow owned by B/C |
| A-08 | Items count badge `.total-item-cart` | `CO:112` | always | updated by cart JS | "Items : {total_item_cart}" | `CNT:807-808` "Items" (draft qty); `CR:764-767` "{n} product lines" | PARTIAL — excludes gift-card and complimentary qty (P2) |
| A-09 | APP User checkbox `#customCheckbox3` (also class `nps-feedback-switch`) | `CO:115-120` | checked iff `is_app_user`; always disabled | — (N shortcut clicks it; no-op because disabled) | — | `BEN:74-75` "App user: Yes/No" (collapsed card, opened on demand) | PARTIAL — not visible until "Customer benefits" opened (P2) |
| A-10 | Barcode re-enable icon | `CO:125` | always | `onClick=BarcodeFieldActive()` (`CO:1377-1379`) | title "Click here to enable barcode field if disable" | `CNT:565-597` input re-enabled automatically after scan (`disabled={scanning}`) | DONE (no manual unlock needed) |
| A-11 | Barcode input `#prod-barcode` | `CO:127` | always; inputmask `9999999999999` (13 digits); `autocomplete=off` | `keyup` Enter → `handleBarcode` → `ajax-cart opr=add` (`CO:1363-1395`) | placeholder "Add product by barcode"; colours green/red on result (`CO:1399, 1716`) | `CNT:565-597` "Search products or scan a barcode"; Enter with `^[\d_]+$` → `scanBarcode`, adds to **local draft** | DIFFERENT — combined search/scan, no 13-digit mask, local draft rather than upstream cart (by design) |

##### Product cart table (`CO:137-176`)

| ID | Control (type) | Legacy file:line | Visible/enabled when | Handler / endpoint | Validation / messages | Rewrite file:line | Status — note |
|---|---|---|---|---|---|---|---|
| A-12 | Product table header | `CO:139-150` | `cart.products.items` non-empty | — | "Sku Id", "Product Name", "Price", "Sale Price", "Quantity", "Sales Person", "", "Action" | `CNT:691-776` card list; `CCL:59-64` "Current checkout items" | DIFFERENT — no tabular header (P2) |
| A-13 | SKU id cell | `CO:155` | per product row | — | `{{ c.prod_id }}` | `CNT:710` `line.barcode \|\| "SKU {productId}"` | PARTIAL — shows barcode in preference to SKU (P2) |
| A-14 | Product name link | `CO:156` | per row | `/products/{parent_prod_id}/show/` target `product_details` | — | `CNT:697-708` link from `cartProductLinks` or `/catalog/products/{id}`; `CCL:70-76` `/catalog/products/{parent_prod_id \|\| prod_id}` `_blank` | DONE |
| A-15 | Price cell `#tr-product-price-{id}` | `CO:157` | per row | — | `{{ c.price }}` | `CCL:80-83` "Unit price: ₹…"; counter shows line total only `CNT:765` | PARTIAL — unit price visible only in review |
| A-16 | Sale price cell | `CO:158` | per row | — | `spl_price` if truthy else `price` | `CCL:84-91` "Sale unit price" only if `spl_price !== undefined` (no fallback to price; `0`/`""` shown as-is or "Unavailable") | DIFFERENT — falsy-spl fallback to price not reproduced (P2) |
| A-17 | Quantity input `.td-input-qty` | `CO:159` | per row; `type=number min=0`; `stock="c.stock"` (literal string, template bug) | delegated `change` `CO:2377` → `ajax-cart` (`CO:2383`) | — | `CNT:712-760` −/`DraftQuantity`/+ (max 999, `CNT:747`); qty edits only on local draft, not in review (`CCL` read-only) | DIFFERENT — edits before review only; post-import qty change requires closing review (B/C to confirm) |
| A-18 | Per-product salesperson select | `CO:160` | per row; `0` "Not Selected" | delegated `change` `CO:2334` → `ajax-add-salesperson-per-product` (`CO:2341`) | — | `SPA:86-92` "Salesperson for {name}" | PARTIAL — cannot reset to 0 (P2) |
| A-19 | hidden `product_id[]` | `CO:161` | per row | read by order JS | — | n/a (state-held) | N/A |
| A-20 | Remove product (trash) `.remove-product` | `CO:162` | per row; carries `prod-type` | `CO:2567` → `ajax-cart opr=delete` (`CO:2583`) | — | `CNT:765-775` "Remove {name}" (local draft) | DONE (pre-review); in-review removal of ordinary lines MISSING (only complimentary, `CCL:92-106`) — confirm with B/C |

##### Complimentary rows (`CO:165-176`) — see mandatory section 1

| ID | Control | Legacy | Visible/enabled | Handler | Messages | Rewrite | Status |
|---|---|---|---|---|---|---|---|
| A-21 | SKU + "Freebie" badge | `CO:167` | per `cart.complementary_products.items` | — | "{prod_id} Freebie" | `CCL:78` prefix "Complimentary · " | DIFFERENT — label text (P2); SKU not shown |
| A-22 | Name link | `CO:168` | per row | `/products/{prod_id}/show/` (**prod_id**, not parent) | — | `CCL:70-72` parent_prod_id if present and ≠0, else prod_id | DIFFERENT — link target differs when a parent id exists (P2) |
| A-23 | Price | `CO:169` | per row | — | `{{ c.price }}` | `CCL:80-83` | DONE |
| A-24 | Sale price (= price) | `CO:170` | per row | — | `{{ c.price }}` (always price, never spl_price) | `CCL:84-91` shows `spl_price` if supplied | DIFFERENT (P2) |
| A-25 | Read-only qty `.cp-qty-readonly` | `CO:171`, CSS `CO:9-16` hides spinners | per row; `readonly`, `stock="0"` | — (readonly → no change event) | — | `CCL:77-79` "Quantity {n}" text | DONE |
| A-26 | Complimentary salesperson select | `CO:172` | per row, **enabled** | `CO:2334` | — | `SPA:86-92` (complimentary lines included via `salespeople.ts:45`) | DONE |
| A-27 | Remove complimentary | `CO:174` | per row, enabled | `CO:2567` → `ajax-cart opr=delete` | — | `CCL:92-106` "Remove complimentary item" → `PUT line-items/{prod_id}` qty 0 | DONE |

##### Gift-card rows (`CO:178-211`)

| ID | Control | Legacy | Visible/enabled | Handler | Messages | Rewrite | Status |
|---|---|---|---|---|---|---|---|
| A-28 | GC header | `CO:179-190` | `cart.giftvouchers.items` | — | "Sku Id", "Gift Card Name", "Price", "Serial No", "Start Date (MM/DD/YYYY)", "End Date (MM/DD/YYYY)", "", "Action" | `GCI:186-188` "Physical gift cards" + "Save a different card number for every physical card before requesting the final quote." | DIFFERENT (layout) |
| A-29 | GC SKU / name link / price | `CO:195-197` | per row | link `/products/{parent_prod_id}/show/` | — | `GCI:44-51` legend name + "Card value: ₹… · One card" (no link, no SKU) | PARTIAL (P2) |
| A-30 | Serial number `.gift-barcode` | `CO:200` | per row; mask 20 digits; prefilled `gift_card_no` | (paired with A-31) | placeholder "Scan/Enter Serial No." | `GCI:64-75` "Gift card number", `pattern [0-9_]{6,40}` | DIFFERENT — 6–40 chars incl. `_` vs exact 20-digit mask (validation owned by GC agent) |
| A-31 | Check/save serial `.check-gc` | `CO:202` | per row | `CO:2525` → `ajax-check-save-gc` (`CO:2533`) | colours `CO:2545/2552` | `GCI:56-101` "Save card number and dates" (`PUT gift-card-items/{gv_id}`) | DONE (merged with dates) |
| A-32 | Start date `.pick-start-date` | `CO:205` | per row; daterangepicker | `CO:978-994`, `CO:2294` → `ajax-save-gc-date` | placeholder "Today's" (empty = today) | `GCI:77-87` "Valid from" `type=date required` | DIFFERENT — **P1**: empty-means-today not allowed |
| A-33 | End date `.pick-end-date` | `CO:206` | per row | `CO:1006-1014` | placeholder "No Expiry" (empty = no expiry) | `GCI:88-98` "Valid until" `required` | DIFFERENT — **P1**: cannot issue a no-expiry card |
| A-34 | Remove GC | `CO:208` | per row (gv-id) | `CO:2567` | — | `GCI:153-163` "Remove this gift card" | DONE |
| A-34b | (extra) Custom value / Add another | — | — | — | — | `GCI:103-151` | UNKNOWN — not in `CO:1-900` markup; verify against GC JS owner |

##### Footer actions (`CO:217-229`)

| ID | Control | Legacy | Visible/enabled | Handler | Messages | Rewrite | Status |
|---|---|---|---|---|---|---|---|
| A-35 | `#show-order-form-error` | `CO:219` | always (filled by JS) | — | — | `CR:597-601` `problem` alert | DONE |
| A-36 | "Proceed For Payment" `#btn-proceed` + `#spinner-border-payment` | `CO:222-224` | always rendered | `CO:5035-5052`: role ∈ `pg_disc_otp_exempt` → `PayProceedButton()`; else if `#pg_discount>0 \|\| #store_discount_pg>0` → `SendOTP()` else `PayProceedButton()` | title "Press 'P'" | `CNT:817-823` "Review sale" → `CR` "Confirm prices online" (`CR:628-636`) → "Get final quote" (`CR:1569-1580`) → `DiscountApproval` (`CR:1647`) → "Create order" (`CR:1654-1678`, `aria-keyshortcuts="P"`) | DIFFERENT — multi-step; flow owned by B/C |
| A-37 | "Fast Cash" `#fast-checkout` + spinner | `CO:225-227` | rendered; JS hides when cart empty (`CO:1738`) | `CO:7242` (store-PG reason/remark checks, e.g. "Please select a store discount(PG) Reason for PG discount.") | — | `FC:224-229` "Cash received for fast checkout" (`data-cashier-action="fast-cash"`); requires quoted + approval (`CR:1606-1611`) | DIFFERENT — owned by B/C |

##### Right panel: tabs and Cart Details (`CO:233-448`)

| ID | Control | Legacy | Visible/enabled | Handler | Messages | Rewrite | Status |
|---|---|---|---|---|---|---|---|
| A-38 | Grey card background `#exclusive-color` | `CO:234-242` | `exclusive_user` meta active → `background-color:#d3d3d3` (JS toggles `CO:3181-3184`) | — | — | none | MISSING — P2 cosmetic |
| A-39 | Tabs: Cart Details / **User Details (default active)** / Behaviour | `CO:244-247`, `CO:253, 553, 671` | always | bootstrap tabs | "Cart Details", "User Details", "Behaviour" | `CR` `<details>` sections (`CR:1077, 1121, 1280, 1340, 1464`) + collapsible cards | DIFFERENT (layout) |
| A-40 | "Refresh" tab `#refresh-session` | `CO:248` | always | `window.location.reload()` + spinner icon | "Refresh" | `CR:608-626` "Refresh sale" (`data-cashier-action="refresh"`, re-reads checkout) | DONE |
| A-41 | Verify OTP button `#otp-sent` | `CO:257-259` | `user_obj`; if `is_verified`: green, **disabled** | `CO:4703` → `ajax-send-otp` (`CO:4706`) | verified: "User is verified !"; else "Verify the user to use Tss Money/Points/Voucher !" | `CR:1188-1201` "Send verification code"; `CR:1229-1277` "Verification code" + "Verify customer"; notice "Customer verified." | PARTIAL — no persistent verified badge / disabled state (P1 visible behaviour) |
| A-42 | Coupon input `#coupon` + Apply `#coupon-apply` + Remove `#coupon-remove` | `CO:260-273` | **`show_coupon_module`**; input prefilled from `cart.meta` `coupon.coupon` | `CO:4496` → `ajax-coupon`; `CO:4600` → `ajax-cart` | label "Coupon" | `CR:1280-1314` "Coupon" / "Apply coupon" / "Remove coupon"; always rendered; input starts empty | PARTIAL — flag gate MISSING (P1); applied code not prefilled (P2) |
| A-43 | Gift voucher `#gift-voucher` + Apply + Remove | `CO:274-286` | always; input **disabled unless `user_obj and is_verified`**; prefilled `gift_voucher.voucher_code` | `CO:3433` → `ajax-gift-voucher` with `gc_pin:0`, then PIN dialog "GC PIN" if needed (`CO:3536-3557`, "Please Provide a Valid PIN"); remove `CO:3677` → `ajax-cart` | label "Gift Voucher/ Gift Card" | `CR:1408-1462` "Gift voucher code" + **required** "Gift voucher PIN" + "Redeem voucher" (disabled unless verified) / "Remove gift voucher" | DIFFERENT — PIN mandatory up-front (legacy tries without PIN first) — **P1**; no prefill |
| A-44 | Voucher→TSS Money check/top-up `#gift-voucher-check-and-convert`, `#gift-voucher-check`, `#gift-voucher-convert` | `CO:287-301` | **`enable_voucher_to_money_check_and_convert`** (default 0); input disabled unless `user_obj and is_verified` | `CO:3786` → `ajax-gift-voucher-check`; `CO:3921` → `ajax-gift-voucher-convert` | "Check and Top-up Gift Voucher/Gift Card to TSS Money", "Check", "Top-up" | `CR:965-991` → `GVC:220-330` "Convert a voucher to TSS Money", "Voucher code", "Gift card PIN, if required", "Convert voucher balance"; hidden unless `GLOBAL_VOUCHER_CONVERSION_ENABLED` (`GVC:220`, `GVO:22`) | PARTIAL — gate renamed/parse differs; separate "Check" (balance preview) step MISSING (P1) |
| A-45 | Old PG discount: amount `#pg_discount` (number, min 0, max 9999999), Apply `#pg-discount-apply`, Remove `#pg-discount-remove`, remark `#pg-remark`, hidden `#pg_disc_otp_val` | `CO:303-328` | **`show_pg_discount_module and enable_old_pg_disc`**; amount/Apply/remark **disabled with title "You do not have permission."** unless `request.user.role in pg_disc_permission`; Remove always enabled; amount prefilled `pg_discount.used_pg_discount` | `CO:4055` / `CO:4168` → `ajax-pg-discount` | "Payment Gateway Discount", "PG Discount Remark", placeholder "Enter the remark to use PG discount" | `CR:1464-1557` "Discount type" option "Payment gateway discount" (`CR:1489`), "Discount amount", "Discount remark" (3–35 chars), "Apply discount" / "Remove selected discount"; role enforced server-side `SVC:1351` | PARTIAL — no flag gating (MISSING), no disabled/permission message, no prefill; one shared form |
| A-46 | Store discount(PG) amount `#store_discount_pg` + Apply + Remove | `CO:329-340` | **`show_pg_discount_module and enable_new_pg_disc`**; **no role gating in markup**; prefilled `store_discount_pg.used_store_discount_pg` | `CO:4275` / `CO:4389` → `ajax-store-discount-pg` | "Store discount(PG)" | `CR:1488` option "Store discount (PG)" + shared amount/apply/remove | DIFFERENT — rewrite applies `PG_DISC_ROLE_PERM` to store-PG and to removals (`SVC:1351`); legacy view `V:2237` has no role check → roles outside `[1,2,3,4]` lose the control (**P1**) |
| A-47 | Store discount(PG) remark `#store-discount-pg-remark` | `CO:341-350` | as A-46 | read by proceed/fast-cash JS | "Store discount(PG) Remark", placeholder "Enter the remark to use Store PG Disc" | `CR:1501-1511` "Discount remark" | DONE (validation owned by B/C) |
| A-48 | Store discount(PG) reason `#store-discount-pg-reason` | `CO:351-370` | as A-46 | read by JS (`CO:7247-7262`) | options verbatim: "Select reason", "Price mismatch (Online v/s POS)", "Price mismatch (Pricetag v/s POS)", "Price mismatch (During exchange)", "Founder billing", "Marketing activity", "Uniform billing", "Perfume tester", "Trial socks", "Personal Care" | `CR:1512-1535` same nine options + "Select reason" | DONE |
| A-49 | TSS Points toggle `#tsspointsswitch` (bootstrap-toggle APPLIED/NOT APPLIED) + badge `#tsspoints` | `CO:375-406` | checked iff `tss_points.used_tss_points`; **disabled unless `user_obj and is_verified and user_obj.tss_points > 0`** (attribute only emitted when a `tss_points` meta row exists); badge `used/total` or user balance or 0 | `.change` `CO:3320` → `ajax-wallet` immediately | "Tss Points", "APPLIED"/"NOT APPLIED" | `CR:1363-1370` "Use TSS Points" checkbox (default unchecked, not bound to applied state) submitted via "Use wallet" (`CR:1381-1390`); balance in `BEN:70-71` | DIFFERENT — no immediate toggle, no applied-state reflection, no balance>0 gate (P1) |
| A-50 | TSS Money toggle `#tssmoneyswitch` + badge `#tssmoney` | `CO:407-436` | same rule with `tss_money` | `.change` `CO:3175` (→ `ajax-wallet`) | "Tss Money" | `CR:1355-1362` "Use TSS Money" (default checked) + "Remove wallet benefits" `CR:1391-1407` | DIFFERENT — as A-49 (P1) |
| A-51 | Desired TSS Money `#applied_tss_money` + Apply `#tss-money-apply` + "(Partial Money Applied)" | `CO:437-446` | input+Apply disabled unless `user_obj and is_verified and tss_money > 0`; prefilled `used_tss_money`; marker when `tss_money.custom_tss_money` | `CO:3035` → `ajax-wallet` (`CO:3057`) | "Desired Tss Money", "(Partial Money Applied)" | `CR:1371-1380` "Wallet amount" (`pattern [0-9]+(\.[0-9]{1,2})?`, disabled unless Use TSS Money) | PARTIAL — partial-applied marker and prefill MISSING (P2) |

##### Summary rows (`CO:449-547`) — detailed in mandatory section 2

| ID | Row | Legacy | Rewrite | Status |
|---|---|---|---|---|
| A-52 | Cart Total | `CO:453-456` | `CQS:63-66` | DONE (label case P2) |
| A-53 | Membership Savings | `CO:459-468` | `CQS:67-73` | DONE |
| A-54 | Discount (+ JS relabel to "Membership Savings" when a prod_type 5 line is in cart, `CO:2509-2520`) | `CO:469-479` | `CQS:74-88` | PARTIAL — label text differs, relabel MISSING, extra "membership unconfirmed" variant |
| A-55 | Store discount(PG) | `CO:480-485` | `CQS:90-93` | DONE |
| A-56 | TSS Points Applied | `CO:486-491` | `CQS:94-97` | DIFFERENT — rendered with ₹ prefix although points |
| A-57 | Coupon Discount | `CO:492-496` | `CQS:98-101` | DONE |
| A-58 | Gift Voucher | `CO:497-502` | `CQS:102-105` | DONE |
| A-59 | TSS Money Applied | `CO:503-508` | `CQS:106-109` | DONE |
| A-60 | PG Discount (commented out) | `CO:509-514` | not rendered | DONE (correctly absent) |
| A-61 | GST (included in cart total) | `CO:518-522` | `CQS:110-113` | DONE |
| A-62 | Total (= total + rounding_off) | `CO:523-527` | `CQS:114-117` "Total before rounding" via `QD:47` | DIFFERENT — label (P2) |
| A-63 | Round Off Value (prefixed "-") | `CO:528-532` | `CQS:118-121` "Rounding value" (no "-" prefix) | DIFFERENT — sign display (P2) |
| A-64 | Total Payable (₹) | `CO:533-537` | `CQS:122-125` "Official payable" + `CR:1594-1599` "Confirmed payable" | DIFFERENT — label (P2) |
| A-65 | Cashback Earned (₹) + credit message | `CO:538-545` | `CQS:126-145` | PARTIAL — see section 3 |

##### User Details tab (`CO:553-669`)

| ID | Control | Legacy | Visible/enabled | Handler | Messages | Rewrite | Status |
|---|---|---|---|---|---|---|---|
| A-66 | Name (disabled) | `CO:556-559` | always; value " first last " when `user_obj` | — | label "Name" | `PRO:71` (collapsed "Customer details" card, `PRO:52-60`) | PARTIAL — hidden until opened |
| A-67 | Mobile `#phone` | `CO:562-575` | always editable; mask 10 digits; placeholder "0123456789" | used by fetch form | label "Mobile" | lookup field `CR:1137-1145` "Email or phone" (maxLength 254, required); display `PRO:75-76` | DIFFERENT — single lookup field |
| A-68 | "Add Mobile No." `#add-number` | `CO:576-580` | `user_obj` | `CO:7815` → `ajax_m_user_mobile` (`CO:7845`) | — | `CR:803-837` `CustomerContactPanel` (verified contact change) | DIFFERENT — verified-contact flow (owned by contacts agent) |
| A-69 | Email `#email` | `CO:584-589` | always editable; placeholder "abcd@xyz.com" | used by fetch form | label "Email" | `CR:1137-1145` (shared lookup) | DIFFERENT |
| A-70 | Customer Type `#customer_type` (B2C/B2B) | `CO:599-605` | disabled until Fetch enables it (`CO:2971`); `change` shows GSTIN box (`CO:923-935`) | — | options "B2C", "B2B" | `EDT:161-177` options "Individual"/"Business"; display `PRO:91` | DIFFERENT — option labels (P2) |
| A-71 | GSTIN (hidden `#gstin-val`, box `#gstin-box-update`) | `CO:606, 611-617` | box shown when B2B | — | label "GSTIN" | `EDT:178-190` GSTIN when B2B; error "Choose a valid change. Business customers need a 15 character GSTIN." (`EDT:102`) | DONE (validation owned by profile agent) |
| A-72 | `#user-form-error` | `CO:620` | always | — | — | `CR:597-601` | DONE |
| A-73 | Exclusive status `#exclusive-details` | `CO:627` | `member==True` → red "Exclusive User Till {expiry\|date:"M d, Y"}"; elif `exclusive_detail` (non-empty dict, i.e. user connected) → "Non Exclusive User" | — | verbatim as left | `BEN:61-67` "Exclusive member · until YYYY-MM-DD" / "Non-exclusive member" (collapsed card) | PARTIAL — wording/date format, not shown by default (P2) |
| A-74 | Membership message `#exclusive-details-m` | `CO:628` | `exclusive_detail.message` | — | "User's Membership is deactivated." | `BEN:87`; text from `BVL:51` | DONE (hidden until card opened) |
| A-75 | Cashback eligibility `#app-user-details` | `CO:630` | `True` → red "User Is Eligible For Cashback "; `False` → "User is not eligible for cashback"; `None` → empty | — | verbatim | `BEN:76-83` "App cashback: Eligible / Not eligible / Temporarily unavailable" | PARTIAL — wording; default-hidden; TEN_PER_SWITCH default differs (section 3) |
| A-76 | Hidden `#sync-cart-form` (`user_id`, `store_cart`) | `CO:632-635` | always | `CO:2986` submit → `ajax-sync-cart` (`CO:2998`) | — | `CR:1150-1166` customer pick → `PUT customer` | DONE |
| A-77 | "Fetch the User" (submit `#user-fetch-form`) + spinner | `CO:638-640` | always | `CO:2907` → `ajax_user_details` (`CO:2921`) | — | `CR:1122-1149` "Find customer" | DONE |
| A-78 | "Update User" `#update-user` | `CO:641-645` | hidden until fetch shows it (`CO:2973`) | `CO:2854` → `ajax_update_user` (`CO:2886`) | — | `PRO`/`EDT:110-200` profile editor (after customer attached) | DIFFERENT — edit only after attach (profile agent) |
| A-79 | "Connect the User" `#sync-cart` | `CO:646-648` | `visibility:visible` iff `user_obj`, else hidden until fetch | `CO:2986` → `ajax-sync-cart`; sets `sessionStorage pos_insight_open` when insights enabled (`CO:3021`) | — | `CR:1150-1166` per-customer button "{first} {last} · {telephone}" | DONE (auto-open insights MISSING, P2) |
| A-80 | "Customer Insights" `#open-insights` | `CO:649-654` | **`show_customer_insights`**; hidden if not `user_obj` | `openCustomerInsights()` (`CO:8411`) | "Customer Insights" | `CR:993-1006` → `INS:240-249` "Customer insights", rendered whenever `customerId` | PARTIAL — store gate only server-side (`BRG:38-45`) |
| A-81 | Online order link `#online-order` | `CO:657-662` | `user_obj and is_verified` | `CO:4783` → `ajax-online-order` (`CO:4785`) | "Looking to place an online order?", "Place order now!", "It will redirect to the website with {email} login, and the session will remain active for only {JWT_CUSTOM_EXPIRY_MIN} minutes." | `CR:942-963` → `WEB:155-191` consent checkbox "The verified customer agrees to open their website account on this device." + "Prepare customer website" / "Open customer website" / "Cancel website link"; disabled unless `CUSTOMER_WEBSITE_HANDOFF_ENABLED` (`WHO:15`) | DIFFERENT — extra consent/prepare steps, session 300 s vs 10 min, explanatory text MISSING (P1) |
| A-82 | "New User ? Create Account" `#user-register` | `CO:664-668` | not `user_obj` | `CO:4798` modal `user-register-form` | "New User ?", "Create Account" | `CREG:47-50` "Create a customer account" (hidden when customer attached) | DONE (flow owned by registration agent) |

##### Behaviour tab (`CO:671-761`)

| ID | Control | Legacy | Visible/enabled | Handler | Messages | Rewrite | Status |
|---|---|---|---|---|---|---|---|
| A-83 | Not-connected notice | `CO:672-673` | not `user_obj` | — | "Please connect the user first." | history/insight cards only render with `customerId` (`CR:993, 1026`) | DIFFERENT — silent absence (P2) |
| A-84 | Pills "User Data" / "Data Insights" / "Fetch The Data" | `CO:675-681` | `user_obj` | `getUserData()` (`CO:1072`) → `ajax_user_behaviour` (`CO:1076`) | — | `CR:1026-1052` `CustomerHistoryCard` toggle | DIFFERENT (layout) |
| A-85 | Placeholder "Fetch The Data" | `CO:686-688` | `user_obj` | — | "Fetch The Data" | `HIS` loading state | N/A |
| A-86 | User Data list | `CO:692-715` | after fetch | — | dt: "Full Name", "Email", "Telephone", "Birthday", "Gender", "Anniversary", "Active Tss Money", "Active Tss Points", "No of Active Gift Vouchers", "User Since", "Exclusive User", "Exclusive Savings" | `PRO:71-94` (Name, Email, Mobile, Gender, Birthday, Anniversary, Customer type, GSTIN); `BEN:61-85` (Membership, TSS Money, TSS Points, Active gift vouchers, App user, App cashback, Customer since); `HIS:171` "Lifetime exclusive savings" | DONE — fields present across three cards (labels differ, P2) |
| A-87 | Data Insights list | `CO:722-738` | after fetch | — | "Total Orders", "Cancelled Orders", "Returned Orders", "Total Order in last 30 days", "Total Store Orders", "Total Online Order", "Net Promotor Score" | `HIS:173-186` "Total orders", "Store orders", "Online orders", "Orders in last 30 days", "Cancelled orders", "Returned orders", "Average NPS score" | DONE (labels P2) |
| A-88 | Returned orders "View" `#returned-orders-view` | `CO:727-730` | after fetch | `CO:1219` modal | — | `HIS:239-280` "Returned orders" table | DONE |
| A-89 | Last 5 Orders "View" `#last-5-order-view` | `CO:739-744` | `user_obj` | `CO:1179` modal (Order ID / Date / Order Amount / Feedback) | — | `HIS:192-235` "Recent orders" (Order / Date / Amount / Channel / Feedback) | DONE |
| A-90 | Preferences: "Preferred Categories", "Monetary Preference", "Preferred Sizes", "Preferred Artist/Tags/Color" | `CO:745-752` | after fetch (default "-") | filled by `getUserData` (B/C) | — | no match in `customer-insights/*` (grep "Preferred"/"Monetary") | MISSING — P1 (if the behaviour endpoint still returns them; confirm with B/C) |

##### Inventory and insights modal (`CO:772-899`)

| ID | Control | Legacy | Visible/enabled | Handler | Messages | Rewrite | Status |
|---|---|---|---|---|---|---|---|
| A-91 | "Inventory" reload button `#co-table-reload` | `CO:776` | always | `CO:1861-1865` DataTable `ajax.reload()` | "Inventory" | react-query refetch on search/scroll; no explicit reload (`CNT:636-643` "Load more products") | PARTIAL (P2) |
| A-92 | Include/Exclude OOS toggle `#include_oos` | `CO:778-782` | always | `CO:1064-1068` reload | "Include OOS" / "Exclude OOS" | `CNT:599-606` "Show out of stock" | DONE |
| A-93 | Products datatable | `CO:784-802` | always; source `ajax_order_product_stock_list` (`CO:1756-1770`) | Action column (troubleshoot `CO:1867`, add) from server rows | columns "Sku ID", "Product", "Erp Product", "Barcode", "Price", "Spl. Price", "Ex. Price", "Saleable Stock", "Holded Stock", "Storages Stock", "Action" | `CNT:70-124` tiles: erpName or SKU, name, price, "GST n%", stock label; troubleshoot link when `role===1 && userType===1` (`CNT:629`) | PARTIAL — Barcode, Spl. Price, Ex. Price, Holded Stock, Storages Stock not displayed although `specialPrice`/`exclusivePrice` exist in `R/frontend/src/api/types.ts:30-31` (P1) |
| A-94 | Customer Insights modal `#customer-insight-modal` + `ci-*` CSS | `CO:810-899` | `show_customer_insights` | `renderCustomerInsight()` (B/C) | title "Customer Insights" | `INS:238-273` inline panel `CustomerBriefingCard` | PARTIAL — inline, store gate server-only |

---

#### Mandatory verification 1 — cart line rows and complimentary items (`CO:153-176`)

Line-by-line:

| Legacy line | Legacy content | Rewrite | Result |
|---|---|---|---|
| `CO:153` | loop `cart.products.items` | `CCL:26-35` parses `products.items` (≤500, zod) and `CNT:691` draft lines | DONE — rewrite shows upstream lines read-only in review, editable draft lines on counter |
| `CO:154` | `<tr id="tr-product-{prod_id}" class="tr-product">` | `CCL:69` `.checkout-current-line` | DONE |
| `CO:155` | `{{ c.prod_id }}` | not displayed in `CCL`; `CNT:710` barcode or SKU | PARTIAL (P2) |
| `CO:156` | link `/products/{{parent_prod_id}}/show/` target `product_details` | `CCL:70-76` `/catalog/products/{parent or prod}` `_blank` | DONE (route mapped) |
| `CO:157` | price | `CCL:80-83` "Unit price: ₹{price}" / "Unavailable" | DONE |
| `CO:158` | `spl_price` if truthy else `price` | `CCL:84-91` only when `spl_price !== undefined`; `null`/`0`/`""` → "Unavailable" or ₹0.00 | DIFFERENT (P2) |
| `CO:159` | editable qty, `min=0` → `ajax-cart` update | review read-only; counter `CNT:712-760` | DIFFERENT (by design) |
| `CO:160` | per-line salesperson select (0 = Not Selected) | `SPA:86-92` | PARTIAL (no reset) |
| `CO:162` | Remove → `ajax-cart opr=delete` (`CO:2567-2583`) | counter local remove `CNT:765-775`; no in-review ordinary-line removal | PARTIAL |
| `CO:165` | loop `cart.complementary_products.items` | `CCL:28-31` (default `[]`) | DONE |
| `CO:166` | same `tr-product` id scheme | `CCL:69` key `complementary:prod_id:index` | DONE |
| `CO:167` | `{prod_id}` + `<span class="badge badge-success">Freebie</span>` | `CCL:78` "Complimentary · Quantity n" | DIFFERENT — badge text "Freebie" absent (P2) |
| `CO:168` | link uses **`prod_id`** (not parent) | `CCL:71` parent if present and ≠ "0", else prod_id | DIFFERENT (P2) |
| `CO:169` | price | `CCL:80-83` | DONE |
| `CO:170` | sale price = **price** | `CCL:84-91` spl_price if present | DIFFERENT (P2) |
| `CO:171` | qty `readonly`, `stock="0"`, spinner hidden by `CO:9-16` | `CCL:77-79` text only | DONE |
| `CO:172` | salesperson select (enabled) | `SPA:86-92` includes complimentary lines (`salespeople.ts:45`) | DONE |
| `CO:173` | hidden `product_id[]` | n/a | N/A |
| `CO:174` | Remove (enabled) → `ajax-cart opr=delete` with `prod-type` | `CCL:92-106` "Remove complimentary item" → `PUT line-items/{prod_id}` `{quantity:0}`; backend dispatches delete for complimentary-only SKUs (per `checkout-summary-controls.md`) | DONE |

Totals per `V:1602-1606` include complimentary quantities in "Items" — not reproduced (A-08).

#### Mandatory verification 2 — quote/summary display (`CO:449-547`)

Source context: rows render once per `cart.meta.items` entry whose `name == "calculations"` (`CO:449-450`);
values are raw template output (no currency symbol, no fixed decimals); `sub`/`addition` are
django-mathfilters (float arithmetic, `''` on non-numeric). Rewrite: `QS:3-14` requires **exactly one**
`calculations` row else shows "Quote amounts are unavailable. Get a final quote to review the breakdown."
(`CQS:56-59`); amounts rendered by `QS:16-26` as `₹` + thousands separators + ≥2 decimals without float
conversion; non-numeric → "Unavailable — refresh quote" (`CQS:8-11`). Backend producer `QD:28-49`
(`checkoutQuoteDisplay`) computes the two derived values with 2200-digit Decimal, `toFixed(2)` HALF_UP;
attached to the public state only when a quote exists (`SVC:2197-2199`); frontend schema
`R/frontend/src/pages/checkout/client.ts:113`. Rewrite also prints "This breakdown is not a current final
quote…" when `quoteIsCurrent` fails (`CQS:50-55`, `QS:27-43`) — no legacy equivalent.

| # | Legacy label (verbatim) | Legacy source / condition | Rewrite label | Rewrite source / condition | Result |
|---|---|---|---|---|---|
| 1 | "Cart Total" `.cart-total #sub-total` (`CO:453-456`) | `cl.products_total` | "Cart total" (`CQS:63-66`) | `calculations.products_total` | DONE (case P2) |
| 2 | "Membership Savings" `.member-savings` (`CO:459-468`) | if `exclusive_detail.member` (connected user is active exclusive): `cl.exclusive_savings` | "Membership savings" (`CQS:67-73`) | if `customer.membership.active` from `/customer-benefits` (`BVL:38-55`) | DONE — same predicate; requires benefits read to succeed |
| 3 | "Discount" `#discount-label-text` (`CO:469-479`) | else-branch (incl. no user): `cl.total_savings \| sub: cl.coupon_discount`; JS relabels to "Membership Savings" if any cart line has `prod_type == 5` (`CO:2509-2520`) | "Discount (excluding coupon)" (`CQS:74-80`) when no customer or benefits loaded & not member; "Total savings (membership unconfirmed)" showing `total_savings` (`CQS:81-87`) when benefits not loaded | `quoteDisplay.nonCouponDiscount` = `total_savings − coupon_discount` (`QD:46`) | PARTIAL — label differs; membership-product relabel MISSING; extra unconfirmed variant shows a different figure |
| 4 | "Store discount(PG)" `.store-discount-pg-value` (`CO:480-485`; unclosed `<span>`) | `cl.used_store_discount_pg`; always shown (not flag-gated) | "Store discount (PG)" (`CQS:90-93`) | same field | DONE |
| 5 | "TSS Points Applied" `.tss-points-value` (`CO:486-491`) | `cl.used_tss_points` | "TSS Points applied" (`CQS:94-97`) | same field, but rendered via `Amount` → "₹…" | DIFFERENT — points shown as rupees (P2) |
| 6 | "Coupon Discount" `.coupon-discount` (`CO:492-496`) | `cl.coupon_discount`; shown even when coupon module hidden | "Coupon discount" (`CQS:98-101`) | same | DONE |
| 7 | "Gift Voucher" `.gift-voucher-value` (`CO:497-502`) | `cl.gift_voucher_value` | "Gift voucher" (`CQS:102-105`) | same | DONE |
| 8 | "TSS Money Applied" `.tss-money-value` (`CO:503-508`) | `cl.used_tss_money` | "TSS Money applied" (`CQS:106-109`) | same | DONE |
| — | "PG Discount" (`CO:509-514`) | **commented out** | — | not rendered | DONE |
| 9 | "GST (included in cart total)" `.gst-total` (`CO:518-522`) | `cl.gst_total` | "GST (included in cart total)" (`CQS:110-113`) | same | DONE (verbatim) |
| 10 | "Total" `.total-payable-round` (`CO:523-527`) | `cl.total \| addition: cl.rounding_off` | "Total before rounding" (`CQS:114-117`) | `quoteDisplay.totalBeforeRounding` = total + rounding_off (`QD:47`) | DIFFERENT — label only (P2); value identical modulo 2-dp formatting |
| 11 | "Round Off Value" `.round-off` (`CO:528-532`) | literal `-` + `cl.rounding_off` | "Rounding value" (`CQS:118-121`) | `calculations.rounding_off`, no `-` prefix | DIFFERENT — displayed sign differs (P2) |
| 12 | "Total Payable (₹)" `.total-payable` (`CO:533-537`, red bold) | `cl.total` | "Official payable" (`CQS:122-125`); separately "Confirmed payable" `CR:1594-1599` from authoritative total | same field | DIFFERENT — label (P2) |
| 13 | "Cashback Earned (₹)" `.cashback-earned` (`CO:538-544`) | iff `discount_eligibility == True`: `cl.app_cashback` | "Cashback earned" (`CQS:126-133`) | iff `customer.app.discountEligible === true` | see section 3 |
| 14 | `{{cashback_credit_message}}` small text (`CO:543`) | same condition | `<p>` (`CQS:135-140`) | `quoteDisplay.cashbackCreditMessage ?? 'Cashback credit timing is unavailable. Refresh the sale.'` | DONE (message source `CFG:48`) |
| — | — | — | "Cashback eligibility is unavailable. No cashback amount is promised." (`CQS:141-145`) | customer attached and benefits missing/null | extra (rewrite-only) |

Where the legacy summary lives: "Cart Details" tab, not the default tab (`CO:245` vs default `CO:246`), always
on the page. Rewrite: only inside the review modal after a quote. Legacy JS rewrites these spans after every
AJAX mutation (B/C); rewrite re-renders from the replied quote.

#### Mandatory verification 3 — cashback eligibility gating

Legacy chain:

1. `V:1527` `discount_eligibility = None` (no connected user → row and h6 absent).
2. `V:1540` `Helpers.check_app_user_eligibility(user_id=user_obj.id)` (`H:1804-1838`):
   - only when `TEN_PER_SWITCH` (`S:542`: `True if int(ENV.get("TEN_PER_SWITCH", 1)) else False` → **default True**);
   - GET `{STAGING_CMS_ENDPOINT}/api/v2/faq/app-cashback`; keeps the **last** row with `is_app` truthy;
     exception or non-200 → `[]` → `discount_eligibility = False`;
   - `MUser(id, user_platform="STORE_FRONT_USER")` exists → not eligible;
   - eligible iff not storefront and campaign `status` truthy.
3. Template: `CO:538` `{% if discount_eligibility == True %}` → row "Cashback Earned (₹)" with `cl.app_cashback`
   and `<small>{{cashback_credit_message}}</small>` (`CO:543`). `CO:630` h6: True → "User Is Eligible For
   Cashback " (red), False → "User is not eligible for cashback".
4. Evaluated once at page render; after "Connect the User" the JS re-reads `data.discount_eligibility`
   (`CO:2945`, B/C).

Rewrite chain:

1. `GET /api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-benefits`
   (`R/backend/src/modules/customer-insights/index.ts:44`), read by `CQS:28-44` keyed by operator/store/
   checkout/customer/version, only when the quote is current and a customer is attached.
2. `BNS:124` `discountEligible = platform === 'STORE_FRONT_USER' ? false : campaignActive`.
3. `BGW:77-90` `active()`: `if (!options.TEN_PER_SWITCH) return false`; `TEN_PER_SWITCH` zod flag `BGW:5-9,13`
   maps `undefined → false`, accepts only `'true'`/`'false'` (a legacy-style `"1"`/`"0"` fails parsing);
   `R/backend/.env.example:288` ships `TEN_PER_SWITCH=false`.
4. `BGW:44-75`: missing/invalid `STAGING_CMS_ENDPOINT`, non-200, parse error or timeout (5 s) → `null`;
   last `is_app` row's `status` (matches legacy "last row" quirk, `BGW:71-72`); cached 30 s (1 s for null).
5. Display: `CQS:126-133` row when `=== true`; message `CQS:135-140`; `CQS:141-145` "Cashback eligibility is
   unavailable. No cashback amount is promised." when null/unloaded; `BEN:76-83` "Eligible / Not eligible /
   Temporarily unavailable".

Differences:

- **Default**: legacy on (`TEN_PER_SWITCH=1`), rewrite off → with an unchanged environment the rewrite never
  shows the cashback row. P1.
- **Parse**: legacy `int(...)`; rewrite rejects `1`/`0`. P1 (deployment parity; `legacy-flags.md` rule).
- **CMS failure**: legacy → False ("User is not eligible for cashback"); rewrite → null ("Temporarily
  unavailable"). Display-only; P2 (rewrite is more conservative, no amount promised either way).
- **Message**: verbatim default preserved (`QD:4-5`, `CFG:48`). DONE.
- **When shown**: legacy also shows the row on a non-current page state; rewrite hides while a mutation is
  in flight or the quote is stale. Acceptable DIFFERENT.

#### Mandatory verification 4 — flag-gated blocks

`CFG` (`R/backend/src/config.ts`, 176 lines) contains none of `GLOBAL_SHOW_COUPON_MODULE`,
`GLOBAL_SHOW_PG_DISCOUNT_MODULE`, `ENABLE_OLD_PG_DISCOUNT`, `ENABLE_NEW_PG_DISCOUNT`,
`ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT`; repo-wide grep over `R/backend/src`, `R/frontend/src` finds no
reader (only `IN_HOUSE` in administration store categories `R/backend/src/modules/administration/contracts.ts:24`).
The checkout public state (`SVC:2168-2200`) returns no resolved booleans. `docs/plans/single-stack-schema-freeze.md:18-19`
and `backend/parity/legacy-flags.md:10-14` both still list these as required.

| Legacy block | Legacy condition | Rewrite gate | Rewrite UI | Status |
|---|---|---|---|---|
| Coupon (`CO:260-273`) | `show_coupon_module = GLOBAL_SHOW_COUPON_MODULE (int, default 1) or (store.category=="IN_HOUSE" and request.user.user_type==1)` (`V:1562-1566`) | none | `CR:1280-1314` always rendered when `editable`; `PUT coupon` / `POST coupon/removals` | MISSING — with default 1 behaviour matches; with `0` (franchise) rewrite wrongly exposes coupon entry |
| Voucher→money (`CO:287-301`) | `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` (int, default 0) | `GLOBAL_VOUCHER_CONVERSION_ENABLED` (`GVO:3-6,22`, `'true'/'false'`, default false) + `GLOBAL_VOUCHERS_ENABLED`, server `enabled()` (`R/backend/src/modules/global-vouchers/service.ts:108-119`) | `GVC:220` returns null when disabled | PARTIAL — gate exists under a different env name/parse; legacy name not honoured |
| PG module wrapper (`CO:302-374`) | `show_pg_discount_module` = `GLOBAL_SHOW_PG_DISCOUNT_MODULE (int, 1) or IN_HOUSE&&user_type==1` (`V:1567`) | none | `CR:1464-1557` always rendered | MISSING |
| Old PG discount (`CO:303-328`) | inside wrapper: `ENABLE_OLD_PG_DISCOUNT` (int, 1); role ∈ `PG_DISC_ROLE_PERM` else disabled + "You do not have permission." | none for flag; role server-side (`SVC:1351`, `POL:55`) | option "Payment gateway discount" `CR:1489` | MISSING (flag); PARTIAL (permission UX) |
| New Store discount(PG) (`CO:329-373`) | inside wrapper: `ENABLE_NEW_PG_DISCOUNT` (int, 1); no role gate | none for flag; role gate applied (stricter) | option "Store discount (PG)" `CR:1488` + reason select | MISSING (flag); DIFFERENT (role) |
| Summary "Store discount(PG)" row (`CO:480-485`) | **not** flag-gated | — | `CQS:90-93` always | DONE |

Also note: `user_type` is available client-side (`CNT:629` uses `user.userType`) and store `category`
exists in administration data, so the formula is implementable; it is simply absent.

---

#### Mandatory verification 5 — keyboard shortcuts

Legacy bindings (Mousetrap from `CO:902`; Mousetrap ignores keystrokes inside input/select/textarea by default):

| ID | Key | Legacy binding | Legacy behaviour / guard | `SC` row (verbatim) | Rewrite | Status |
|---|---|---|---|---|---|---|
| K-01 | P | `CO:1024-1029` | no-op if `#tbl-add-product-cart tr` ≤ 1, or `#btn-confirm-order` exists, or payment spinner visible; else clicks `#btn-proceed` | 2 "Press 'P' To Proceed For Payment" | `KS:28` → `[data-cashier-action~="proceed"]`: "Create order" `CR:1656`, or "proceed quote" targets (`CR:629, 655, 1571`) ; no-op if disabled (`KS:116`) | DIFFERENT — proceeds through quote steps instead of opening payment directly |
| K-02 | PP | **no binding** in `CO`/`TAB` (doc-only) | — | 3 "Press 'PP' To Proceed For Payment without extra steps(Fast) or Double click" | `KS:90-93` two P within 500 ms → `fast-proceed` → same target as P | DIFFERENT — rewrite implements a mapping legacy only documented; effect identical to P |
| K-03 | F | `CO:1032-1037` | same guard as P; **clicks** `#fast-checkout` | 4 "Press 'F' For Fast Cash" | `KS:29`; `FC:228` input **focused**, not clicked (`KS:119`) | DIFFERENT (P2) |
| K-04 | R | `CO:1040-1042` | `window.location.reload()` (any time) | 1 "Press 'R' To Refresh the Cart" | `KS:27` → `CR:611` "Refresh sale" (only inside review; no target on counter page) | PARTIAL — no-op outside review (P2) |
| K-05 | E | `CO:1045-1047` | clicks `.exclusive-benefits-switch` (no-op when disabled = user connected) | 6 "Press 'E' To Enable/Disable Exclusive Benifits" | `KS:31` → `CR:1318` | DONE (only inside review) |
| K-06 | N | `CO:1050-1052` | clicks both `.nps-feedback-switch` boxes — both disabled → effectively **no-op** | 5 "Press 'N' To Enable/Disable NPS Feedback" | `KS:30` → `CR:1101` toggles a real setting | DIFFERENT — rewrite N changes NPS (legacy cannot) (ties to A-04, P1) |
| K-07 | B | `CO:1055-1057` | focus `.prod-barcode` | 7 "Press 'B + Scan' the Product' To Focus/Add Product in Cart" | `KS:32` → `CNT:566` focus | DONE |
| K-08 | S | `CO:1060-1062` | focus `#salesperson` | 8 "Press 'S + Enter' To Select Salesperson From Dropdown" | `KS:33` → `SPA:40` focus (review only; SPA is inside `<details>`, revealed by `KS:100-108`) | DONE |
| K-09 | T | `TAB:242-244` (tab page, not create_order) | clicks `#create-new-tab` | 9 "Press 'T' To Create New Order" | `KS:34` → `CNT:662-666` "New sale" | DONE |
| K-10 | Reference page | `L/order/urls.py:57` `key-shortcuts/` → `V:3365-3367` `keyShortcutsView` → `SC:1-81` (title "{store_name} Keyboard Shortcuts", card "Keyboard Shortcuts For Billing Screen", columns "Sr. No", "Key", "Description"); linked from `TAB:134` "key Shortcuts" | always | — | `APP:53, 203, 504-506` `/shortcut-reference` "Shortcut reference" + `KH:2-48` (columns Key/Description; descriptions reworded `KS:16-25`) + counter `<details>` "Keyboard shortcuts" `CNT:544` | PARTIAL — descriptions not verbatim (P2) |
| K-11 | (extra) "Enable letter shortcuts" toggle | — | — | — | `KH:11-18`, `R/frontend/src/pages/cashier-shortcuts/preference.ts:1-61` (per-operator localStorage) | DIFFERENT — rewrite-only feature (P2; "no extra features" rule) |

---

#### Gaps

P0 — none proven inside this markup scope. Two items could become P0 depending on production env values
(UNKNOWN; not in the repo): A-42/A-45/A-46 flag gating if production sets `GLOBAL_SHOW_*=0` or
`ENABLE_*_PG_DISCOUNT=0` (rewrite would expose discount/coupon entry the business disabled for franchise
stores); confirm env before release.

P1 — visible behaviour missing or changed:

1. **GLOBAL_SHOW_COUPON_MODULE / GLOBAL_SHOW_PG_DISCOUNT_MODULE / IN_HOUSE+user_type==1 override not
   implemented** (A-42, A-45, A-46; context `show_coupon_module`, `show_pg_discount_module`;
   `V:1562-1567` vs `CR:1280-1314, 1464-1557`, no reader in `CFG`).
2. **ENABLE_OLD_PG_DISCOUNT / ENABLE_NEW_PG_DISCOUNT not implemented** — rewrite always offers both kinds
   (A-45, A-46; `CO:303, 329` vs `CR:1486-1490`).
3. **TEN_PER_SWITCH default and parse differ** — legacy default on (`S:542`), rewrite default off and
   rejects `1` (`BGW:5-13,79`, `.env.example:288`) → cashback row/eligibility hidden by default (A-65, A-75,
   section 3).
4. **NPS feedback**: legacy always sends `nps_feedback_switch=true` (checked+disabled box, `CO:76`,
   `CO:5646`); rewrite defaults `npsFeedback:false` (`SVC:648`) and adds user toggles incl. an SMS opt-out
   (`CR:1077-1120`) (A-04, K-06).
5. **Store discount(PG) role gate stricter** — rewrite requires `PG_DISC_ROLE_PERM` for store-PG apply and for
   any removal (`SVC:1351`); legacy only disables old-PG apply in UI (`CO:310-321`) and `V:2237` has no role
   check (A-46).
6. **Old-PG permission UX missing** — no disabled state / "You do not have permission." title (A-45).
7. **Gift-card dates mandatory** — empty start ("Today's") / empty end ("No Expiry") not allowed
   (`GCI:77-98` vs `CO:205-206`) (A-32, A-33).
8. **Gift voucher PIN mandatory up-front** — legacy first applies with `gc_pin:0` and prompts "GC PIN" only
   when needed (`CO:3433-3557` vs `CR:1428-1438`) (A-43).
9. **Voucher→money**: legacy env name `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` not honoured (renamed
   `GLOBAL_VOUCHER_CONVERSION_ENABLED`, different parse); separate "Check" balance step missing (A-44).
10. **Verified state not displayed** — "User is verified !" / "Verify the user to use Tss Money/Points/Voucher !"
    absent (A-41).
11. **TSS Points / Money toggles** — no immediate apply-on-toggle, no reflection of applied state, no
    `balance > 0` gating, no used/total badges, no "(Partial Money Applied)" (A-49, A-50, A-51).
12. **Applied values not prefilled** — coupon code, voucher code, PG/store-PG amounts, applied TSS money
    (`CO:265, 279, 309, 335, 442` vs empty `useState('')` in `CR`) (A-42, A-43, A-45, A-46, A-51).
13. **Online-order handoff** — 10-min `JWT_CUSTOM_EXPIRY_MIN` vs 300 s, explanatory text missing, extra
    consent/prepare steps, feature off by default (`WHO:15,29`) (A-81, context `online_order_sesion_expire`).
14. **Customer-insights store gate only server-side** — button rendered for disallowed stores (A-80, A-94).
15. **Inventory columns** — Barcode, Spl. Price, Ex. Price, Holded Stock, Storages Stock not shown (A-93).
16. **Behaviour "Data Insights" preferences** (Preferred Categories, Monetary Preference, Preferred Sizes,
    Preferred Artist/Tags/Color) not shown anywhere (A-90) — confirm the source endpoint still returns them.
17. **Cart-read failure messages** — "We have a little problem, please try again later !" missing; upstream
    `title` pass-through UNKNOWN (context guards).
18. **Ordinary-line quantity/remove inside review** not available after import (A-17, A-20) — confirm with
    B/C whether closing the review and editing the draft is an accepted equivalent.

P2 — cosmetic / wording:

19. Summary labels differ: "Discount (excluding coupon)", "Total before rounding", "Rounding value" (no "-"
    prefix), "Official payable", TSS Points with ₹ (A-54, A-56, A-62, A-63, A-64).
20. Discount row relabel to "Membership Savings" when a membership product (prod_type 5) is in the cart
    missing (A-54, `CO:2509-2520`).
21. Connected/not-connected banner wording and content (A-01, A-02); "Freebie" badge (A-21); complimentary
    link uses parent id (A-22) and spl price (A-24); sale-price fallback (A-16); SKU display (A-13).
22. Items count excludes gift cards and complimentary qty (A-08, `total_item_cart`).
23. Salesperson "Not Selected" reset impossible (A-06, A-18).
24. Exclusive grey background (A-38); B2C/B2B labels "Individual"/"Business" (A-70); exclusive/cashback
    status wording and default-collapsed cards (A-09, A-73, A-75); "Please connect the user first." (A-83).
25. Shortcuts: F focuses instead of clicking (K-03); R inactive on counter page (K-04); reference text not
    verbatim (K-10); extra "Enable letter shortcuts" preference (K-11).
26. Inventory explicit reload button absent (A-91); auto-open insights after Connect absent (A-79).

Accepted/neutral differences (not gaps unless the user rules otherwise): stricter store/check-in/counter
authorization (context guard row); token kept server-side; storefront-account error wording; summary hidden
for non-current quotes; CMS failure shown as "unavailable".

UNKNOWN: production values of all flags; upstream `title` propagation; `payment_mode` labelling; whether
per-line salesperson defaults are persisted at order time; GC custom-value controls' legacy origin (A-34b).

---

## Part B — create_order.html inline JS part 1 (lines 901–4060) parity gap spec

Scope: `L/order/templates/order/create_order.html:901–4060` (custom-script block start through voucher-to-money check/convert, ending before the first `ajax-pg-discount` call at :4069) and the server views those calls hit.
Legacy: `L` = pinned copy `legacy-78d5b63`. Rewrite: `R` = `pos-rewrite-single-stack` worktree (branch `refactor/single-stack-schema-freeze`, HEAD `3a3acc9` plus uncommitted work by other agents; `CheckoutReview.tsx` line numbers moved during this read and are a snapshot).
Excluded by instruction: screening, cash-return intents, CSV import, SSO, demo mode.

Common legacy facts used below:
- `toast_message(msg,type)` is defined at `create_order.html:7906`; `email_popup()` at `:7926`; `ButtonStateManager` at `:8105` (outside this range).
- Upstream base: `MIGRATION_TO_API_V2` (`POSAdmin/settings.py:666`, default 0) selects `MAIN_API_V2_URL + '<path>'` vs `API_V2_URL + 'pos/<path>'` for cart paths. Rewrite mirrors it with `cartPath = options.migrationV2 ? 'cart' : 'pos/cart'` (`R/backend/src/modules/checkout/service.ts:115`).
- `is_verified` (template context, `order/views.py:1526–1533`) comes from Redis `{user_id}_{tab_id}`. Every wallet/GV AJAX call sends it as a **client-supplied** form field; the server trusts it.
- Every cart-refresh success handler repeats the same totals block (for example `:1617–1700`): `discount = total_savings - coupon_discount` (JS float, `toFixed(2)`), `total_payable_round = rounding_off + total`, `.member-savings = isExclusiveUser ? exclusive_savings : discount`, plus the `#tssmoney` text `used/total` (where `total_tss_money === 0` falls back to the template's rounded-down `user_obj.tss_money`), `#tsspoints` (`used/total`) and `#custom_tss_money_field` set to "(Partial Money Applied)". The rewrite uses backend `quoteDisplay` and `CartQuoteSummary` (`R/frontend/src/pages/checkout/CartQuoteSummary.tsx:63–110`). See `R/backend/parity/checkout-summary-controls.md`.

#### Controls and AJAX calls (JS part 1)

| ID | Control / call (type) | Legacy file:line | Visible/enabled when | Endpoint: request -> response fields | Validation / messages (verbatim) | Rewrite file:line | Status — note |
|---|---|---|---|---|---|---|---|
| B-01 | Key `P` → click `#btn-proceed` (Mousetrap) | create_order.html:1024–1029 | Ignored if `#tbl-add-product-cart tr` ≤1, `#btn-confirm-order` exists, or `#spinner-border-payment` is visible | — | — | R/frontend/src/pages/cashier-shortcuts/shortcuts.ts:26–33,90–92 | DIFFERENT. `p` is mapped. The rewrite adds a "PP" double-press `fast-proceed` that the legacy page does not have (extra behaviour). |
| B-02 | Key `F` → click `#fast-checkout` | :1032–1037 | Same guard as B-01 | — | — | shortcuts.ts:29 | DONE |
| B-03 | Key `R` → `window.location.reload()` and spin icon | :1040–1042 | always | — | — | shortcuts.ts:27 (`refresh`) | DONE. Semantics differ (refresh the sale vs full page reload); acceptable. |
| B-04 | Key `E` → `.exclusive-benefits-switch` click | :1045–1047 | No-op when switch disabled (customer attached, :86–88) | → B-47 | — | shortcuts.ts:31; CheckoutReview.tsx:1318 (`data-cashier-action="toggle-exclusive"`) | DONE |
| B-05 | Key `N` → `.nps-feedback-switch` click | :1050–1052 | Both legacy `.nps-feedback-switch` inputs are `disabled` (:76, :115–118), so the legacy key is effectively a **no-op** | — | — | shortcuts.ts:30 (`toggle-nps`, which toggles the feedback link) | DIFFERENT. The rewrite key changes state; the legacy key does nothing. |
| B-06 | Key `B` → focus `.prod-barcode` | :1055–1057 | always | — | — | shortcuts.ts:32; counter.tsx:566 | DONE |
| B-07 | Key `S` → focus `#salesperson` | :1060–1062 | always | — | — | shortcuts.ts:33; SalespersonAssignments.tsx:39–40 | DONE. The rewrite also adds key `T` (new sale), which is not in the legacy page (extra behaviour, P2). |
| B-08 | Customer-type B2B/B2C toggle; shows/hides `#gstin-box-update`; B2C clears GSTIN | :910–939 | always; initial state from `#customer_type` | — | — | R/frontend/src/pages/customer-insights/editor.tsx:165–190 | PARTIAL. Only in the post-attach profile editor; nothing before Fetch/Connect. |
| B-09 | GSTIN input sanitizer: uppercase, strip non `[0-9A-Z]`, cap at 15 | :2844–2851 | always | — | — | customer-insights/client.ts:38–43 (trim/upper/regex at submit) | DIFFERENT (P2). Validated at submit, not sanitized live. |
| B-10 | PG remark draft persisted in `localStorage["pgRemark"+tab_id]` and pre-filled | :942–959 | `#pg-remark` present (`show_pg_discount_module && enable_old_pg_disc`, :302–321) | — | — | CheckoutReview.tsx:117, :1503 (React state only); backend persists `discountMetadata` only on apply | MISSING (P2). A typed but unapplied remark does not survive reload. |
| B-11 | Initial enable of `#applied_tss_money` and `#tss-money-apply` when `#tssmoneyswitch` is checked | :962–976 | `user_obj and is_verified and user_obj.tss_money > 0` | — | — | CheckoutReview.tsx:1372–1389 (amount enabled by `walletMoney`; button by verification) | PARTIAL. No `tss_money > 0` balance gate. |
| B-12 | Gift-card date pickers (daterangepicker: single date, `minDate: new Date()`, `MM/DD/YYYY`, "Clear" → empty) | :978–1014; re-init :1484–1513, :2050–2080 | gift-card rows present | → B-32/B-33 | Placeholder "Today's" (start), "No Expiry" (end) | GiftCardItems.tsx:78–99 (`type=date`, min `0001-01-01`, both `required`) | DIFFERENT (P1). Rewrite accepts past dates and cannot express "No Expiry" (blank end) or "Today's" (blank start). |
| B-13 | `#include_oos` checkbox reloads the DataTable | :1064–1068 | always | → B-26 `include_oss_toggle` | — | counter.tsx:602–605 ("Show out of stock") | DONE |
| B-14 | User-behaviour tab `getUserData()` → `ajax_user_behaviour` | :1072–1172 (url :1076); trigger `#get-user-data` :679 | `user_obj` present | POST `{email, user_obj}` → `{status:200, message:"date fetched", data:{firstname, lastname, email, telephone, gender, birthday, anniversary, tss_money, tss_points, created_at, exclusive_detail, exclusive_savings, get_no_of_gv_count, last_month_orders, total_orders, cancelled_orders, returned_orders_count, returned_orders, total_store_orders, total_online_orders, nps_score, last_5_orders}}` | 401 → toast `data.message`; else toast `data.data.title` (404/400 have no `data`, so the legacy JS throws). Labels "Exclusive User Till  <date>", "Non Exclusive User" | CheckoutReview.tsx:994 (`CustomerInsights`), :1008 (`CustomerBenefitsCard`), :1027 (`CustomerHistoryCard`); customer-insights/history.tsx:170–237; benefits-client.ts:8–21 | DONE (split across 3 cards; history via BigQuery reader). Lookup key differs: legacy uses **email**, rewrite uses the attached customer ID. |
| B-15 | "Last 5 Orders" dialog | :1179–1218 | `user_obj` (:741–743) and `last5Orders.length>0` | from B-14 `last_5_orders[{id, order_amt, created_at, order_statuses, is_store_order}]` | Cols: Order ID (link `/orders/{store\|online}/{id}/show/`), Date, Order Amount, Feedback ("View Feedback" if `order_statuses==3`, else "NA") | customer-insights/history.tsx:192–237 | DONE |
| B-16 | "Returned Orders" dialog | :1219–1256 | `returned_orders_count>0` | from B-14 `returned_orders[{id, order_amt, pay_amt, cart, items_string, is_store_order}]` | Cols: Order ID, Order Amount, Item Info | history.tsx:240–316 (paginated, item names) | DONE |
| B-17 | "Add" birthday / anniversary / gender → `postUserProperty` → `ajax_update_user_data` | :1257–1359 (url :1337) | Field shows "Add" only when value is "-" (add-only; existing values not editable) | POST `{user_id, user_property∈birthday\|anniversary\|gender, property_value}` → `{status, message}` | Titles "Birthday"/"Anniversary"/"Gender"; "Add Customer Birthday" etc.; gender options "Select Gender", Male(M)/Female(F)/Others(O); server: "User ID not in payload", "Property not in payload", "Invalid property choice", "User not found", "User details updated"; shown via `$.alert`. Legacy bug: status inverted and async, so the cell never updates | customer-insights/editor.tsx:29–190; client.ts:26–45 (`profileChanges`) | DIFFERENT (P2). Rewrite also edits existing values and adds customerType/GSTIN; messages differ. |
| B-18 | Barcode scanner capture: keyup on `#prod-barcode`, Enter submits field value, keystroke buffer reset after 2 s; `BarcodeFieldActive()` re-enables field | :1361–1379; HTML :125–128 (mask `9999999999999`) | always | → B-19 | — | counter.tsx:566 (search/scan input); counter-catalog/barcode.ts:8–13 (`canonicalBarcode`), :15–56 | DIFFERENT. Rewrite resolves the barcode against the catalog and adds to the **local draft**, not the upstream cart. Messages: 'Enter a valid numeric barcode.', 'This product is out of stock.', 'This barcode was not found.' |
| B-19 | `handleBarcode` → `ajax-cart` opr=add by barcode | :1380–1724 (url :1385) | field enabled; disabled during call | POST `{store_id, product_id:0, barcode, opr:"add", tab_id, auth_token, end_user:(user_obj?1:0)}` → `{status:"success", message, data:<upstream cart {products, giftvouchers, complementary_products, meta}>, extra:{exclusive_product, total_item_cart}}` | Success: green field, toast "Product Added Succesfully"; fail: red field, toast `data.message` (server: "Please Provide Barcode", "Invalid Barcode! Product Not Found.", "Product Barcode Missing.", upstream `title`/`message`, "Something went wrong", "Something Went Wrong, Please Try Again"); field reset after 500 ms | counter-catalog/barcode.ts:57–80 (`addProduct`); checkout import via `draft-initializations` (CheckoutReview.tsx:~411); service.ts:446–520 (`changeLine` → `pos/product` add) | DIFFERENT. Draft-first architecture; upstream add happens at checkout import. OOS is rejected client-side, while legacy defers to upstream. |
| B-20 | Gift-card row render (from cart `giftvouchers.items`) | :1409–1516, :1979–2081 | `giftvouchers.items` non-empty | fields `prod_id, parent_prod_id, product, price, gv_id, gift_card_no, gift_card_start_date, gift_card_end_date` | Header "Sku Id, Gift Card Name, Price, Serial No, Start Date (MM/DD/YYYY), End Date (MM/DD/YYYY), Action"; serial placeholder "Scan/Enter Serial No.", mask 20 digits. Legacy defect: JS-rendered date inputs omit `gv-id` (:1459–1460), so B-32/B-33 post an empty `gv_id` until the page reloads | GiftCardItems.tsx:28–198 | PARTIAL. Combined number+dates form; "Card value", "One card", custom value; no SKU column. |
| B-21 | Product row render | :1518–1572, :2084–2146; server-rendered :151–163 | `products.items` | `prod_id, parent_prod_id, product, price, spl_price, exclusive_price, stock, quantity, sales_person, prod_type` | Sale price = `spl_price` if ≠0, else `exclusive_price` if `exclusive_user.active` and >0, else `price`; qty input `min=0`; per-row salesperson select2 ("Not Selected"=0); trash button | CheckoutCartLines.tsx:63–108 | PARTIAL. Read-only list: shows unit/sale price as supplied; no client exclusive-price derivation; **no qty input, no Remove, no inline salesperson** for ordinary lines (see B-35, B-38). |
| B-22 | Complimentary/freebie row render | :1573–1615 (row :1601), :2148–2190 (row :2175); server-rendered :165–176 | `complementary_products.items` | `prod_id, product, price, quantity, prod_type, sales_person` | "Freebie" badge; link `/products/<cp_id>/show/`; Price and Sale Price both = `price`; qty `readonly` (`cp-qty-readonly`, `stock="0"`); salesperson select; Remove button active | CheckoutCartLines.tsx:63–108 (label "Complimentary · Quantity N", :78; Remove :91–105) | DONE. Label "Complimentary" vs "Freebie" (P2). Per-line salesperson moved to SalespersonAssignments (B-34). See dedicated subsection. |
| B-23 | Totals / wallet badge refresh from `meta.items` | :1617–1700 (repeated in every success handler) | — | `calculations{coupon_discount, total_savings, exclusive_savings, gst_total, total, rounding_off, products_total, gift_voucher_value, used_pg_discount, used_store_discount_pg, used_tss_points, used_tss_money, app_cashback}`, `tss_money{used_tss_money,total_tss_money,custom_tss_money}`, `tss_points{used_tss_points,total_tss_points}` | "(Partial Money Applied)" | CartQuoteSummary.tsx:63–110; backend `quoteDisplay` | PARTIAL. Amounts shown, but no `used/total` badges and no "(Partial Money Applied)" marker (P2). Legacy float math is replaced with exact decimals (intended). |
| B-24 | Membership product + placeholder email → `email_popup()` | :1708–1713, :2275–2278 | `extra.exclusive_product` and `"temp.id" in user_obj.email` | — | (popup content at :7926, out of range) | UNKNOWN. `temp.id` convention referenced in R/backend/src/modules/customer-contacts/references.ts:25–28 | UNKNOWN. No trigger on adding a membership product found in checkout. |
| B-25 | Empty-cart placeholder; hides `#btn-proceed`/`#fast-checkout` | :1730–1739; :2721–2730 | no product rows and no gift-card rows | — | "Hi <operator first name>, I am empty … Add something … to make me happy." | counter.tsx (empty draft state) | DIFFERENT (P2). Different copy. |
| B-26 | Products DataTable (server-side) | :1741–1842 (url :1770) | always | POST DataTables params + `{store_id, include_oss_toggle, csrf}` → `{draw, recordsTotal, recordsFiltered, data[{id, p_pid, product, prod_type, erp_product, barcode, stock, holded_stock, price, storage_stock, spl_price, exclusive_price, DT_RowId, ParentProductId}]}` | Search label "Search By Sku/Name/Barcode:"; page sizes 5/10/25; rows: stock≤0 antiquewhite; barcode cell "Barcode Missing \n (Please ask administrator to set barcode)"; held>0 green; storage text "Not available in any storage" | counter.tsx:59–124 (`ProductTile`), :141, :225; R/frontend/src/hooks/use-pos.ts:161–183 (`/catalog/products?search&after&includeOutOfStock`) | PARTIAL (P1). Tiles omit spl_price, exclusive_price, held stock, storage stock, barcode and the barcode-missing marker; cursor paging, not 5/10/25. |
| B-27 | Search debounce: 400 ms, fire only if ≥3 chars or empty | :1844–1857 | — | DataTable search | — | counter.tsx:142 (`useDeferredValue`) | DIFFERENT (P2). No 3-char minimum and no 400 ms debounce. |
| B-28 | "Inventory" reload `#co-table-reload` | :1861–1865; HTML :776 | always | DataTable reload | — | react-query refetch (no explicit button found) | PARTIAL (P2) |
| B-29 | Troubleshoot product → `ajax-troubleshoot-product` | :1867–1887 (url :1872); render :1820–1823 | Every operator; row `stock>0` and barcode present; button disabled in flight | POST `{product_id}` → `{status:200, message}` | "Troubleshooting started for the Product, Just wait for a few seconds" (always, even on exception) | counter.tsx:113–122, :629 (link only for `role===1 && userType===1`); R/backend/src/modules/catalog-details/maintenance-routes.ts:50–72 (preview/apply) | DIFFERENT (P1). Role-restricted, separate preview/apply page. Legacy side effects (unhide parent, default images_new, rename duplicate GTIN to `<gtin>0123`, product sync) must be compared in the catalog fragment. |
| B-30 | Add-to-cart button; gift card (prod_type 8) custom-value dialog | :1820–1825, :1889–1951 | `stock>0 && barcode!="Barcode Missing"`, else disabled with title "Not valid product for billing" | → B-31 with `custom_gc_value` | Title "Gift Card!"; "Enter Desired Gift Card Value"; "The value of the Custom Gift Card must fall within the range of 1 to 10000."; "Please Provide Valid Value"; "Value Should be 1 to 10000"; buttons "Submit Desired Value", "Add Original Value <price>", "Back" | counter.tsx:70–76 (tile disabled when `stock<=0`); GiftCardItems.tsx:104–140 (value later); routes.ts:446–466 (`gift-card-items` add with `customValue` 1..10000), :468 (`/value`) | PARTIAL (P1). No value prompt at add time; the custom value is set afterwards in checkout. Tile is not disabled for a missing barcode (backend rejects with "This product has no barcode."). |
| B-31 | `AddToCartFunc` → `ajax-cart` opr=add by product_id | :1952–2290 (url :1956) | — | POST `{store_id, product_id, custom_gc_value, opr:"add", tab_id, auth_token, end_user}` → same as B-19 | toast "Product Added Succesfully"; fail toast `data.message` | service.ts:446–520; upstream.ts:17–19 (`addCartPayload`) | DIFFERENT. Draft-first; see B-19. |
| B-32 | Gift-card start date change → `ajax-save-gc-date` | :2294–2312 (url :2299) | gift-card rows | POST `{gv_id, start_date}` → `{status:"success", message:""}` | none shown | GiftCardItems.tsx:57–101 → `PUT …/gift-card-items/:giftId` (routes.ts:418–435) | DIFFERENT. Saved together with number and end date; see subsection. |
| B-33 | Gift-card end date change → `ajax-save-gc-date` | :2314–2332 (url :2319) | same | POST `{gv_id, end_date}` → same | none | same | DIFFERENT. Same as B-32. |
| B-34 | Per-product salesperson → `ajax-add-salesperson-per-product` | :2334–2375 (url :2341) | Every product, gift-card and complimentary row | POST `{store_id, tab_id, productid, salesperson}` → `{status:200, message, is_added, is_removed, is_not_valid, master_salesperson_data}` | "Salesperson Added Successfully", "Salesperson Removed Successfully", "Please Select Valid Salesperson"; if `master_salesperson_data≠0`, sets `#salesperson` and triggers change (cascades to B-39) | SalespersonAssignments.tsx:36–66, :88–94; routes.ts:538–552; service.ts:1382–1440 | PARTIAL (P1). No removal ("Not Selected"=0); no master auto-sync; stricter store/active validation (legitimate). |
| B-35 | Quantity change → `ajax-cart` opr=set | :2377–2497 (url :2383) | Ordinary rows (complimentary rows are readonly) | POST `{store_id, product_id, opr:"set", qty, tab_id, auth_token, end_user}` → cart | toast "Quantity Updated Succesfully"; fail toast `data.data.title` and reset qty to 1; UI clamps the input to `stock` | routes.ts:345–354 (`PUT line-items/:productId`, 0..999) exists; **no checkout UI**; counter-catalog/quantity.tsx (draft only) | MISSING (P1). Once a checkout session exists, editing the draft raises "This checkout has a different saved review snapshot…" (CheckoutReview.tsx:133–137). |
| B-36 | `updateDiscountLabel`: label "Membership Savings" when cart has prod_type 5, else "Discount"; restored on load | :2509–2520 | `#discount-label-text` exists only for non-members | — | "Membership Savings" / "Discount" | CartQuoteSummary.tsx:67–86 (by customer membership; "Discount (excluding coupon)") | DIFFERENT (P2). Not keyed on a membership product in the cart. |
| B-37 | Gift-card serial check `.check-gc` → `ajax-check-save-gc` | :2522–2563 (url :2533) | gift-card rows | POST `{gift_barcode, gv_id, tab_id}` → `{status:bool, message}` | Client: "Please enter serial no."; see endpoint block for server messages. Legacy bug: missing data returns `status:"failed"` (truthy), so the page shows a green success toast "Please provide data" | GiftCardItems.tsx:57–101; service.ts:1201–1265; checkout/gift-cards.ts:15–82 | DIFFERENT. See subsection. |
| B-38 | Remove (product / gift card / freebie) → `ajax-cart` opr=delete | :2565–2738 (url :2583) | Every row | POST `{store_id, product_id, gv_id(null→""), opr:"delete", tab_id, auth_token, end_user}` → cart | toast "Product Removed Succesfully"; fail "Something Went wrong" | Freebie: CheckoutCartLines.tsx:91–105; gift card: GiftCardItems.tsx:155–163 → routes.ts:437–445; ordinary product: **none** | PARTIAL. Freebie DONE; gift card DONE; ordinary product MISSING (P1) — same reason as B-35. |
| B-39 | Order-level salesperson `#salesperson` → `ajax-add-salesperson` | :2740–2770 (url :2747); HTML :92–101 | always (select2, "Not Selected"=0) | POST `{store_id, tab_id, salesperson}` → `{status:200, message, is_added, is_removed, is_not_valid}` | Same 3 messages as B-34; also sets every per-product select to the same value | SalespersonAssignments.tsx:85; service.ts:1382–1440 | DIFFERENT (P1). Rewrite does not overwrite existing line assignments and has no removal. |
| B-40 | `#add-number-span` shown when connected user lacks a telephone | :2773–2781 | `user_obj` present | — | — | UNKNOWN (customer-contacts module) | UNKNOWN |
| B-41 | Update user (B2B/GSTIN) `#update-user` → `ajax_update_user` | :2854–2905 (url :2886); button hidden until Fetch succeeds (:641, :2955) | After Fetch | POST `{user_id, name, telephone, email, customer_type, gstin}` → `{status, message}` | "GSTIN is mandatory for B2B customers"; "Please enter a valid GSTIN (15 character alphanumeric)"; server "User updated successfully+++." / "Something went wrong: <exception>" | customer-insights/editor.tsx:94–106 | DIFFERENT (P2). Message "Choose a valid change. Business customers need a 15 character GSTIN."; only after attach. |
| B-42 | Fetch the User `#user-fetch-form` → `ajax_user_details` | :2907–2984 (url :2921) | always | POST `{telephone, email, tab_id}` → `{status, message, data:{data:{user_id, name, telephone, email, customer_type, gstin}}, exclusive_detail(JSON string {member, expiry, message}), discount_eligibility}` | "Exclusive User Till  <date>" / "Non Exclusive User" + membership message; "User Is Eligible For Cashback" / "User is not eligible for cashback"; error toast `data.message` and name set to "User Not Selected" | routes.ts:229–243 (`customer-lookups`); service.ts:749–761; CheckoutReview.tsx:1122–1163 | DIFFERENT (P1). Direct DB search (active only), not upstream `check-user-exclusive`; no pre-attach exclusive/cashback display; query format restricted to email or 10–15 digits. |
| B-43 | Connect the User `#sync-cart-form` → `ajax-sync-cart` | :2986–3033 (url :2998) | `#sync-cart` visible after Fetch or if `user_obj` | POST `{user_id, tab_id, store_id, auth_token, is_cart_sync:(user_obj?0:1)}` → `{status, message, data:{}}` | "Cart has been Synced"; else `data.message` or "Cart not Synced"; ajax fail "Connect User Failed, Please Try Again"; server "Could not read cart, Please Try Again", "Cart Sync Failed, Please Try Again", "Cart Synced"; 10 s timeout; on success page reload | routes.ts:245–252 (`PUT …/customer`); service.ts:762–850 | DIFFERENT (P1). Sync+clear matches. Rewrite forbids switching to another customer ("Start another sale to change the customer.") where legacy re-points the tab (`is_cart_sync=0`). |
| B-44 | TSS Money "Apply" (desired/partial) `#tss-money-apply` → `ApplyTssMoney(1)` → `ajax-wallet` | :3035–3173 (url :3057); HTML :437–446 | `user_obj && is_verified && tss_money>0`; button disabled while in flight | POST `{store_id, tab_id, tss_money_applied, tss_points_applied, applied_tss_money(float), custom_tss_money:1, auth_token, is_verified, user_obj}` → `{status:200, message:"Wallet", data:<upstream cart or error {title}>}` | Upstream `data.title` → warning toast and switch unchecked (which fires B-45 removal); success "Applied/Remove"; 401 → "Unauthorized action"; else `data.data.title` | CheckoutReview.tsx:1341–1390; routes.ts:382–394; service.ts:1157–1178; payloads.ts:31–45 | PARTIAL. See wallet subsection. |
| B-45 | TSS Money switch `#tssmoneyswitch` change → `ApplyTssMoney(0)` | :3175–3177 | same as B-44 | same, with `custom_tss_money:0` | same | CheckoutReview.tsx:1356–1362 (checkbox only; needs "Use wallet" submit) | DIFFERENT (P1) |
| B-46 | TSS Points switch `#tsspointsswitch` → `ajax-wallet` | :3320–3431 (url :3330); HTML :376–402 | `user_obj && is_verified && tss_points>0` | POST same fields **without** `custom_tss_money` (server default 0) → same | success "Applied/Remove"; else `data.data.title`; on failure the switch is unchecked | CheckoutReview.tsx:1364–1370 | DIFFERENT (P1). Initial checkbox state is not synced to the cart. |
| B-47 | Member Benefits switch `.exclusive-benefits-switch` → `ajax-exclusive-benefits` | :3179–3318 (url :3189); HTML :79–90 | Enabled only when **no** customer is attached; checked if `meta.exclusive_user.active` | POST `{store_id, tab_id, is_exclusive_benefits, auth_token}` → `{status:200, message:"Wallet", data:<upstream cart>}` | success "Applied/Remove" (also reprices each row and greys `#exclusive-color`); else `data.data.title` | CheckoutReview.tsx:1315–1338; routes.ts:407–416; service.ts:1321–1333; payloads.ts:83–87 | DONE. Label "Apply walk-in member benefits" vs "Member Benefits" (P2). |
| B-48 | Gift voucher Apply `#gift-voucher-apply` → `ajax-gift-voucher` | :3433–3675 (url :3437); HTML :274–285 | Input enabled iff `user_obj && is_verified`; Apply button itself never disabled | POST `{store_id, tab_id, voucher_code, gc_pin:0, auth_token, is_verified, user_obj}` → `{status:<upstream HTTP>, message:"Gift Voucher", data:<upstream body>}` | 200 + `data.meta` → "Applied/Remove"; 400 + `data.is_pin_required` → B-49; 401 → `data.message` ("Not Authorized"); else `data.data.title` | CheckoutReview.tsx:1410–1450; routes.ts:396–406 (`pin` regex `^[\d_]{4,20}$`, required); service.ts:1180–1199; payloads.ts:78–82 | DIFFERENT (P0). PIN is mandatory up front; legacy sends `gc_pin:0` and prompts only when upstream asks. |
| B-49 | GV PIN dialog (6-digit mask) → `ajax-gift-voucher` with `gc_pin` | :3527–3670 (url :3563) | upstream `is_pin_required` | same + `gc_pin` | "Please Enter the GIFT CARD PIN"; placeholder "Enter 6 Digit PIN"; "Please Provide a Valid PIN"; success "Gift Card Has Been Applied"; invalid → `data.data.title` (danger + inline); else warning `data.data.title` | CheckoutReview.tsx:1428–1440 ("Gift voucher PIN", password field, max 32) | DIFFERENT (P0). Same item as B-48. |
| B-50 | Gift voucher Remove `#gift-voucher-remove` → `ajax-cart` opr=delete platform=remove-gf | :3677–3784 (url :3679) | always (not gated on verification) | POST `{store_id, product_id:0, opr:"delete", platform:"remove-gf", tab_id, auth_token, end_user}` → server message "Gift Voucher Removed." | success requires `message==="Gift Voucher Removed."` → "Applied/Remove" and input cleared; 401 → `data.message`; "Please provide the voucher code" branch; else `data.data.title` and input cleared | CheckoutReview.tsx:1451–1460; routes.ts:371–380; service.ts:1142–1155; payloads.ts:66–77 | DONE |
| B-51 | Voucher **Check** `#gift-voucher-check` → `ajax-gift-voucher-check` | :3786–3919 (url :3790); HTML :287–301 | `enable_voucher_to_money_check_and_convert` (env `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT`, default 0); input enabled iff `user_obj && is_verified` | POST `{user_id, gift_voucher_code, gc_pin:0, user_email}` → `{status:<upstream HTTP>, message:<upstream JSON {voucher_value, voucher_validity, title…}>}` | Dialog "Gift Voucher/Card Details": "Here is the datail of your Gift Voucher/Card", "Your Voucher have -> ₹<value>", "This voucher is valid till -> <date>" or "This Coupon Won't Expire" (validity `0000-00-00`); toast "Gift Voucher Data Fetched"; 401 → `data.message`; else `data.message.title` | none | MISSING (P1). No balance/validity preview. Flag not in rewrite config. |
| B-52 | Check PIN dialog | :3824–3910 (url :3861) | upstream `message.title.is_pin_required` | same + `gc_pin` | "Please Provide a Valid PIN"; "Gift Card Data Fetched"; invalid → `message.title.title` | none | MISSING (P1) |
| B-53 | Voucher **Top-up** (convert to TSS Money) `#gift-voucher-convert` → `ajax-gift-voucher-convert` | :3921–4060 (url :3958) | same flag/gating as B-51 | POST `{user_id, gift_voucher_code, gc_pin:0, user_email}` → `{status, message:<upstream JSON>}` | Empty → "Please enter a valid voucher code"; confirm "Are You Sure You Want To Top Up All Of This Gift Voucher/Card To TSS Money", "Voucher Code -> <code>", "Confirm"; success → reload + "Gift Voucher Amount Has Been Transfered To User's TSS Money"; 401 → `data.message`; else `data.message.title` | R/frontend/src/pages/global-vouchers/conversion.tsx:222–338 (mounted CheckoutReview.tsx:966); api.ts:83–98; R/backend/src/modules/global-vouchers/index.ts:78–110, service.ts:108–118, 320–335, 740–840 | DIFFERENT (P1). Native DB conversion requiring an OTP-verified customer, gated by `GLOBAL_VOUCHERS_ENABLED` + `GLOBAL_VOUCHER_CONVERSION_ENABLED` + contracts + secret, not the legacy flag; no upstream `gift_voucher_to_tss_money`. |
| B-54 | Top-up PIN dialog | :3976–4046 (url :4013) | upstream `is_pin_required` | same + `gc_pin` | "Please Provide a Valid PIN"; success requires `message.status` → reload + "Gift Card Amount Has Been Transfered To User's TSS Money" | conversion.tsx:296–308 ("Gift card PIN, if required") | DIFFERENT. Optional PIN up front instead of a prompt. |
| B-55 | Performance timing JSON (`product_main_list`, `user_behaviour`, `add_to_cart`, `proceed_to_payment`) | :1016–1021, :1167–1169, :1715–1717, :1749–1754 | — | consumed later (out of range) | — | R/frontend/src/offline/performance/*; counter.tsx:35 (`recordPerformancePhase`) | PARTIAL. Field-level mapping UNKNOWN. |

Counts (per row, primary status, 55 rows):
- DONE 12: B-02, B-03, B-04, B-06, B-07, B-13, B-14, B-15, B-16, B-22, B-47, B-50
- PARTIAL 12: B-08, B-11, B-20, B-21, B-23, B-26, B-28, B-30, B-34, B-38, B-44, B-55
- MISSING 4: B-10, B-35, B-51, B-52
- DIFFERENT 25: B-01, B-05, B-09, B-12, B-17, B-18, B-19, B-25, B-27, B-29, B-31, B-32, B-33, B-36, B-37, B-39, B-41, B-42, B-43, B-45, B-46, B-48, B-49, B-53, B-54
- UNKNOWN 2: B-24, B-40

#### Endpoint details

**AjaxCartView** — `L/order/views.py:1692–1918`; URL `ajax-cart/` (`order/urls.py:24`)
- POST. Auth: `LoginRequiredMixin` only. No store-membership or permission check; `store_id`, `tab_id` and `auth_token` come from the form.
- Request: `product_id`(int, default 0), `gv_id`, `store_id`(int), `tab_id`(int), `qty`, `opr∈add|delete|set|clear`, `platform` (default "products"; `remove-gf`, `remove-coupon`), `auth_token`, `end_user`(int), `custom_gc_value`(int), `barcode`.
- add: requires product_id or barcode ("Please Provide Barcode"). Strips "_" and casts the barcode to int. Looks up `ProductBarcode` by gtin ("Invalid Barcode! Product Not Found.") or by product ("Product Barcode Missing."). Membership flag `prod_type==5`. prod_type 8 with custom value 1..10000 → `custom_data={"gvprice":v}`. Redis per-product salesperson key `{store}_{tab}_{pid}` is seeded from master `{store}_{tab}` or 0 (TTL `REDIS_TAB_USER_OBJECT_EXPIRY`). Upstream `POST pos/product` `{store_id, barcode, is_pos:true, auto_add_to_cart:1, custom_data, tab_id(if !end_user)}` with header `Authorization: auth_token`, timeout 8 s (`:1840–1862`).
- delete: message "Gift Voucher Removed." / "Coupon Removed." / "Product Remove successfully." (product case deletes Redis `{store}_{tab}_{pid}`). Upstream `POST cart|pos/cart` `{payload:{operation:"delete", type, data}, is_pos, store_id, tab_id?}`:
  - remove-gf: type `meta`, data `{name:"gift_voucher"}`
  - remove-coupon: type `meta`, data `{name:"coupon"}`, `payload.localcart`=current cart
  - gift card: type `giftvouchers`, data `{prod_id, gv_id}`
  - product: type `products`, data `{prod_id}`
  - No timeout (`:1864–1906`).
- set: upstream `{payload:{operation:"set", type:"products", data:{prod_id, quantity}}, is_pos, store_id, tab_id?}` (`:1908–1931`). clear (not called in range): `{payload:{operation:"clear"}, localcart, store_id, is_pos, tab_id?}`, then deletes Redis `{muser}_{tab}`, `tab`, and `{store}_{tab}*`.
- Errors: None → "Something Went Wrong, Please Try Again"; 500 → "Something went wrong"; 400 → upstream `title`, else "Something Went Wrong"; other → upstream `message`. All errors return `status:"fail"` with HTTP 200.
- Success post-processing: products get `sales_person` from Redis. A legacy bug (`if master_salesperson:` tests the literal 0) means the fallback is always 0. Gift cards get `gift_card_no`, `gift_card_start_date`, `gift_card_end_date` from Redis (`gift_card_{tab}_{gv}`, `gc_start_date_{gv}`, `gc_end_date_{gv}`). On add, the highest gv_id gets end date = today + `DEFAULT_GC_EX_DAYS` (env, default 90), written to Redis with TTL `GC_SRNO_DATE_EX` (default 21600 s). Complementary items get `sales_person`. `total_item_cart` = sum of quantities over products, gift cards and complementary items.
- Response `{status:"success", message, data:<upstream cart>, extra:{exclusive_product, total_item_cart}}`. DB: `ProductBarcode` and `Product` reads (primary); Redis.
- Rewrite: `PUT line-items/:productId` → `service.changeLine` (service.ts:446–520), `upstream.ts:17–35` payload builders, `cartMutation` (service.ts:403–425); gift cards `gift-card-cart.ts:121–150`.

**AjaxSyncCartView** — `views.py:1994–2042`; URL `ajax-sync-cart/` (`urls.py:25`)
- Request: `tab_id`, `store_id`, `auth_token`, `is_cart_sync`, `user_id`. Always sets Redis `tab_id → user_id`.
- If `is_cart_sync`: reads the operator tab cart (failure → 400 "Could not read cart, Please Try Again"), `Helpers.create_token(user_id)`, then `POST syncart|pos/syncart` `{token, localcart:{}, pos_localcart:cart, is_pos, store_id}` with no auth header and an 8 s timeout. Failure → 400 "Cart Sync Failed, Please Try Again". Then a best-effort clear of the operator cart.
- Response `{status:200, message:"Cart Synced", data:{}}`.
- Rewrite: service.ts:762–850 (`attachCustomer`; customer lease, `syncCartPayload` payloads.ts:88–94, clear, verified state).

**AjaxFetchTheProducts** — `views.py:2045–2121`. Not called from lines 901–4060 (it is called by `#sync-cart-products` at :7998). Out of scope.

**AjaxWalletView** — `views.py:2138–2187`; URL `ajax-wallet/` (`urls.py:26`)
- Request: `store_id`, `tab_id`, `auth_token`, `user_obj`(int), `tss_money_applied`, `applied_tss_money`(float, default 0), `custom_tss_money`(default 0), `tss_points_applied`, `is_verified`.
- `!is_verified` → `{status:401, message:"Not Authorized"}` for apply **and** remove.
- Reads the cart (end-user cart if `user_obj`, else tab cart), then `POST wallet` `{localcart:cart or {}, state:bool(money), tss_points_status:bool, is_pos:true, applied_money, custom_tss_money, store_id, tab_id(if !user_obj)}` with the Authorization header and no timeout.
- Upstream status is not checked: the body is passed through as `{status:200, message:"Wallet", data:<body>}`. No DB.
- Rewrite: routes.ts:382–394; service.ts:1157–1178 (`requireVerified` only when money or points is true, service.ts:220–235); payloads.ts:31–45.

**AjaxaExclusiveBenefitsView** — `views.py:2284–2319`; URL `ajax-exclusive-benefits/` (`urls.py:29`)
- Request: `store_id`, `tab_id`, `auth_token`, `is_exclusive_benefits`. Always uses the tab cart (`end_user_cart=False`).
- Upstream `POST cart|pos/cart` `{payload:{operation:"get"}, is_pos, store_id, store_exclusive:{operation:"add"|"remove"}, tab_id}`. Returns `{status:200, message:"Wallet", data:<body>}` with no error mapping.
- Rewrite: routes.ts:407–416; service.ts:1321–1333 (409 "Connected customers use their own membership eligibility." when a customer is attached); payloads.ts:83–87.

**AjaxGiftVoucherView** — `views.py:2322–2358`; URL `ajax-gift-voucher/` (`urls.py:30`)
- Request: `store_id`, `tab_id`, `auth_token`, `user_obj`, `is_verified`, `voucher_code`, `gc_pin` (default "0", "_" stripped).
- `!is_verified` → `{status:401, message:"Not Authorized"}`.
- Upstream `POST giftvoucher` `{voucher_code, gc_pin, is_pos, store_id, tab_id(if !user_obj)}` with the Authorization header and no localcart.
- Response `{status:<upstream HTTP code>, message:"Gift Voucher", data:<upstream body incl. meta | {title, is_pin_required, is_pin_valid}>}`.
- Rewrite: routes.ts:396–406; service.ts:1180–1199; payloads.ts:78–82.

**AjaxAddSalesPersonView** — `views.py:2968–2989`; URL `ajax-add-salesperson/` (`urls.py:38`)
- Request: `store_id`, `tab_id`, `salesperson`(int). No validation that the salesperson belongs to the store.
- `>0`: sets **every** Redis key matching `{store}_{tab}*` (master and all per-product keys; the pattern also matches other tabs whose id has the same prefix, which is a legacy bug) plus the master key → "Salesperson Added Successfully", `is_added:1`.
- `0`: if the master is set → every key set to 0 → "Salesperson Removed Successfully", `is_removed:1`; else "Please Select Valid Salesperson", `is_not_valid:1`. Always `status:200`.
- Rewrite: service.ts:1382–1440 (validates the ID range, product in cart, and `repository.salesperson(store, id)` "Select an active salesperson assigned to this store."); finalizer.ts:189 (line → sale fallback).

**AjaxAddSalesPersonPerProductView** — `views.py:2991–3016`; URL `ajax-add-salesperson-per-product/` (`urls.py:39`)
- Request adds `productid`.
- `>0`: sets `{store}_{tab}_{pid}`, collects values of `{store}_{tab}_*`; if exactly one distinct value, `master_salesperson_data` = that value (the master key is not written). "Salesperson Added Successfully".
- `0`: sets the key to 0 if present → "Salesperson Removed Successfully"; else "Please Select Valid Salesperson".
- Rewrite: same service method with `productId`.

**AjaxCheckSaveGcView** — `views.py:4314–4382`; URL `ajax-check-save-gc/` (`urls.py:41`)
- Request: `gift_barcode`, `tab_id`, `gv_id`. Missing either → `{status:"failed", message:"Please provide data", data:{}}`. Strips "_".
- `check_validity` messages: "Invalid No.(Validation Err 01)" (no zero), "…Err 02" (<2 digits before the zero), "…Err 03" (<3 digits after). Legacy bug: if the decoded random number does not start with 9 it returns a bare `False` → unpack error → HTTP 500. "Collection is blocked.(Validation Err 04)", "Collection not printed yet.(Validation Err 05)", "Invalid No.(Validation Err 06)" (serial longer than collection size), "Invalid No.(Validation Err 07)" (no collection), "This is already issued, Please user otherone" (GiftVoucher with `Helpers.get_gift_card(serial)` code whose order status string is not a substring of "Cancelled"), "Card Number is valid ! Go ahead".
- Duplicate in the same tab (Redis `gift_card_{tab}_*`) → "You have already applied". Otherwise sets Redis `gift_card_{tab}_{gv}` with TTL `GC_SRNO_DATE_EX`.
- Response `{status:bool, message}`. DB: `GiftCardCollection`, `GiftVoucher`, `Order` reads.
- Rewrite: gift-cards.ts:15–82 (messages Err 01–07 preserved; issued → 409 "This card is already issued. Use another card." for **any** existing voucher row, including cancelled orders); service.ts:1201–1265 (duplicate → "This card number is already applied to this sale."; `acquireGiftCard` lease).

**AjaxSaveGcDateView** — `views.py:4385–4397`; URL `ajax-save-gc-date/` (`urls.py:42`)
- Request: `gv_id`, `start_date` or `end_date` (only the first non-None is used), stored as-is (`MM/DD/YYYY` string) in Redis `gc_start_date_{gv}` / `gc_end_date_{gv}`. No validation.
- Response `{status:"success", message:""}`.
- Rewrite: service.ts:1201–1265 (ISO dates, end ≥ start, "The gift card end date must follow its start date."); defaults gift-card-cart.ts:42–60 (start = today, end = today + `giftCardExpiryDays`, 90).

**AjaxGiftVoucherCheck** — `views.py:4518–4547`; URL `ajax-gift-voucher-check/` (`urls.py:85`)
- Request: `user_id`, `user_email`, `gift_voucher_code`, `gc_pin`. Upstream `POST gift_voucher_check` with the same JSON and **no Authorization header**, no timeout.
- Response `{status:<upstream HTTP>, message:<upstream JSON>}`. No server-side verification check.
- Rewrite: none.

**AjaxGiftVoucherConvert** — `views.py:4550–4577`; URL `ajax-gift-voucher-convert/` (`urls.py:86`)
- Same request shape. Upstream `POST gift_voucher_to_tss_money` with no auth header. Response `{status, message}`. **Wallet write** at upstream.
- Rewrite: global-vouchers `convert` (service.ts:~700–900) writes the voucher and wallet natively, behind an OTP check.

**AjaxUserbehaviourView** — `L/users/views.py:804–1006`; URL `get-user-behaviour` (`users/urls.py:24`)
- Request: `email` (required, else 400 "Please Provide email."). `MUser` by email (404 "User Not Found.").
- Raw f-string SQL on `mysql_db`: lifetime exclusive savings (`users`, `orders`, `has_products`, `products`), active GV count (`gift_vouchers.to_id=email AND status=1`), last-30-day orders, total/store orders (`orders`, `order_stores`), NPS avg (`tss.nps_feedback`). ORM: cancelled (`order_statuses=4`), returned (`=6`, with item names), last 5.
- On any exception every metric becomes 0.
- Response `{status:200, message:"date fetched", data:{…see B-14}}`.
- Rewrite: customer-insights history (BigQuery) / benefits / profile.

**AjaxUpdateEndUserDataView** — `users/views.py:1050–1074`; URL `ajax-update-user-data/` (`users/urls.py:28`)
- Class order `(View, LoginRequiredMixin)` means `LoginRequiredMixin.dispatch` is never reached, so the endpoint has **no login check**.
- Validates and saves `MUser.birthdate|anniversary|gender` (writer). Messages in B-17.
- Rewrite: profile adjustments (customer-insights/editor.tsx; etag/version guarded).

**AjaxUserUpdateView** — `users/views.py:667–695`; URL `update-user` (`users/urls.py:23`)
- Raw f-string `UPDATE users SET customer_type="…", gstin="…" WHERE id="…"`. This is SQL-injectable. Prints the request body to stdout and echoes the exception text to the client.
- Only `customer_type` and `gstin` are written; name/telephone/email are ignored.
- Rewrite: ORM profile adjustment (must stay ORM per AGENTS.md).

**AjaxUserDetailsView** — `users/views.py:612–664`; URL `get-user-details` (`users/urls.py:22`)
- Request: `email`, `telephone` (masked "_" → 0).
- Upstream `POST check-user-exclusive` `{email, telephone}` with headers `Ar_app_id`/`Ar_app_key` (env `API_V2_APP_ID`/`API_V2_APP_KEY`), timeout 10 s.
  - Exception → 503 "Unable to fetch user details. Please try again."
  - 200 → adds `exclusive_detail` (`Helpers.get_exclusive_user`, JSON string) and `discount_eligibility` (`Helpers.check_app_user_eligibility`).
  - 404 → upstream message.
  - other → 404 "User Not Found.".
  - neither field → 400 "Please Provide Email/Telephone.".
- Rewrite: routes.ts:229–243, service.ts:749–761 (DB `findCustomer`, active only).

**AjaxOrderProductsListView** — `L/core/datatables/store_products_datatable.py` (class start; URL `ajax-order-product-stock-list/` `core/urls.py:45–46`)
- Reader `READ_DB_ALIAS`. Filters: `ps_product.store=store_id`, `is_del=0`, `is_avail=1`, `product!=""`, `Helpers.store_sellable_q`; exclude `parent_prod_id=0 & prod_type=3`; `stock>0` unless `include_oss_toggle=1`.
- Search: `product icontains | id icontains | gtin icontains`. Ordering by column, default id. Paginator over `length`/`start`.
- Row fields as in B-26. Parent price, spl_price and exclusive_price come from the parent when present.
- Rewrite: catalog products API (use-pos.ts:183).

**AjaxTroubleshootProductView** — `L/core/views.py:2987–3028`; URL `ajax-troubleshoot-product/` (`core/urls.py:154`)
- LoginRequired only. Writes `ProductStore` (`is_avail=1`, `is_del=0` for the parent), `Product.images_new` default, and duplicate-barcode `ProductBarcode.gtin` rename to `<gtin>0123`; then `Helpers.sync_pos_product([id], is_troubleshoot=True)`.
- Always `{status:200, message:"Troubleshooting started for the Product, Just wait for a few seconds"}`.
- Rewrite: catalog-details maintenance (preview/apply; role-gated).

#### Complimentary (freebie) rows and Remove — `create_order.html:1601`, `:2175`, `:2583`

Legacy rendering:
- Rows come from the AJAX responses (:1573–1615 scan path, :2148–2190 product-add path) and from the server render (:165–176).
- Per row:
  - `<tr id="tr-product-<cp_id>">`
  - SKU cell with the "Freebie" badge
  - Name link `/products/<cp_id>/show/` (uses cp_id, not the parent)
  - Price and Sale Price both = `price`
  - Qty `<input … class="… td-input-qty cp-qty-readonly" stock="0" readonly>`, so no change event and no B-35 call
  - Per-row salesperson select (selected = Redis per-product value or master)
  - Hidden `product_id[]`
  - Remove button `.remove-product p-id=<cp_id> prod-type=<cp_prod_type>` with no `gv-id`.
- When `pdata.length === 0` it also writes the product header and makes the proceed/fast buttons visible (:1603–1612).

Legacy Remove (:2565–2738):
- Client guard: `#tr-product-<id>` exists.
- Payload: `{csrfmiddlewaretoken, store_id, product_id:<cp_id>, gv_id:null (serialised as ""), opr:"delete", tab_id, auth_token, end_user:(user_obj?1:0)}`.
- Server (views.py:1749–1757, 1864–1906): `platform` defaults to "products", so it deletes Redis `{store}_{tab}_{cp_id}` and calls upstream `cart|pos/cart` `{payload:{operation:"delete", type:"products", data:{prod_id:cp_id}}, is_pos:true, store_id, tab_id(if !end_user)}`.
- Post-success:
  - toast "Product Removed Succesfully"
  - remove `#tr-product-<id>`; clear the header if no rows
  - `updateDiscountLabel`
  - membership repricing only when `prod-type=='5' && !isExclusiveUser`
  - refresh totals and wallet badges
  - `.total-item-cart = extra.total_item_cart`
  - show the empty-cart placeholder and hide proceed/fast if both tables are empty.
- Failure: "Something Went wrong".

Rewrite:
- `CheckoutCartLines.tsx:26–35` parses `complementary_products.items`. Rows at :63–108 are labelled "Complimentary · Quantity N" (read-only) with unit/sale price as supplied and a link to `/catalog/products/<parent or prod_id>`.
- "Remove complimentary item" (:91–105) calls `mutate('line-items/<prod_id>', 'PUT', {quantity:0})`. The client envelope adds `{operationId, expectedVersion}` (client.ts:244–256).
- Backend: `routes.ts:345–354` (quantity 0..999) → `service.setLine` → `changeLine` (service.ts:446–520). The SKU is not in `products.items` and not a gift row, and `quantity===0`, so it calls `deleteCartPayload(context, wireId(productId))` (service.ts:482; upstream.ts:26–35). That produces `{is_pos, store_id, tab_id?, payload:{operation:"delete", type:"products", data:{prod_id}}}`, identical on the wire.
- `cartMutation` (service.ts:403–425) replaces the cart, sets `quote:null`, `phase:'open'`, and recomputes gift-card dates.

Status and gaps:
- DONE for the upstream payload and the re-read.
- Gaps:
  - **G-B22a (P2):** `lineSalespersons[productId]` is not cleared on delete, while legacy deletes the Redis key. Harmless unless the SKU is re-added.
  - **G-B22b (P2):** labels "Freebie" vs "Complimentary"; no SKU column.
  - **G-B22c (P2):** no item-count update (no `total_item_cart` equivalent in checkout).
  - **UNKNOWN:** upstream behaviour when the same prod_id is both an ordinary and a complimentary line. In both systems, delete by `prod_id` hits `type:"products"`.

#### Wallet: TSS Money and reward Points

Legacy:
- Preconditions (template): switches disabled unless `user_obj and is_verified and balance > 0` (:386, :418, :442, :444). `is_verified` is the Redis OTP flag set by `#otp-sent` (:258, out of range). The server only checks the client-sent `is_verified` (views.py:2151–2154) → `{status:401, message:"Not Authorized"}`, so JS shows "Unauthorized action" (:3162–3165). The points handler has no 401 branch and shows `data.data.title`, which is undefined.
- Money switch (:3175) sends `custom_tss_money:0`, which applies the maximum. The Apply button (:3035) sends `custom_tss_money:1` with `applied_tss_money` from `#applied_tss_money` (min 0, max 9999999), a partial apply. The points switch (:3320) sends both states and the current money amount, with no custom flag.
- Each call sends both current switch states, so toggling one never clears the other.
- Upstream errors arrive as `data.data.title` with status 200. The page shows a warning toast and unchecks the switch; the `.trigger('change')` then issues a **second** call to remove.
- Success: "Applied/Remove" and totals/badges refreshed. Badges show `used/total` and "(Partial Money Applied)".

Rewrite:
- `CheckoutReview.tsx:1341–1408` has "Use TSS Money" (default **checked**, :120), "Use TSS Points" (default **unchecked**, :121), "Wallet amount" (decimal, enabled only with money), "Use wallet" (disabled unless `verifiedCustomerUntil` is current) and "Remove wallet benefits" (sends all false/0).
- Backend: `PUT …/wallet` `{money, points, appliedMoney, custom}` (routes.ts:382–394). `requireVerified` applies only when applying (service.ts:1157–1170, 220–235: "Verify this customer before applying these benefits."). Payload `walletPayload` (payloads.ts:31–45) = `{is_pos, store_id, tab_id?, localcart, state, tss_points_status, applied_money:Number(appliedMoney), custom_tss_money:1|0}`. Wire-equivalent.
- Status: PARTIAL.
- Gaps:
  - **G-W1 (P1):** checkbox state is not initialised from cart `meta` (`used_tss_money`/`used_tss_points`). Submitting "Use wallet" with defaults can silently drop applied points, or apply money at full balance, when the cashier only meant to change one benefit.
  - **G-W2 (P1):** `custom` is true whenever an amount is typed, while legacy uses it only for the Apply button. There is no auto-apply-on-toggle and no auto-uncheck on upstream rejection.
  - **G-W3 (P2):** no `balance > 0` gate; no `used/total` badges; no "(Partial Money Applied)".
  - **G-W4 (P2):** removal does not require verification, whereas legacy returns 401 "Not Authorized" for removal too. Message text differs. Upstream `title` errors are mapped by the gateway (wording UNKNOWN).
  - **UNKNOWN:** whether the gateway treats an upstream 200-with-`title` body as an error (legacy does).

#### Gift voucher apply/remove and voucher-to-money check & convert

Apply (legacy :3433–3675):
- Input enabled iff `user_obj && is_verified`. The first call sends `gc_pin:0`; a 6-digit PIN modal appears only when upstream returns 400 + `is_pin_required`.
- Messages:
  - "Applied/Remove" (no PIN)
  - "Gift Card Has Been Applied" (PIN)
  - invalid PIN → `data.data.title` shown in red with inline `.gc_pin_msg`
  - "Please Provide a Valid PIN"
  - 401 "Not Authorized".

Apply (rewrite):
- CheckoutReview.tsx:1410–1450 requires both code and PIN (`required`).
- The route requires `pin` matching `^[\d_]{4,20}$` (routes.ts:400). `giftVoucherPayload` strips "_" (payloads.ts:78–82).
- Requires an OTP-verified customer (service.ts:1180–1199).
- **G-GV1 (P0):** vouchers without a PIN cannot be sent as legacy does (`gc_pin` "0" is rejected by the regex). Cashiers would have to invent a 4+ digit PIN; upstream handling of a non-"0" PIN for a no-PIN voucher is UNKNOWN. This blocks or corrupts voucher redemption.
- **G-GV2 (P2):** no PIN re-prompt flow; messages differ.

Remove (legacy :3677–3784, not verification-gated):
- `ajax-cart` opr=delete platform=remove-gf → upstream `{payload:{operation:"delete", type:"meta", data:{name:"gift_voucher"}}, …}`. Success requires message "Gift Voucher Removed." and clears the input.
- Rewrite `POST gift-vouchers/removals` (routes.ts:371–380) → `removeBenefitPayload` (payloads.ts:66–77) is identical on the wire. DONE.

Check (legacy :3786–3919), flag `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` (settings.py:622, default 0; context views.py:1639; template :287):
- Upstream `gift_voucher_check` returns value and validity, shown as a dialog. Full flow in B-51/B-52.
- Rewrite: none.
- **G-GV3 (P1, flag-dependent):** MISSING. The flag is absent from rewrite config (legacy-flags.md lists it as not implemented).

Top-up (legacy :3921–4060):
- Confirm dialog, then upstream `gift_voucher_to_tss_money` with no Authorization header and no server verification. Success reloads the page. PIN re-prompt.
- Rewrite: `GlobalVoucherConversion` (global-vouchers/conversion.tsx:222–338) → `POST …/voucher-conversions` (global-vouchers/index.ts:78–93).
  - Native ledger write with OTP proof (service.ts:740–765).
  - Messages: 'Voucher Does Not Exist', 'Voucher Not Valid For Online Use', 'This voucher code is deactivated.', 'This voucher is not valid for this user', 'Gift card expired.' (service.ts:771–820).
  - Gated by `GLOBAL_VOUCHERS_ENABLED` and `GLOBAL_VOUCHER_CONVERSION_ENABLED` (options.ts:22) plus contract envs. Shown whenever `checkout.customerId` is set (CheckoutReview.tsx:965–990).
- **G-GV4 (P1):** gating flag differs from legacy `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` (default off). Native conversion replaces the upstream contract, so parity against the upstream oracle is unverified. Confirm-dialog copy and the success reload are missing.

#### Exclusive (member) benefits

- Legacy: switch at :79–90, enabled only for walk-ins (disabled when `user_obj`), checked from `meta.exclusive_user.active`, key `E`.
  - Request: `store_id`, `tab_id`, `is_exclusive_benefits`, `auth_token`.
  - Upstream: tab cart `get` with `store_exclusive:{operation:add|remove}` (views.py:2284–2319).
  - Success: reprices each row (`#tr-product-price-*`, `#tr-product-spl-price-*`), greys `#exclusive-color`, refreshes totals, toast "Applied/Remove".
  - Error: `data.data.title`. The legacy view has no upstream error mapping.
- Rewrite: CheckoutReview.tsx:1315–1338; routes.ts:407–416; service.ts:1321–1333; payloads.ts:83–87.
  - Disabled when a customer is attached or the state is unknown ("Refresh the sale to verify member benefits.").
  - Backend 409 for connected customers.
  - Prices come from the re-read cart.
- DONE. **G-EX1 (P2):** label/copy differs ("Apply walk-in member benefits"); no visual grey state.

#### Salesperson (order-level and per-product)

Legacy:
- Order-level `#salesperson` (:2740–2770) copies the value to **all** per-row selects and Redis keys, overriding per-product choices. "Not Selected" (0) removes all.
- Per-product (:2334–2375) sets only that product. When all per-product keys agree, the server returns `master_salesperson_data`; the page sets `#salesperson` and triggers change, which re-posts the order-level call and overwrites again.
- Messages: "Salesperson Added Successfully", "Salesperson Removed Successfully", "Please Select Valid Salesperson". The per-product success toast uses type "sales person updated".
- No validation that the salesperson belongs to the store. The options list is the template `salesperson` context (store salespeople).
- New products inherit the master at add time (views.py:1736–1744). Complimentary and gift-card rows also have selects.

Rewrite:
- SalespersonAssignments.tsx:5–114 provides "Sale salesperson" and "Salesperson for <name>" for products, gift cards and complimentary items (salespeople.ts:40–55). Directory: `/api/v1/stores/:storeId/salespeople?purpose=checkout&active=true` (salespeople.ts:21–38).
- Backend: `PUT …/salesperson {salespersonId, productId?}` (routes.ts:538–552; service.ts:1382–1440). Validates the INT range, product in cart and active store assignment.
- Line resolution at order time is `lineSalespersons[pid] || salespersonId` (finalizer.ts:189).
- Gaps:
  - **G-SP1 (P1):** changing the sale salesperson does not overwrite existing per-line assignments (legacy does); this attributes sales differently.
  - **G-SP2 (P1):** no removal ("Not Selected"/0); the empty option is disabled.
  - **G-SP3 (P2):** no master auto-sync when all lines agree; legacy toast messages are absent.
  - Rewrite rejects non-store or inactive salespeople. This is stricter, a deliberate integrity improvement, but still a behaviour difference.

#### Gift card save/date (ajax-check-save-gc, ajax-save-gc-date) vs GiftCardItems.tsx

Legacy:
- The serial check (`.check-gc`, :2522–2563) and the two date fields (:2294–2332) are **independent** calls, each saved to Redis with a 6 h TTL (`GC_SRNO_DATE_EX`).
- Start date defaults to blank ("Today's"); end date defaults to today + 90 days (`DEFAULT_GC_EX_DAYS`) for the newest card only. Pickers enforce `minDate: today`. "Clear" sets a blank value, which shows "No Expiry".
- Dates use `MM/DD/YYYY` strings.
- Serial check feedback: green field on success; on failure a red field that is cleared after 1 s.
- Legacy defects:
  - JS-rendered date inputs lack `gv-id`, so dates on newly added cards are posted with an empty `gv_id` and lost until reload (:1459–1460 vs server-rendered :205–206).
  - A missing-data reply is shown as success.
  - The non-"9" random prefix causes HTTP 500.
- Removing a card does not clear its Redis serial key.

Rewrite:
- GiftCardItems.tsx:28–198 shows one form per card (number + "Valid from" + "Valid until", all `required`, ISO `type=date`) → `PUT …/gift-card-items/:giftId {number(^[\d_]{6,40}$), startDate, endDate}` (routes.ts:418–435).
- Server (service.ts:1201–1265) checks the card is present, then `validateGiftCardSerial` (gift-cards.ts:41–82, Err 01–07 texts kept), then the same-sale duplicate check ("This card number is already applied to this sale."), then end ≥ start, then the DB lease `acquireGiftCard`.
- Defaults: start = today and end = today + 90 days in the business timezone (gift-card-cart.ts:42–60).
- Also: custom value (`/value`, 1..10000), "Add another gift card", "Remove this gift card" (`/removals` → `deleteCartPayload(prod, gv)`, gift-card-cart.ts:121–150), and a grouped-quantity guard ("This grouped card must be removed and added as separate cards.").

Gaps:
- **G-GC1 (P1):** cannot leave the end date blank ("No Expiry") or the start date blank ("Today's"). Issued-card validity may differ. The order-time use of blank dates is UNKNOWN (out of range; check the submit fragment).
- **G-GC2 (P2):** past dates are allowed (min 0001-01-01) where legacy blocks dates before today. Date format is ISO, not `MM/DD/YYYY`.
- **G-GC3 (P2):** validation happens only on combined save (no standalone check/refresh button). Success text "Card number and dates are saved." vs "Card Number is valid ! Go ahead". Issued text differs ("This card is already issued. Use another card." vs "This is already issued, Please user otherone").
- **G-GC4 (P2):** a serial whose voucher belongs to a cancelled order is rejected in the rewrite but accepted by legacy (substring check on "Cancelled").

#### Gaps

P0 (money/order correctness or blocks billing)
- **G-GV1** (B-48, B-49): gift voucher apply requires a 4–20 digit PIN up front. Legacy sends `gc_pin:0` and prompts only on `is_pin_required`, so PIN-less vouchers cannot be redeemed 1:1.

P1 (visible behaviour missing or different)
- **G-CART1** (B-35, B-38, B-21): no quantity change or removal of ordinary lines inside an open checkout. Draft edits after session creation raise a snapshot error. Legacy allows `opr=set` and `opr=delete` at any time before payment.
- **G-W1/G-W2** (B-44, B-45, B-46): wallet checkboxes are not initialised from the cart, can silently drop or replace applied points/money, and use different `custom_tss_money` semantics. No auto-apply on toggle and no uncheck on rejection.
- **G-SP1/G-SP2** (B-34, B-39): sale-level salesperson does not override line assignments; no "Not Selected" removal.
- **G-GV3** (B-51, B-52): voucher Check (balance/validity preview) is missing. `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` is not implemented.
- **G-GV4** (B-53, B-54): Top-up uses different flags and a native ledger instead of upstream `gift_voucher_to_tss_money`. It needs oracle parity.
- **G-GC1** (B-12, B-32, B-33): gift-card blank start ("Today's") and end ("No Expiry") cannot be expressed.
- **G-CUST1** (B-42): customer fetch bypasses upstream `check-user-exclusive` (blocked-user handling, exclusive/cashback pre-display). Query format is restricted.
- **G-CUST2** (B-43): cannot switch the connected customer within the sale.
- **G-CAT1** (B-26): product picker omits special/exclusive price, held stock, storage stock, barcode and the barcode-missing marker.
- **G-CAT2** (B-29): troubleshoot is restricted to role 1 / userType 1 behind a preview/apply flow. Legacy shows it to every operator with one click.
- **G-GC0** (B-30): no custom gift-card value prompt at add time ("Add Original Value <price>" / "Submit Desired Value").

P2 (cosmetic or minor)
- G-B22a/b/c (B-22): freebie label, salesperson key cleanup, item count.
- G-W3/G-W4 (B-23, B-44): `used/total` badges, "(Partial Money Applied)", balance gate, removal verification.
- G-SP3 (B-34): master auto-sync and toasts.
- G-GC2/G-GC3/G-GC4 (B-12, B-37): date min/format, messages, cancelled-order reuse.
- G-EX1 (B-47): label and grey state.
- B-05 and B-01/B-07: rewrite N toggles NPS where legacy is a no-op; extra PP and T shortcuts (extra behaviour).
- B-09 (live GSTIN sanitizing); B-10 (PG remark draft persistence); B-17 (add-only vs edit profile fields); B-25 (empty-cart copy); B-27 (3-char/400 ms search rule); B-28 (Inventory reload button); B-36 (Membership Savings label by cart content); B-41 (GSTIN messages).

UNKNOWN
- B-24 (membership product + `temp.id` email popup).
- B-40 (add-number prompt).
- B-55 (performance field mapping).
- Upstream handling of non-"0" PIN for no-PIN vouchers.
- Gateway mapping of upstream 200-with-`title` wallet errors.
- Order-time consumption of blank gift-card dates.

Security notes (legacy behaviour the rewrite must **not** copy; not parity gaps):
- `AjaxUserUpdateView` raw f-string SQL (users/views.py:684–689).
- `AjaxUpdateEndUserDataView` has no effective login check (MRO).
- `AjaxGiftVoucherCheck`/`Convert` call upstream without an Authorization header and without server-side verification.
- Client-trusted `is_verified` in wallet and GV views.
- Behaviour SQL built by f-string.

---

## Part C — create_order.html inline JS part 2 (lines 4060–8450) + server views

Legacy: `L` = pinned `backend-pos-web@78d5b63` scratch copy. `F` = `L/order/templates/order/create_order.html`, `V` = `L/order/views.py`.
Rewrite: `R` = `pos-rewrite-single-stack` @ `324d62d` (branch `refactor/single-stack-schema-freeze`). `CR` = `R/frontend/src/pages/checkout/CheckoutReview.tsx` (line numbers as of this read; the file was being edited concurrently and shifted ~36 lines during the audit), `PP` = `R/frontend/src/pages/checkout/PaymentPanel.tsx`, `CS` = `R/backend/src/modules/checkout/service.ts`, `PR` = `R/backend/src/modules/checkout/payments/repository.ts`, `PG` = `R/backend/src/modules/checkout/payments/gateway.ts`.
Upstream base: every API-v2 call uses `MAIN_API_V2_URL + <path>` when `MIGRATION_TO_API_V2`, else `API_V2_URL + <path>` (for example `V:2215-2218`). Removed features (screening, cash-return intents, CSV import, SSO, demo mode) are excluded.

Common legacy response handling: every calculation-refresh handler (PG/store/coupon/validate/clear-cart) loops over `data.data.meta.items`. For `name=="calculations"` it writes `.discount` (= `total_savings - coupon_discount`, `toFixed(2)`), `.cart-total` (`products_total`), `.coupon-discount`, `.member-savings` (`isExclusiveUser ? exclusive_savings : discount`), `.gst-total`, `.total-payable` (`total`), `.round-off`, `.total-payable-round` (`rounding_off + total`), `.gift-voucher-value`, `.pg-discount-value`/`#pg_discount` (`used_pg_discount`), `.store-discount-pg-value`/`#store_discount_pg` (`used_store_discount_pg`), `.tss-points-value`, `.tss-money-value` and `.cashback-earned` (`app_cashback`). For `tss_money` it writes `#tssmoney` as `used/total` and `#custom_tss_money_field` as "(Partial Money Applied)". For `tss_points` it writes `#tsspoints` (e.g. `F:4083-4155`). Rewrite counterpart: `R/frontend/src/pages/checkout/CartQuoteSummary.tsx` + `quote-summary.ts` (owned by another fragment; cited only).

#### Controls and AJAX calls (JS part 2)

| ID | Control / call (type) | Legacy file:line | Visible/enabled when | Endpoint: request -> response fields | Validation / messages (verbatim) | Rewrite file:line | Status — note |
|---|---|---|---|---|---|---|---|
| C-01 | Old PG discount **Apply** `#pg-discount-apply` (button + `#pg_discount` number min 0 max 9999999) | F:4055-4165; markup F:303-326 | `show_pg_discount_module` (= `GLOBAL_SHOW_PG_DISCOUNT_MODULE` or store.category=="IN_HOUSE" and operator `user_type==1`, V:1563-1567) **and** `enable_old_pg_disc` (`ENABLE_OLD_PG_DISCOUNT`, V:1635). Input/Apply/remark disabled with title "You do not have permission." unless `request.user.role in PG_DISC_ROLE_PERM` (default `[1,2,3,4]`) | POST `ajax-pg-discount` {csrf, store_id, tab_id, auth_token, pg_discount, apply:1, user_obj (id or 0)} -> `{status:200,message:"PG",data:<API-v2 cart>}` or `{status:400,message:"Not applicable",data:{}}` | Client: "please enter valid value" (NaN), "Discount must be greater than zero". Success: "Applied Succesfully". 401 -> `data.message`; else `data.data.title` (for the server 400 this is `undefined`, a legacy defect) | CR:1465-1560 (`kind:'pg'`), CS:1347-1388, payloads.ts:46-56 | PARTIAL — combined Store/PG form with type select. Flag gating (GLOBAL/IN_HOUSE/ENABLE_OLD) is MISSING (legacy-flags.md "not implemented"). The remark is captured at apply time (3–35 chars) instead of at Proceed. Messages differ ("A nonzero discount is required.") |
| C-02 | Old PG **Remove** `#pg-discount-remove` | F:4168-4273 | Same block. Remove button **not** role-gated in legacy | POST `ajax-pg-discount` {..., pg_discount:0, apply:0} -> same | "Removed Succesfully". Clears `#pg-remark` and `localStorage["pgRemark"+tab_id]`. 401/else -> `data.message` | CR:1540-1554 ("Remove selected discount"), CS:1360 | PARTIAL — the rewrite applies `PG_DISC_ROLE_PERM` to removal too (CS:1360), so a role-5 operator cannot remove; flag gating missing |
| C-03 | Store discount (PG) **Apply** `#store-discount-pg-apply` (+ `#store_discount_pg`, `#store-discount-pg-remark`, `#store-discount-pg-reason` select of 9 reasons) | F:4275-4386; markup F:329-366 | `show_pg_discount_module` and `enable_new_pg_disc` (`ENABLE_NEW_PG_DISCOUNT`, V:1636). **No role gate** | POST `ajax-store-discount-pg` {csrf, store_id, tab_id, auth_token, store_discount_pg, apply:1, user_obj} -> `{status:200,message:"PG",data}` / 400 "Not applicable" | "please enter valid value", "Discount must be greater than zero", "Applied Succesfully"; 401 -> message; else `data.data.title` | CR:1465-1560 (`kind:'store'`), discounts/policy.ts:8-28 (same 9 reasons, remark 3–35, not only space/dot) | PARTIAL — the reason list is identical. The rewrite adds a role gate (CS:1360) that legacy lacks. Flag gating is missing |
| C-04 | Store discount (PG) **Remove** | F:4389-4494 | Same | POST `ajax-store-discount-pg` {store_discount_pg:0, apply:0} | "Removed Succesfully"; clears `#pg-remark` + localStorage `pgRemark` | CR:1540-1554 | PARTIAL — role-gated in the rewrite; flag gating missing |
| C-05 | **Coupon Apply** `#coupon-apply` (+ `#coupon` prefilled from `cart.meta.items[name=coupon].coupon`) | F:4496-4598; markup F:260-273 | `show_coupon_module` (= `GLOBAL_SHOW_COUPON_MODULE` or IN_HOUSE+`user_type==1`, V:1566) | POST `ajax-coupon` {csrf, store_id, tab_id, coupon, auth_token, user_obj_data (customer email), is_verified 0/1, user_obj} -> `{status:200,message:"Coupon",data}` or `{status:400,message}` | Server: "Please verify the user to use Employee Coupon" (only if the checked email contains "@thesouledstore.", the user is not verified and the code is `is_employee_coupon=1`). Client: "Applied Succesfully"; 400 -> message; else `data.data.title` | CR:1281-1312, CS:1141-1150, payloads.ts:68-72 | PARTIAL — the GLOBAL_SHOW_COUPON_MODULE gate is MISSING. Employee coupon rule is DIFFERENT: the rewrite requires verification for **every** employee coupon (CS:1143). Legacy only did so when the customer email (or, for a walk-in, the operator email) had the company domain. Message differs ("Verify this customer before applying these benefits.", CS:235-237) |
| C-06 | **Coupon Remove** `#coupon-remove` | F:4600-4701 | Same as C-05 | POST `ajax-cart` {csrf, store_id, product_id:0, opr:"delete", platform:"remove-coupon", tab_id, auth_token, end_user} -> `{status:"success",message:"Coupon Removed.",extra:{total_item_cart},data}` | Success only if `status==="success" && message==="Coupon Removed."` -> "Removed Succesfully", clears `#coupon`; 401 -> message; else `data.data.title` | CR:1300-1310, CS:1151-1164, payloads.ts:73-85 | DONE — same upstream `cart` delete/meta/coupon with localcart; toast text not reproduced |
| C-07 | **Verify user** `#otp-sent` -> send customer OTP | F:4703-4722; markup F:257-259 | Only if `user_obj` connected; disabled and green "User is verified !" when `is_verified`, else "Verify the user to use Tss Money/Points/Voucher !" | POST `ajax-send-otp` {csrf, user_id} -> `{status:200,"OTP Sent"}` / `{status:400,"OTP Not Sent"}` | Toast "We have Sent an OTP on your mobile/email." is shown **unconditionally**. `$.alert` only on `status=="fail"`, which the view never returns (dead branch) | CR:1180-1205, customer-otp module (`R/backend/parity/customer-otp.md`) | DIFFERENT — documented security correction: 6-digit CSPRNG OTP, scoped, rate-limited, own delivery outbox, instead of the API-v2 `omnichannel-sendotp` 4-digit code |
| C-08 | OTP dialog **Submit** `#btn-verify-otp` (input mask `9999`) | F:4723-4780 | After C-07 | POST `ajax-verify-otp` {csrf, user_id, tab_id, otp} -> `{status:200,"OTP is verified"}` / `{status:400,"Wrong OTP"}` | "Please Provide a Valid PIN" (empty). 400 -> toast + inline "Wrong OTP! Please enter correct OTP."; 200 -> toast message + `location.reload()` | CR:1230-1278 | DIFFERENT — 6-digit code, 15-minute proof versus `REDIS_VERIFIED_USER_OBJECT_EXPIRY`; documented |
| C-09 | **Place order now!** `#online-order` | F:4783-4796; markup F:657-662 | `user_obj and is_verified`; caption shows the session expiry minutes | POST `ajax-online-order` {csrf, user_id, store_id} -> `{status, data:{web_url}}`; JS `window.open(web_url,'online-order')` | none | CR:943 `CustomerWebsiteHandoffAction`; `R/backend/parity/customer-website-handoff.md` | DIFFERENT — documented: opaque one-time handoff grant instead of a JWT plus API key in the URL |
| C-10 | **Create Account** dialog `#user-register` (Name*, Mobile* mask 10 digits, Email optional, DOB optional, Customer Type* B2B/B2C, GSTIN shown for B2B with uppercase-alnum filter, max 15) | F:4798-4899; link markup F:664-668 | Only when **no** `user_obj` | — | "Please provide a valid name", "Please provide a mobile number" (empty or contains `_`), "Please provide a valid email" (regex `^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$`), "Please select Customer Type (B2B or B2C)", "Please enter GSTIN for B2B customers", "Please enter a valid GSTIN (15 character alphanumeric)" (length check only; the regex is commented out) | `R/frontend/src/pages/checkout/CustomerRegistration.tsx:74-148`; mounted CR:1066 | PARTIAL — Customer Type defaults to B2C (legacy forces a choice). GSTIN uses the full checksum-shape regex (`CustomerRegistration.tsx:144`), stricter than legacy. Mobile pattern `[6-9][0-9]{9}` is stricter. Name max 45 |
| C-11 | **Get OTP** `#btn-user-reg` (platform "OTP") | F:4900-4997 | In the dialog | POST `ajax-user-register` {csrf, user_id, tab_id, store_id, name, mobile, email, dob, platform:"OTP", otp, self_verify, customer_type, gstin} -> `{status:200,message:"OTP has been sent",platform:"OTP"}` or `{status:400,message:"Mobile No is already registered with us" / "Email is already registered with us"}` | 400 -> toast + red error box. 200 -> toast "OTP has been sent to your number", hides the form and shows the OTP box plus Self-Verify / Verify-with-OTP buttons | CustomerRegistration.tsx:150-156 ("Request registration code"), routes.ts:264 | PARTIAL — duplicate messages are unified ("The phone or email is already registered. Find and connect the existing customer.", customers/service.ts:414) |
| C-12 | **Self Verify (Without OTP)** `#btn-user-reg-self` (self_verify=1) | F:4856-4857, F:4954-4960, V:2448 | Shown after OTP sent | POST `ajax-user-register` {platform:"VERIFY", self_verify:1} -> registers without OTP | — | none | **MISSING** — the rewrite requires a verified registration code (CustomerRegistration.tsx:154). No cashier self-verify path. Product decision required |
| C-13 | **Verify with OTP** `#btn-user-reg-otp` | F:4858-4859, F:4954-5001 | After OTP sent | POST `ajax-user-register` {platform:"VERIFY", otp} -> 200 `{message:"Verified succesfully",data:<store-register json>,platform}` / 400 "OTP is incorrect" / 400 `{data}` (no message) | "Please enter the OTP"; success toast = message | CustomerRegistration.tsx:183-228 (verify, then "Create verified customer") | DONE — two explicit steps; attempt limits added (documented) |
| C-14 | Post-registration **cart sync** (automatic) | F:5002-5024 | After a VERIFY success | POST `ajax-sync-cart` {csrf, user_id:new id, tab_id, store_id, auth_token, is_cart_sync: 0 if user_obj else 1} -> `{status:200,"Cart Synced"}` / 400 "Could not read cart, Please Try Again" / 400 "Cart Sync Failed, Please Try Again" | `$.alert(message)` then `window.location.reload()` | CustomerRegistration.tsx:268-280 ("Connect registered customer" -> `mutate('customer','PUT')`) | PARTIAL — requires an extra explicit click; no automatic connect plus walk-in cart sync |
| C-15 | **Proceed For Payment** `#btn-proceed` | F:5035-5053; markup F:222-224 | Hidden when the cart is empty (F:5803 etc.) | If `request.user.role in PG_DISC_OTP_EXEMPT` (default `[1,2,3]`) -> `PayProceedButton()`. Else if `#pg_discount>0 or #store_discount_pg>0` -> `SendOTP()`, else `PayProceedButton()` | — | CR:1647-1680 (`DiscountApproval` + "Create order" enabled only when approval is `not-required`/`approved`); discounts/repository.ts:97-104 | DONE — exempt roles honoured server-side |
| C-16 | Proceed pre-validations (SendOTP / PayProceedButton / fast) | F:5061-5136, F:6183-6258, F:7311-7427, F:7558-7632 | Before any OTP or order | — | "Please add some product into the cart"; "Please Select The Salesperson" (any per-product select =0 **or** master salesperson <=0); "Please provide a remark for the PG discount. It is mandatory for availing the discount." (old PG >0 and remark blank / only spaces-dots / <3); fast variant "Please provide a valid remark for the PG discount. It is mandatory for availing the discount." (F:7585); store PG >0: "Please select a reason for PG discount." (F:5108) or "Please select a store discount(PG) Reason for PG discount." (F:5298 etc.), "Please enter a remark for PG discount.", "Remark cannot contain only spaces or dots." / "Store discount(PG) Remark cannot contain only spaces or dots.", "Remark must be at least 3 characters." / "Store discount(PG) Remark must be at least 3 characters.", "Remark cannot exceed 35 characters." / "Store discount(PG) Remark cannot exceed 35 characters." | discounts/policy.ts:19-28, 129-140; FastCashCheckout.tsx:55, 254-256 | PARTIAL — remark/reason rules enforced (DISCOUNT_REMARK_REQUIRED; extra 45-char combined limit policy.ts:136-140). **Salesperson requirement is MISSING on the normal "Create order" path**: there is no salesperson guard in CS:1860-1990 or CR:1660-1680; only fast cash checks `salespersonReady` |
| C-17 | **PG Disc OTP send** (manager OTP) | F:5139-5165 (Proceed), F:7429-7453 (Fast Cash) | Non-exempt role, total PG >0 | POST `ajax-pg-disc-otp-send` (csrf-exempt) {user_id (operator), tab_id, store_id, counter_id, pg_discount = parseInt(pg)+parseInt(store), user_name, total_amount = `#sub-total` text (products_total)} -> `{status:200 or 202,message:"otp sent" or "otp already sent"}` | 202 -> proceed immediately without OTP. Toast "OTP Sent To Managers" is always shown | DiscountApproval.tsx:51-56, 133-139 ("Request manager approval code"); discounts/policy.ts:171-197 (same threshold algorithm); discounts/delivery.ts:164-165 (same mail subject/body shape) | DONE — explicit request button instead of automatic send. Decimal total instead of `parseInt` truncation (minor DIFFERENT). Send limits added |
| C-18 | **PG Disc OTP dialog** "Do you want to confirm this order with this otp ?" + Submit/Back | F:5167-5245, F:7456-7534 | After C-17 | POST `ajax-pg-disc-otp-check` {user_id, tab_id, store_id, counter_id, pg_discount, user_name, otp} -> `{status:200,message:"verified"/"not verified"}` | verified -> sets hidden `#pg_disc_otp_val`, continues; else "The OTP you have entered is wrong please retry with correct OTP ?" (red). Unlimited retries | DiscountApproval.tsx:84-131 | DIFFERENT — 5-attempt lock ("Too many incorrect codes."), password-type input `[1-9]{6}`, different copy |
| C-19 | `SendOTPFast()` | F:5249-5437 | **Dead code** — no caller (only F:5249 definition) | same as C-17/C-18 | duplicates C-16 messages | — | DONE (N/A) — no counterpart needed. Note: `PayProceedButtonFast` closes `pg_disc_otp_confirm_fast` (F:5521-5525), which only this dead function defines. A non-exempt operator reaching fast prepaid with a PG discount therefore hits a ReferenceError in legacy (defect; do not replicate) |
| C-20 | `PayProceedButtonFast()` (prepaid via Fast Cash) | F:5439-6175 | Called only from F:7549 when `.total-payable` <= 0 | validate (C-22) -> `ajax-order` F:5665 -> `ajax-cart clear` F:5707 -> if `total_payable>0` payment form (with Transaction ID) else "Payment has been Completed for order ID : X? " + `window.open(/orders/store/X/invoice/?auto_print=1)` | "Order is ready to be placed. Please Wait for a while", "Order Created!", "Product Removed Succesfully", "Something Went wrong", "Order Creation Failed", "Order Validation Failed" | CR:1680-1712 (prepaid "Check prepaid payment status"), FastCashCheckout.tsx:237-240 | DONE |
| C-21 | `PayProceedButton()` | F:6177-7239 | From C-15 / C-18 | validate -> (payable>0) payment form **first**, then confirm, then `ajax-order`, clear cart, `ajax-transaction-upload`; (payable<=0) Order Confirmation dialog | see C-22..C-39 | CR:1660-1680 then PP | DIFFERENT — the rewrite creates the order first and then collects payment (the legacy fast-path ordering). Legacy normal path created no order until the payment form was confirmed |
| C-22 | `ajax-validate-process-order` | F:5531-5541, F:6270-6280 | Every proceed | POST {csrf, store_id, tab_id, auth_token, end_user} -> `{status:200,message:"Ok",data:<processorder cart>,is_valid_exclusive_buyer}` or `{status:400,message}` | "Please Connect User for Membership Product" (any `prod_type===5` and no user); "Please add some product into the cart 1"; server "Please add/save Gift Card No."; title or "Something wrong in the cart"; non-200 validate -> raw `resp.text` | CS:1759-1797 (quote) and CS:1865-1884 (revalidate on submit) | DONE — messages differ ("Connect a customer before purchasing membership.", "Save a gift card number for every gift card in this sale.") |
| C-23 | Membership-without-user payment-form header "As we can see there is no user connected and you are trying to buy a membership" | F:6453-6456, F:6986-6988 | `is_valid_exclusive_buyer==false` | — | — | — | DONE (N/A) — unreachable, because C-22 blocks first (F:6293-6300) |
| C-24 | Payment form **Transaction ID** (disabled, `value=txn_id`, attr `order_id`) | F:5826-5829 (fast form only; the normal form omits it, F:6406-6409) | payable>0 | — | "Provide a valid Transaction ID" (fast form only) | PP:293-296 (shown only once paid), PP:310 (payment UUID) | PARTIAL — the legacy transaction ID (`Helpers.get_transaction_id`) is not shown before dispatch |
| C-25 | **Cash To Be Accepted** `#offline_payment` number min 0 max total, default total | F:5831-5834, F:6411-6414 | payable>0 | — | onChange: >total -> clamp to total; <=0/blank -> 0 and resets Cash Recieved/change to 0; sets Card/UPI = total-cash; disables Payment Mode when online==0 | PP:423-435 ("Cash portion", only when a non-cash method is selected; default `0.00`) | DIFFERENT — no clamping or auto-split. Cash is a separate method entry; the split is entered as a cash portion |
| C-26 | **Cash Recieved** `#cash_recieved` min 0, default total | F:5835-5838, F:6415-6418 | payable>0 | — | onChange: < cash -> set to cash and change 0; else change = received-cash (if change==received -> 0 and received 0) | PP:436-446 | PARTIAL — no auto-correction; server error "Cash received must cover the cash portion." (PR:91-96) |
| C-27 | **Cash To Be Return** badge `.change_return` | F:5839-5842, F:6419-6422 | payable>0 | — | computed (C-25/C-26) | — (PaymentPanel); FastCashCheckout.tsx:257 shows "Change" | **MISSING** in PaymentPanel — no change-due display for normal/split cash |
| C-28 | **Card/UPI** `#online_payment` min 0 max total, default 0, `disabled` if no payment modes | F:5845-5848, F:6425-6428 | payable>0 | — | onChange: clamp, offline = total-online, toggles Payment Mode disabled, adjusts received/change | PP:224-229 (online = payable - cash portion, not editable) | DIFFERENT — derived, not an input |
| C-29 | **Payment Mode** select `#payment-mode` (option 0 "Select Payment Mode"; options from `payment_mode` dict = `TerminalHelper.get_payment_mode(store,counter)`; labels "N. name (machine)"; values `mode` or `mode-machineId`) | F:5849-5857, F:6429-6437; helpers/terminal_helpers.py:273-317 | Disabled initially and while online==0. If the dict is empty: red "No payment option available" and Card/UPI disabled | — | "Please Select Payment Mode." (online>0 and mode 0) | PP:402-422; options PR:1072-1131; routes payments/routes.ts:72 | DIFFERENT — "Cash" is option 0 and the list is never empty. Labels are not numbered. Machines are always filtered by the order counter (legacy is store-wide when counter_id=0). Unknown mode IDs are skipped (PR:130-141), whereas legacy routes any non-1001/1003-1006 mode to Pine |
| C-30 | **District Transaction ID** `#district_transaction_id` | F:5859-5862, F:6439-6442; toggle F:6049-6062 | Shown when mode==1005 | — | "Provide District Transaction ID" | PP:447-459 (generic "External transaction reference", max 100, pattern `[A-Za-z0-9][A-Za-z0-9._/-]*`) | PARTIAL — label differs; the pattern rejects free text that legacy accepted |
| C-31 | **Credit-Pincode Transaction ID** `#credit_pincode_id` | F:5863-5866, F:6443-6446 | mode==1006 | — | "Provide Credit-Pincode Transaction ID" | PP:447-459 | PARTIAL — same as C-30 |
| C-32 | **Message** textarea `.message` (auto-filled "#Card/UPI Received: x\n#Cash Received:y\n#Cash To Be Accepted:z\n#Cash To Be Return:w", editable, required) | F:5867-5870, F:6043-6046, F:6447-6450, F:6871-6874 | payable>0 | sent as `message` to C-38 -> `OrderStore.message` | "Provide a valid Message" | none in PP; PR:603 writes `checkoutNote?.message ?? 'Complete'` | **MISSING** — normal/terminal/split payments persist "Complete" rather than the counter breakdown (only fast cash has a note, settlement-note.ts) |
| C-33 | Payment form **Submit** validations | F:5893-5948, F:6515-6566 | — | — | "Enter Valid Value in Cash", "Enter Valid Value in UPI/Card", "Provide a valid Message", "Provide a value in Cash Recieved" (cash>0 and received==0), "Incorrect Pay amount." (cash+online != total), "Please Select Payment Mode.", "Provide District Transaction ID", "Provide Credit-Pincode Transaction ID" | PP:62-67, 216-222; PR:85-115 | PARTIAL — equivalent checks, server-authoritative, different copy ("Payment amounts must equal the authoritative order payable." etc.) |
| C-34 | **Confirmation !** "Are you sure ?" / "Yes, sure!" / cancel | F:5949-6033, F:6568-6855 | After C-33 | — | — | none | **MISSING** — PaymentPanel dispatches on the first submit (P2) |
| C-35 | Payment dialog **Back** | F:6859-6867 | — | — | re-enables buttons | — | DONE (N/A) |
| C-36 | `ajax-order` (create order) | F:5665-5686, F:6591-6612, F:7046-7067 | After confirm (normal) / immediately (fast/prepaid) | POST {user_id (operator), csrf, store_id, counter_id, tab_id, auth_token, total_payable, nps_feedback_switch, performance_json, overall_performance_time, end_user, pg_disc_comment, pg_discount_otp, pg_discount_amount, store_disc_pg_comment, store_discount_pg_amount, store_disc_pg_reason} -> `{status:200,message:"Order Created",order_id,transaction_id,data:{}}` / `{status:400,"Something Went Wrong"/"Something went wrong"}` | "Order is already being processed. Please wait..." (`window.orderProcessing`), "Order Created!", non-200 -> toast `data.message`, transport error "Order Creation Failed, Retry" / "Order Creation Failed". The zero-payable confirm path shows **no** toast on status!=200 (F:7201-7206) | CR:1660-1676, CS:1855-1990 (`pos/order` via `orderPayload` payloads.ts:103-122) | DONE — idempotent operation and checkpointed creation. Legacy derives `payment_method` from the client `total_payable`; the rewrite derives it from the authoritative quote |
| C-37 | Cart **clear** after order (`ajax-cart` opr=clear) | F:5707-5813, F:6626-6827, F:7079-7198, F:7727-7764 | After the order is created | POST {csrf, store_id, product_id:0, opr:"clear", tab_id, auth_token, user_id, end_user} -> `{status:"success",extra:{total_item_cart},data}`. Server deletes Redis `{operatorShadowId}_{tab}`, `tab_id`, `{store}_{tab}*` (V:1762-1772) | "Product Removed Succesfully"; empty-cart banner "Hi {first_name}, I am empty … Add something … to make me happy."; hides Proceed/Fast Cash; failure "Something Went wrong" | CS completeOrder / counter `completeSale` (counter.tsx:414-445) | DONE |
| C-38 | `/orders/ajax-transaction-upload/` | F:5964-6025 (fast form), F:6729-6805 (normal) | After order + clear (normal); on Submit (fast form) | POST {csrf, order_id, transaction_id, amount (online), cash, cash_recieved, payment_mode ("mode" or "mode-machineId"), message, district_transaction_id, credit_pincode_id} -> `{status,message}` with message in {"Approved","Open","Already Completed","Failed","Cash/Online(Others) Delivered","Cash Delivered","Invalid Merchant","Duplicate Order ID","Terminal Not In Active State","Multiple payment request not allowed for same terminal..!","Request parameters are not valid", raw provider text, "Incorrect Pay amount."} | Approved -> alert + reload + open `/orders/store/{id}/show/`. Open -> fast form "Please Approve Open Txn First"; normal form "Multiple payment request not allowed for same machine" + reload + show page. Failed (normal) -> reload + show page. Cash Delivered / Cash/Online(Others) Delivered -> alert + reload + `invoice/?auto_print=1`. Others -> alert. Transport error (normal) -> "Payment Process Failed, Please try again." + reload + show page | PP:216-249 (`POST …/payment-attempts`), PR:85-115, PG:85-125, PG:250-280 | PARTIAL — see Payment-mode section. Definitive provider rejections (Pine non-APPROVED upload, Paytm 0333/0233, Pine "INVALID PLUTUS TXN REF ID") become `uncertain` instead of a retryable failure. Verbatim messages are not shown |
| C-39 | Zero-payable **Order Confirmation** dialog "Do you want to Confirm this order ?" + **Confirm Order** `#btn-confirm-order` | F:6969-7222 | payable<=0 with items | `ajax-order` (C-36) -> clear (C-37) -> reload + `invoice/?auto_print=1` | as C-36 | CR:1660-1712 | DONE — no separate confirm dialog; prepaid settlement status read |
| C-40 | **Fast Cash** `#fast-checkout` | F:7242-7305; markup F:225-227 | Hidden on empty cart; disabled by ButtonStateManager | Store PG remark/reason checks (C-16). Exempt role or total PG<=0 -> `fast_checkout_button_press()`. Else C-16 checks, C-17 send, C-18 dialog (`pg_disc_otp_confirm_fast_checkout`) | as C-16 | `R/frontend/src/pages/checkout/FastCashCheckout.tsx:223-283`, mounted CR:1601-1645 (`canStart` requires approval ready) | DONE |
| C-41 | `fast_checkout_button_press()` prepaid redirect | F:7545-7551 | `.total-payable` <= 0 | -> C-20 | "Look like prepaid order. Sit back, we are processing the order" | FastCashCheckout.tsx:237-240 (zero-total uses prepaid evidence) | DONE — copy differs |
| C-42 | Fast checkout dialog: title "Fast Checkout (Cash Only)! … Cash To Be Accepted : {total}", **Cash Recieved** `#fast_cash_recieved` (default total), **Cash To Be Return** `.fast_change_return`, **Order Message** `.order-msg` (auto "#Cash Received:x\n#Cash To Be Accepted:y\n#Cash To Be Return:z") | F:7640-7656, F:7788-7811 | After C-40 validation | — | "Provide a valid message"; received < total is silently bumped to total | FastCashCheckout.tsx:195-257 | PARTIAL — received below payable is an error ("Cash received must cover the exact quoted payable.", offline/fast-cash/contracts.ts:111) instead of an auto-bump. Blank uses the payable. Inline, not a dialog |
| C-43 | Fast **Submit** -> `ajax-fast-checkout` | F:7662-7782 | — | POST {user_id, csrf, store_id, counter_id, tab_id, auth_token, end_user, salesperson, order_msg, cash_recieved, performance_json, overall_performance_time, nps_feedback_switch, pg_disc_comment, pg_discount_otp, pg_discount_amount, store_disc_pg_comment, store_discount_pg_amount, store_disc_pg_reason} -> `{status:200,message:"Cash Delivered",order_id}` / `{status:400,message}` | `sent` guard; "Order is already being processed. Please wait..."; non-"Cash Delivered" -> `$.alert(message)`; transport error "Order Creation Failed, Please Retry" | FastCashCheckout.tsx:258-283; `R/backend/parity/fast-cash.md` | DONE — durable intent and recovery |
| C-44 | Fast success: clear cart + reload + `invoice/?auto_print=1` | F:7714-7764 | — | C-37 | "Something Went wrong" | InvoiceActions / protected print (fast-cash.md:23) | DONE |
| C-45 | **Add Mobile No.** `#add-number` dialog | F:7815-7876; markup F:576-580 | `user_obj` connected (span hidden after save) | POST `ajax_m_user_mobile` {csrf, id, phone_number} -> 200 `{message:"Saved Successfully",mobile}` / 400 `{message:"Invalid user id"}` / 400 `{message:"Number already registered"}` | "Please provide a valid mobile number" (empty or not `^\d{10}$`); error -> `$.alert(responseJSON.message)` | CR:804 `CustomerContactPanel`; `R/backend/parity/customer-contacts.md` | DIFFERENT — documented: proof-bound add-missing-contact only ("This mobile number is already registered.", customer-contacts/service.ts:369) |
| C-46 | `get_quotes()` -> `ajax-get-quotes` (sync GET) | F:7882-7895 | **Dead** — every caller is commented out (F:1733, 2723, 5800, 6720, 7171) | GET -> `{status:"success",data:<random quote>}` | — | `R/backend/src/modules/motivational-quotes` | DONE (N/A) |
| C-47 | `toast_message(msg,type)` SweetAlert toast, top-end, 5000 ms, close button | F:7896-7924 | — | — | — | inline `role=alert/status` paragraphs (CR, PP) | DIFFERENT (P2) — no transient toasts |
| C-48 | `email_popup()` "Add User's Email ID!" | F:7926-7996; triggers F:1708-1713, F:2273-2278 | Auto-opens after adding an exclusive membership product when the connected user's email contains "temp.id" | POST `ajax_m_user_email` {csrf, id, email} -> 200 `{message:"Email successfully changed",email,status:200}` / 400 "Invalid user id" / 400 "Email already registered" | "Please provide a valid email"; success alert "Window reloading..." + toast + reload; error toast + re-open popup | CustomerContactPanel (CR:804) handles the temp.id placeholder (customer-contacts.md:6) | PARTIAL — no automatic prompt on adding membership; manual, proof-bound flow |
| C-49 | **Sync Order** `#sync-cart-products` dialog (order id mask 12 digits) | F:7998-8070; button F:105 | Always visible | POST `ajax_fetch_the_products` (60 s timeout) {csrf, user_id, tab_id, store_id, auth_token, is_cart_sync:1, order_id, end_user_cart} -> `{status:200,"Cart Synced"/"Cart partially synced - please review the cart"}` / 204 "  Please Connect The User  " / 204 "  Please Enter Correct Order Id  " / 400 "Could not read cart, Please Try Again" / 400 "Cart Sync Failed, Please Try Again" | Toast "Sync any order cart"; "Please Provide a Valid Order ID"; non-200 -> warning + inline text; transport "Cart Sync Failed, Please Try Again" | `R/frontend/src/pages/order-copy/index.tsx`; `R/backend/parity/order-copy.md` | DIFFERENT — documented reviewed absolute-quantity copy protocol |
| C-50 | **Birthday Missing** auto prompt (Confirm -> `postUserProperty(...,'birthday')` -> `ajax_update_user_data`; cancel -> localStorage `birthday_reminder_{user}_{tab}=1`) | F:8072-8102 (helper F:1334-1350) | `user_obj` connected with no `birthdate`, not dismissed for this tab | POST `ajax_update_user_data` {csrf, user_id, user_property:"birthday", property_value} | "It Seems This Customer Do Not Have Birthday, Please Add a date" | `R/frontend/src/pages/customer-insights/editor.tsx:29` (manual profile edit) | **MISSING** (auto prompt) — P2 |
| C-51 | `ButtonStateManager` (disable Proceed + Fast Cash at 0.5 opacity; re-enable on every exit) | F:8104-8195 | — | — | — | CR `act`/`disabled` (CR:266-300) | DONE |
| C-52 | Customer Insights modal (`openCustomerInsights`, prefetch, sessionStorage cache 3 min, auto-open once after "Connect the User", expandable rec cards) | F:8199-8450; button F:649-654 | `show_customer_insights` (store allow-list) and connected user | POST `ajax_customer_insight` {csrf, store_id, email / telephone / user_id} -> `{status:200,data:<briefing>}` or `{status:4xx/502,message}` | "Connect a user first", "No insights available.", "Insight service error.", spinner "Pulling order history & live signals…", "No actions for this customer.", "No stock detail available." | CR:994 `CustomerInsights` (`R/frontend/src/pages/customer-insights/insights.tsx:198-256`, staleTime 180000); backend `customer-insights/briefing*.ts` | PARTIAL — toggle button with hover/focus prefetch; no auto-open after connect |
| C-53 | Shortcut **P** (proceed) | F:1023-1029 | Ignored if cart rows<=1, `#btn-confirm-order` exists or payment spinner visible | clicks `#btn-proceed` | — | `R/frontend/src/pages/cashier-shortcuts/shortcuts.ts:28`, CR:1662-1663 `data-cashier-action="proceed"` | DONE |
| C-54 | Shortcut **F** (fast cash) | F:1031-1037 | Same guard | clicks `#fast-checkout` (opens the fast dialog) | — | shortcuts.ts:29; FastCashCheckout.tsx:227-228 (focus only) | DIFFERENT — documented: focuses cash received; never completes |
| C-55 | Shortcut **R** (refresh) | F:1039-1042 | always | `window.location.reload()` + spin icon | — | shortcuts.ts:27 | DIFFERENT — documented state re-read (`cashier-shortcuts.md:13-15`) |
| C-56 | Shortcut **E** (exclusive benefits toggle) | F:1044-1047 | always | clicks `.exclusive-benefits-switch` | — | shortcuts.ts:31; CR `data-cashier-action="toggle-exclusive"` | DONE |
| C-57 | Shortcut **N** (NPS feedback toggle) | F:1049-1052 | always | clicks `.nps-feedback-switch` | — | shortcuts.ts:30; CR:1101 | DONE |
| C-58 | Shortcut **B** (focus barcode) | F:1054-1057 | always | focus `.prod-barcode` | — | shortcuts.ts:32; counter.tsx:566 | DONE |
| C-59 | Shortcut **S** (focus salesperson) | F:1059-1062 | always | focus `#salesperson` | — | shortcuts.ts:33 | DONE |
| C-60 | Shortcut **T** (new tab) | `L/order/templates/order/tab.html:241-243` | tab page | clicks `#create-new-tab` | — | shortcuts.ts:34; counter.tsx:666 | DONE |
| C-61 | **PP** "Proceed For Payment without extra steps(Fast) or Double click" | `L/order/templates/order/shortcuts.html` row 3 only | **No binding or dblclick handler exists in legacy** (grep: Mousetrap binds only p,f,r,e,n,b,s,t) | — | — | shortcuts.ts:93-97 (P twice within 500 ms -> same proceed control) | DONE — help-only in legacy |
| C-62 | **Keyboard Shortcuts** page `key-shortcuts` (`keyShortcutsView`, LoginRequired GET) linked from tab.html:134 | `L/order/urls.py:57`, V:3365-3367, `L/order/templates/order/shortcuts.html` | Any authenticated user | GET -> HTML table (Sr. No / Key / Description, 9 rows) | Rows verbatim: "Press 'R' To Refresh the Cart", "Press 'P' To Proceed For Payment", "Press 'PP' To Proceed For Payment without extra steps(Fast) or Double click", "Press 'F' For Fast Cash", "Press 'N' To Enable/Disable NPS Feedback", "Press 'E' To Enable/Disable Exclusive Benifits", "Press 'B + Scan' the Product' To Focus/Add Product in Cart", "Press 'S + Enter' To Select Salesperson From Dropdown", "Press 'T' To Create New Order" | `R/frontend/src/pages/cashier-shortcuts/reference.tsx`, help.tsx:21, shortcuts.ts:16-25 | DIFFERENT (P2) — route `/shortcut-reference` exists, but descriptions are rewritten (e.g. "Refresh the sale"); no Sr. No column; not verbatim |
| C-63 | Mousetrap library load | F:902 (`craig.global.ssl.fastly.net` CDN), tab.html:237 | — | — | — | native keydown handler shortcuts.ts:75-98 (also adds an off switch, preference.ts) | DONE |
| C-64 | Order show page **auto status poll** (Pine only) every 5000 ms, max 63 attempts | `L/order/templates/order/show.html:516-573` | Mark-payment modal with uploaded Pine txn (`plutus_id`), not Paytm (F `{% if not paytm_mid %}` show.html:571) | POST `ajax-transaction-status-check` {csrf, order_id, transaction_id} -> `{status:200,message,order_id}` | Approved -> "Transaction Completed Successfully" + `invoice/?auto_print=1` + reload. "INVALID PLUTUS ID" -> "Time Out, Initialize Transaction Again" + reload. "TRANSACTION NOT FOUND" -> reload. Else "Status :{s}, Check Status Again". Timeout text "Auto-check timed out after 5 minutes. Please check status manually." | PP:250-282, 352-358 (manual "Check payment status") | **MISSING** — no automatic polling in PaymentPanel/OrderPaymentActions (P1) |
| C-65 | **Status check** button `#btn-status-txn` (Pine/Paytm) | show.html:486, 574-576; `L/order/templates/order/index.html:621-667` | uploaded txn | Pine -> `ajax-transaction-status-check`; Paytm -> `ajax-transaction-status-check-paytm` | same as C-64 (index.html lacks the TRANSACTION NOT FOUND branch) | PP:352-358; payments/routes.ts:108 (`/reconciliations`) | DONE |
| C-66 | **Cancel txn** Pine (`ajax-transaction-cancel`, forced) | show.html:577-579, 639-675; index.html:737 | uploaded Pine txn | POST {csrf, order_id, transaction_id} -> `{status:200,message}` ("Approved", "TRANSACTION NOT FOUND", "CANNOT CANCEL AS TRANSACTION IS IN PROGRESS", "Failed") | Approved -> "Transaction Cancelled Successfully" + reload; in-progress -> "Cannot Cancel as Transaction is in Progress"; else "Status :…, Check Status Again" | PP:359-378 ("Cancel terminal payment"), payments/routes.ts:118, PG:221-224 (`CancelTransactionForced`) | DONE |
| C-67 | **Cancel txn** Paytm (`paytm-ajax-transaction-cancel`) with confirm "Do you want to cancel this transaction? As this payment would not be canceled on PayTm side and you have to cancel it mannually on machine" | show.html:583-636; index.html:680 | uploaded Paytm txn | POST -> message "Approved" / "No transaction found" / "Can not cancel as payment is already processed" / "transaction already canceled or compleated" | as C-66 | PP:379-384 (instructional text only); PG:296-302 throws `PAYTM_CANCELLATION_UNCONFIRMED` | DIFFERENT — documented (order-payments.md:17): no local-only cancel; the operator must reconcile a real provider void |
| C-68 | Payment modes by order (`ajax-get-payment-mode-by-order-id`) | index.html:779; V:4401-4413 | Orders list Mark payment | POST {order_id, counter_id} -> `{status:200,message:<mode dict>}` | — | payments/routes.ts:72-80 (`GET …/payment-options`) | DONE (label/numbering DIFFERENT, see C-29) |
| C-69 | Store-order **Cancel Order** (`ajax-order-cancel`) | show.html:1031; V:2900-2966 | method14 + pending | POST {order_id} -> `{status:200,message:<api resp>}` / 400 "Something went wrong" | — | `R/backend/parity/pending-order-cancellation.md`, `R/frontend/src/pages/checkout/cancellations/OrderCancellationActions.tsx` | DONE (owned by another fragment) |
| C-70 | `ajax-payment-status` (`AjaxPaymentStatusView`) | `L/order/urls.py:40`; V:685-768 | **No caller anywhere** in the pinned repo (grep of templates, JS, py). Revert buttons are commented (order-payments.md:3) | see Endpoint details | — | intentionally not implemented (`R/backend/parity/order-payments.md:3`) | DONE (N/A) |
| C-71 | Coupon/PG module **flag gating** (GLOBAL_SHOW_COUPON_MODULE, GLOBAL_SHOW_PG_DISCOUNT_MODULE, ENABLE_OLD_PG_DISCOUNT, ENABLE_NEW_PG_DISCOUNT, IN_HOUSE + user_type 1 override) | V:1563-1567, V:1635-1641; F:260, F:302-303, F:329 | — | — | — | none (`R/backend/parity/legacy-flags.md` says "not implemented"; grep finds no reader in backend/src or frontend/src) | **MISSING** — franchise stores would see coupon/PG controls that legacy hides |
| C-72 | Old-PG remark persistence (`localStorage["pgRemark"+tab]`, cleared on remove/order) | F:4264, F:4485, F:5697, F:6621, F:7075, F:7723 | — | — | — | discountMetadata on the server checkout (CS:1363-1387) | DONE |
| C-73 | Pine auto-cancel duration `AUTO_CANCEL_DURATION_IN_MINUTES` -> `AutoCancelDurationInMinutes` | terminal_helpers.py:47; `L/POSAdmin/settings.py:467` | — | — | — | PG:29-35 `TSS_TERMINAL_AUTO_CANCEL_MINUTES` (default 5, 1-60); payloads.ts:204 | DIFFERENT (P2) — env var renamed; the legacy name is not honoured |
| C-74 | Duplicate-order guard `window.orderProcessing` | F:5654-5663, F:6583-6589, F:7036-7044, F:7681-7687 | — | — | "Order is already being processed. Please wait..." | operation IDs plus CR `act` lock | DONE |

#### Endpoint details

All legacy views below are `LoginRequiredMixin` (session login) and perform **no role/store ownership check** unless stated. Request bodies are form-encoded POST.

- **AjaxPgDiscountView** `V:2190-2234`, POST `/orders/ajax-pg-discount/`. Request: store_id, tab_id, auth_token, user_obj (int), pg_discount (float), apply (int, default 1). Guard: `not pg_discount and apply` -> `{"status":400,"message":"Not applicable","data":{}}`. Reads the cart via `CreateOrderView.get_user_cart(end_user_cart=bool(user_obj))`, then POSTs API-v2 `pg` with `{localcart, pg_discount, apply, is_pos:true, store_id, [tab_id if no user]}` and header Authorization=auth_token. Response `{"status":200,"message":"PG","data":<upstream json>}` whatever the upstream status. DB: none (Redis via cart read).
- **AjaxStoreDiscountPGView** `V:2237-2281`: identical with `store_discount_pg` and API-v2 `store-discount-pg`.
- **AjaxCouponView** `V:2365-2413`. Request: store_id, tab_id, auth_token, user_obj, user_obj_data (customer email), coupon, is_verified. `email = user_obj_data if user_obj else request.user.email`. If "@thesouledstore." in email and not verified and `Coupon(voucher_code=coupon,is_employee_coupon=1)` exists -> `{"status":400,"message":"Please verify the user to use Employee Coupon"}`. Else API-v2 `coupon` `{coupon, localcart, is_pos, store_id, [tab_id]}` -> `{"status":200,"message":"Coupon","data":…}`. DB read: `Coupon` (order/models.py:698).
- **AjaxCartView** (subset used here) `V:1692-1800`: opr=delete platform=remove-coupon -> API-v2 `cart` (or `pos/cart`) `{payload:{operation:"delete",type:"meta",data:{name:"coupon"},localcart}, is_pos, store_id, [tab_id]}` (V:1900-1930), msg "Coupon Removed.". opr=clear -> `{payload:{operation:"clear"},localcart,store_id,is_pos,[tab_id]}` with an 8 s timeout (V:1966-1992), msg "Cart Clear successfully.", and on 200 deletes Redis keys `{MUser(pos_admin_id).id}_{tab}`, `{tab}`, `{store}_{tab}*`. Errors: "Something Went Wrong, Please Try Again" (None), "Something went wrong" (500), upstream `title` (400), upstream `message`. Success JSON: `{status:"success",message,extra:{total_item_cart},data}`.
- **AjaxUserRegisterView** `V:2416-2533`. Request: name, mobile (int), email, dob, customer_type, gstin, store_id, platform ("OTP"/"VERIFY"), otp, self_verify. Blank email -> `{mobile}@temp.id`. Duplicate check `MUser` telephone OR email -> 400 "Mobile No is already registered with us" / "Email is already registered with us". OTP: 6 digits from 1-9, Redis key `mobile` with `LOGIN_OTP_EXPIRY`, Gupshup SMS GET (`enterprise.smsgupshup.com/GatewayAPI/rest`, creds `GUPSHUP_SMS_USER_ID`/`GUPSHUP_SMS_PASSWORD`, mask TSSOUL, text "{otp} is your OTP to log in to The Souled Store."), plus `Helpers.spawn_whatsapp_otp_fallback` after `WHATSAPP_OTP_FALLBACK_DELAY_TIME` (20 s). Returns `{status:200,data:{},message:"OTP has been sent",platform}`. VERIFY: `self_verify or verify_otp` -> API-v2 `store-register` `{first_name, telephone, email, customer_type, gstin, birthdate, localcart:{}, store_id, pos_localcart:{}}` (no auth header). 200 -> `{status:200,data:<resp>,message:"Verified succesfully",platform}`; non-200 -> `{status:400,data:<resp>}`; wrong OTP -> 400 "OTP is incorrect". Writes: Redis only (the account is created upstream).
- **AjaxSendOtpView** `V:2536-2560`: user_id -> API-v2 `omnichannel-sendotp` `{user_id}` -> 200 "OTP Sent" if `resp.mobile` or `resp.email` true, else 400 "OTP Not Sent".
- **AjaxVerifyOtpView** `V:2563-2596`: tab_id, user_id, otp (int) -> API-v2 `omnichannel-verifyotp` `{user_id, otp}`. Non-200 -> 400 "Wrong OTP". 200 with message "OTP verified successfully!" -> Redis `{user_id}_{tab_id}=1` ex `REDIS_VERIFIED_USER_OBJECT_EXPIRY`, then `{status:200,"OTP is verified"}`. 200 with any other message -> the view returns None (Django 500; legacy defect).
- **AjaxValidateProcessOrderView** `V:2599-2683`: store_id, tab_id, auth_token, end_user. API-v2 `validatecheckout` `{is_pos, store_id, custom_data:null, [tab_id]}`; non-200 -> `{status:400,message:resp.text}`. Then `processorder` with payload = user cart + `{is_pos, store_id, custom_data, [tab_id]}`. 200: `is_valid_exclusive_buyer=false` if any `prod_type==5` and not end_user. Each gift voucher needs Redis `gift_card_{tab}_{gv_id}`, else 400 "Please add/save Gift Card No.". Returns `{status:200,message:"Ok",data,is_valid_exclusive_buyer}`. 400 -> `title` or "Something wrong in the cart"; other -> "Something wrong in the cart". No DB.
- **AjaxOrderView** `V:2686-2897`. Request as C-36. Combines `pg_disc_comment += "|"+store_disc_pg_comment` and `pg_discount_amount = int(pg+store)` when store>0. Redis OTP key `{user_id}_{store}_{counter}_{tab}` holds `{otp:(manager_id, pg_value)}`. `payment_method = "coc" if total_payable>0 else "prepaid"` (client-supplied). Gift-card data from Redis (`gift_card_{tab}_{gv}`, `gc_start_date_{gv}`, `gc_end_date_{gv}`). Upstream API-v2 `pos/order` payload built in `AjaxOrderView.order` V:2843-2879 `{payment_method, is_pos, store_id, counter_id, salesperson_id (Redis {store}_{tab}), admin_user_id (MUser.pos_admin_id), custom_data, custom_created_at, gc_data, [tab_id]}` (full payload owned by another fragment). Then: updates `orders.store_disc_pg_comment/reason`. If `len(pg_disc_comment)>1`, synchronous `tasks.pg_disc_otp_applied_email` (core/tasks.py:271-320: raw-SQL INSERT into `tss.store_pg_disc_addons` plus a mail "PG Discount Used For Order - {id}"). Sets `has_products.salesperson_id` per line from Redis (per-product, else master). Payment microservice POST `PAYMENT_MICROSERVICE_ORDER_URL` `{order, method, isValid, name, is_pos, store_id}`. `order_store.performance_json` update; `Helpers.generate_invoice_number` if missing; `Helpers.get_transaction_id`. On microservice 200/201: `gift_vouchers.status=0`; NPS `order_addons.is_nps_notification_checked=1` (create with shipped_location "MW1"); `tasks.send_sms.delay(order)`; delete Redis `{store}_{tab}`. Returns `{status:200,message:"Order Created",order_id,transaction_id,data:{}}`; failures: 400 "Something Went Wrong" (pos/order non-200) / "Something went wrong" (microservice).
- **AjaxOrderCancelView** `V:2900-2966`: order_id -> API-v2 `pos/cancel-pos-order` `{user_id, order_id}`. 200 -> `orders.payment_statuses=2, order_statuses=4`, has_products status = OrderStatus 4, transaction logs, per-product cancel logs, `product_store.stock += qty`, inventory sync, mongo product sync -> `{status:200,message:<resp>}`; else 400 "Something went wrong". (Detailed elsewhere.)
- **AjaxTransactionUploadView** `V:3020-3069`: order_id, transaction_id, amount (online), cash, cash_recieved (default = cash when 0), message, payment_mode ("mode[-machineId]"), district_transaction_id, credit_pincode_id. No order_store -> 400 "Failed". `amount+cash != orders.pay_amt` -> `{"status":"fail","message":"Incorrect Pay amount."}`. Routing: online>0 and mode not in {1001,1003,1004,1005,1006} -> `TerminalHelper.upload_billed_transaction` (Pine `V1/UploadBilledTransaction` `{TransactionNumber, SequenceNumber:1, AllowedPaymentMode:mode, StoreId, Amount:paise, UserID, MerchantID, SecurityToken, ClientID, AutoCancelDurationInMinutes}`, 30 s). APPROVED -> insert `pos_terminal_transactions` (platform txn_created) + `order_store.message`, "Approved". Otherwise "Open"/"Already Completed"/"Invalid Merchant"/raw ResponseMessage/"Failed". mode 1003/1004 -> `PaytmHelper.create_paytm_payment_request` (CARD/QR; Paytm `/payment/request`; 0009 "Approved", 0333 "Open", 0233 "Duplicate Order ID", 0007 "Terminal Not In Active State", 0002 "Request parameters are not valid", else resultInfo). mode 1001/1005/1006 -> `Helpers.complete_order(... others=True)` -> 200 "Cash/Online(Others) Delivered". cash>0 -> `complete_order` -> "Cash Delivered". `complete_order` (helpers/helpers.py:625-711): `orders` 4/3; `order_store` is_manually_paid, transaction_id, message, offline_payment, offline_payment_recieved, online_payment / online_other_payment, district_transaction_id, credit_pincode_id; `comments` status 3; `gift_vouchers.status=1`; `has_products.status`; `PosTransactionLog`; Kinesis push; `push_for_em`; `mark_stale(...,'PAYMENT')`. Also adds a Django `messages.success`.
- **AjaxTransactionCancelledView** `V:3071-3090`: active `pos_terminal_transactions` txn_created row or 200 "TRANSACTION NOT FOUND". Then `cancel_transaction(force=True)` -> Pine `V1/CancelTransactionForced` `{MerchantID, SecurityToken, ClientId, StoreId, PlutusTransactionReferenceID, Amount, TakeToHomeScreen:true}`. APPROVED -> log txn_force_cancelled, deactivate rows, transaction log, "Approved". Else "TRANSACTION NOT FOUND" / "CANNOT CANCEL AS TRANSACTION IS IN PROGRESS" / "Failed".
- **AjaxTransactionCancelledPaytmView** `V:3092-3115`: active `pos_paytm_transactions` row -> `paytm_cancel_transaction` (local only: deactivate + log; "Approved" / "No transaction found" / "Can not cancel as payment is already processed"). Else "transaction already canceled or compleated".
- **AjaxTransactionStatusCheckView** `V:3117-3136`: Pine `V1/GetCloudBasedTxnStatus`. "TXN APPROVED" -> log txn_completed + `complete_order(is_terminal=True)` -> "Approved". "TXN UPLOADED" -> "UPLOADED". "INVALID PLUTUS TXN REF ID" -> deactivate + log "Transaction Time Out for transaction Id : …" -> "INVALID PLUTUS ID". Else "Failed". Response `{status:200,message,order_id}`; missing row -> "TRANSACTION NOT FOUND".
- **AjaxTransactionStatusCheckPaytmView** `V:3138-3158`: Paytm `/payment/status`. 0000 -> deactivate + complete_order -> "Approved". ' 0011' (leading space; never matches) "sale txn has failed". 0404 "Merchant transaction id does not exits..!". Default "Payment has been cancelled or there is an issue with status check please reload the page". No row -> "no active transaction found for this order id please reload page or".
- **AjaxFastCheckoutView** `V:3160-3362`: request as C-43. Same pg/store combination as AjaxOrderView (uses `int()` and would raise on decimals). validatecheckout -> processorder -> payment_method from `calculations.total` -> gift-card Redis check ("Please add/save Gift Card No.") -> `place_order` (= `AjaxOrderView.order` + salesperson lines + microservice + invoice + NPS/SMS + Redis cleanup, V:3282-3345) -> `complete_transaction` (cash = `orders.pay_amt`, received default cash, `complete_order` with message = order_msg) -> pg addon email/insert, performance_json, store_disc_pg_* (errors swallowed). Returns `{status:200,message:"Cash Delivered",order_id}`; failures 400 "Something went wrong" / title / "Something wrong in the cart" / "Something Went Wrong" / raw validate text. Note: a prepaid (pay_amt 0) order returns 400 "Failed" from complete_transaction after the order is created (legacy defect; the UI routes prepaid elsewhere).
- **AjaxUpdateUserMobile** `V:3369-3383`: id, phone_number. No format validation. 400 "Invalid user id" / "Number already registered"; updates `users.telephone` -> `{"message":"Saved Successfully","mobile"}` (HTTP 200).
- **AjaxUpdateUserEmail** `V:3384-3398`: id, email. 400 "Invalid user id" / "Email already registered"; updates `users.email` -> `{"message":"Email successfully changed","email","status":200}`.
- **AjaxGetPymentModeByOrderId** `V:4401-4413`: order_id, counter_id -> `TerminalHelper.get_payment_mode(store_of_order, counter)` -> `{status:200,message:{"N. label":"mode[-machineId]"}}`. Modes come from active `pos_terminal_payment_modes` grouped by platform OTHERS/PINELAB/PAYTM. Machines come from `pos_machines`/`pos_paytm_machines` (filtered by counter only if counter_id truthy).
- **AjaxOnlineOrderView** `V:4486-4513` (`@async_login_required`): user_id, store_id. `Helpers.create_token(user_id, JWT_CUSTOM_EXPIRY_MIN)` -> `{WEB_URL}/pos/login/?token=…&api_key=WEB_LOGIN_API_KEY&pos_store_id=…&pos_user_id=<operator shadow id>` -> `{status:200,data:{web_url}}`; no user_id -> 400 with an empty url.
- **AjaxPGDiscOTPSend** `V:4583-4628` (`csrf_exempt`): user_id, tab_id, store_id, counter_id, pg_discount, user_name, total_amount. `pct = pg/(total+pg)*100`. Picks the greatest threshold <= pct in `PG_DISC_STORE_MANAGER_PERCENTAGE[str(store)]` (emails). No list and not `SEND_OTP_TO_ALL_MANAGERS` -> status 202. If the Redis key `{user}_{store}_{counter}_{tab}` exists -> "otp already sent" (no resend). Else `tasks.send_pg_disc_otp` (core/tasks.py:232-269; note: called synchronously, not `.delay`): recipients are active `User` by contact_email in the list, else all role-3 users. Each gets its own 6-digit (1-9) OTP. Mail "PG Discount OTP Mail" body "Hello {first_name}, … Your OTP for PG Discount - {otp} … Store - … Requested By - … PG Discount Value - … Total Bill Amount Without GST - … This OTP is only valid for 10 min". Redis value `{otp:(user.id,pg_discount)}` with ex `PG_DISC_OTP_EX_VALUE` (600). Response `{status,message}`.
- **AjaxPGDiscOTPCheck** `V:4631-4661` (`csrf_exempt`): verified if the OTP is a key in the Redis map and its stored pg value == the posted pg_discount (string compare) -> `{status:200,message:"verified"|"not verified"}`. Unlimited attempts; the key is not consumed.
- **AjaxPaymentStatusView** `V:685-768` (route `ajax_payment_status`, `L/order/urls.py:40`; **no caller**). Request: order_id, pay_type (is_manually_paid), transaction_id, p_status (default 1), message, offline_payment, online_payment, o_status. If manual: `offline+online != pay_amt` -> `{"status":"fail","message":"Incorrect Pay amount."}`. Updates `order_store` (is_manually_paid, transaction_id, message, offline/online). Updates `orders` to (p_status,o_status) if manual else (1,1). Inserts a `comments` row ("Store Order: {status} status changed by pos admin." / "Store Order: Status Reverted to PLACED by pos admin."), deleting status-3 comments on revert. Updates `has_products.status` to that OrderStatus name or "PLACED", with before/after logging. Kinesis + `push_for_em` (manual only), `mark_stale('MANUAL_PAID'|'PAYMENT_REVERSED')`, `PosTransactionLog`. Returns `{"status":"success","message":"Payment status updated successfully."}`; exception -> `{"status":"fail","message":str(err)}`.
- **AjaxGetQuotesView** `L/core/views.py:970-973`: GET -> `{"status":"success","data":random.choice(quotes_list)}`.
- **AjaxSyncCartView** `V:1994-2043`: tab_id, store_id, auth_token, is_cart_sync, user_id. Sets Redis `tab_id=user_id`. If sync: reads the guest cart, API-v2 `syncart`/`pos/syncart` `{token:<customer JWT>, localcart:{}, pos_localcart, is_pos, store_id}` (8 s), then clears the guest cart. Messages "Cart Synced" / "Could not read cart, Please Try Again" / "Cart Sync Failed, Please Try Again".
- **AjaxFetchTheProducts** `V:2045-2155`: see C-49 (documented in order-copy.md).
- **AjaxCustomerInsightView** `L/users/views.py:698-800`: email/telephone/user_id + store_id. Store allow-list `CUSTOMER_INSIGHT_STORE_IDS` -> 403 "Customer insights not enabled for this store.". None given -> 400 "Provide email, telephone, or user_id.". GET `CUSTOMER_INSIGHT_URL` with `X-API-Key: CUSTOMER_INSIGHT_API_KEY`, timeout (3.05,5). Errors 502 "Insight service returned a bad response." / service error text / "Insight error" / "No insights available." / "Insight service unavailable: {err}". Success `{status:200,data:<briefing>}`.
- **keyShortcutsView** `V:3365-3367`: GET renders shortcuts.html.

#### Coupon apply/remove

Legacy (C-05, C-06): coupon UI only when `show_coupon_module`. Apply posts the code plus the customer email and verified flag. The server blocks employee coupons only for unverified sessions whose email (customer, or operator for a walk-in) contains "@thesouledstore."; everything else is delegated to API-v2 `coupon` with the full localcart. The client treats `status 200 && data.meta` as success ("Applied Succesfully"). Any API-v2 error body is wrapped as status 200, so it falls through to `toast(data.data.title)` only when `data.meta` is absent. Remove uses the generic cart delete (`platform remove-coupon`) and requires the exact message "Coupon Removed.".
Rewrite: `PUT …/coupon` (routes.ts:362) -> CS:1141-1150 -> same upstream payload (payloads.ts:68-72); `POST …/coupon/removals` (routes.ts:373) -> payloads.ts:73-85. Gaps: (a) GLOBAL_SHOW_COUPON_MODULE/IN_HOUSE gating absent (C-71). (b) The employee-coupon rule is broader (every employee coupon needs a verified **customer**; walk-in employee coupons are always rejected with 403 CUSTOMER_VERIFICATION_REQUIRED, whereas legacy rejected them only via the operator-domain check, so same outcome for company operators). (c) Verbatim toasts are not reproduced.

#### PG discount OLD (ajax-pg-discount) and NEW (ajax-store-discount-pg) incl. manager OTP

Legacy:
1. **Visibility**: block shown if `show_pg_discount_module`; old control if `ENABLE_OLD_PG_DISCOUNT` (default 1); new control if `ENABLE_NEW_PG_DISCOUNT` (default 1). The old input/apply/remark are disabled unless role is in `PG_DISC_ROLE_PERM` (default [1,2,3,4]). The new control has no role gate.
2. **Apply/remove** (C-01..C-04) call API-v2 `pg` / `store-discount-pg` with apply 1/0. The client rejects NaN and <=0. The server rejects 0 with apply ("Not applicable").
3. **Remark/reason** are validated only at Proceed/Fast (C-16): old remark >=3, not only spaces/dots (no max); store remark 3–35, not only spaces/dots, reason required from 9 fixed options.
4. **Manager OTP** (C-17/C-18) only when role not in `PG_DISC_OTP_EXEMPT` (default [1,2,3]) and pg+store > 0. Value sent = `parseInt(pg)+parseInt(store)`. Thresholds: `PG_DISC_STORE_MANAGER_PERCENTAGE` JSON `{store_id:{pct:[emails]}}`, choosing the greatest pct <= `discount/(products_total+discount)*100`. With no list and `SEND_OTP_TO_ALL_MANAGERS` (default 1), every active role-3 user gets an OTP. If neither applies -> 202 (no OTP needed). OTPs are per manager, 6 digits from 1-9, `PG_DISC_OTP_EX_VALUE` (600 s). A second send within TTL does not resend ("otp already sent") but the client still toasts "OTP Sent To Managers". Check: unlimited attempts; match requires the same pg value.
5. **On order**: AjaxOrderView/AjaxFastCheckoutView combine comments `pg|store`, amount `pg+store` (int). They write `orders.store_disc_pg_comment/reason` and insert `store_pg_disc_addons` (with approver if the OTP was found in Redis, else applied-by only), then email the approver or operator.

Rewrite: single "Store and payment gateway discounts" form (CR:1465-1560) with a kind select; `PUT …/discount` (routes.ts:489) -> CS:1347-1388 (role gate `PG_DISC_ROLE_PERM` for both kinds, remark/reason validated at apply via `discountMetadataSchema`, policy.ts:19-28). Approval: `GET/POST …/discount-approval[/challenges|/confirmations]` (routes.ts:508-525), `DiscountApproval.tsx`, `discounts/repository.ts` (exempt roles :104, 5-attempt lock :354-356, send limits :263-275), same thresholds (policy.ts:171-197), same env names/defaults (policy.ts:52-74), same mail subjects (delivery.ts:164-181). The audit row `store_pg_disc_addons` uses `legacyDiscountAddons` (discounts/schema.ts:46); `store_disc_pg_comment/reason` are written at discounts/repository.ts:503-504.
Differences: flag gating MISSING (C-71). Role gate on the new/store kind and on removal (DIFFERENT). Old-PG remark max 35 (legacy none) and a combined 45-char cap (policy.ts:136-140; legacy unbounded). Explicit "Request manager approval code" button vs automatic send at Proceed. Attempt/send limits (security correction). The approval is bound to the exact quote (re-approval after any quote change; legacy only rechecked the value). Decimal vs `parseInt` amount.

#### Payment-mode controls (payment form, EDC upload, cancel, status)

Legacy form (C-24..C-35) appears for payable>0. Cash defaults to the full total, Card/UPI to 0, Payment Mode disabled until Card/UPI>0. Changing either amount auto-splits the other to sum to total and clamps to [0,total]. Cash Recieved is auto-raised to the cash portion. Change = received − cash. The message auto-composes the 4-line breakdown. Validations are listed in C-33, followed by the "Are you sure ?" confirmation. Payment mode values: OTHERS modes are plain `mode_id` (1001 Online Others, 1005 District, 1006 Credit-Pincode); PINELAB/PAYTM modes are expanded per active machine as `mode-machineId` with label "N. {mode} ({machine})" (terminal_helpers.py:273-317). Server routing (V:3047-3069): online>0 & mode∉{1001,1003,1004,1005,1006} -> Pine upload with `AllowedPaymentMode=mode` on the selected `PosMachine` (falls back to the first store machine when there is no machine id); 1003 Paytm CARD; 1004 Paytm QR; 1001/1005/1006 -> immediate completion with `online_other_payment`; cash only -> immediate completion. Pine/Paytm approval -> "Approved" (pending on terminal); the UI reloads and opens the order show page, where status/cancel live (C-64..C-67).

Rewrite: `PaymentPanel` (PP:216-249) `GET payment-options` (PR:1072-1131), `POST payment-attempts` with `{operationId, channel, cashAmount, onlineAmount, cashReceived, machineId?, externalReference?}`. Server validations: PR:85-115. Channels: `cash`, `other`(1001), `district`(1005), `pincode`(1006), `pine-card`(1), `pine-upi`(10), `paytm-card`(1003), `paytm-qr`(1004) (PR:130-141). Settlement writes the same `orders`/`order_store`/`has_products`/`gift_vouchers`/`comments` fields (PR:575-625). Status: `POST …/reconciliations` (routes.ts:108); Pine cancel `POST …/cancellations` (routes.ts:118, `CancelTransactionForced`, PG:221-224); Paytm cancel refused (PG:296-302).
Gaps: change-due display (C-27) and message textarea (C-32) MISSING. No auto-split/clamp (C-25, C-28). No "Are you sure ?" (C-34). Select shows "Cash" first and labels without the "N." prefix or a "Select Payment Mode" placeholder (C-29). Pine payment modes other than 1/10, and any other unmapped mode, are dropped, whereas legacy uploads any non-listed mode to Pine (C-29, P1; actual active `pos_terminal_payment_modes` rows UNKNOWN). Machines are always counter-scoped (legacy store-wide when counter 0). Definitive provider rejections at upload ("PLEASE APPROVE OPEN TXN FIRST", "TXN ALREADY COMPLETED", "INVALID MERCHANT", Paytm 0333/0233) map to `uncertain`, not a retryable failure (PG:94-97, 258-262). Pine "INVALID PLUTUS TXN REF ID" (legacy timeout -> deactivate -> re-initiate) maps to `uncertain` (PG:270-277), so the operator cannot re-collect without manual reconciliation (P1). Paytm local-only cancel replaced by a refusal (documented). `AUTO_CANCEL_DURATION_IN_MINUTES` renamed (C-73).

#### Payment status polling flow

- **create_order.html** itself does **not** poll. After `ajax-transaction-upload` returns "Approved" it alerts, reloads and opens `/orders/store/{id}/show/` (F:5981-5985, F:6746-6750). In the normal path, "Open"/"Failed"/transport error also open the show page (F:6751-6763, F:6798-6804).
- **show.html** Mark-payment modal for an uploaded txn (show.html:446-576): `doStatusCheck` posts `ajax-transaction-status-check` (Pine) or `-paytm` (Paytm). It auto-runs via `setInterval(doStatusCheck, 5000)` **only for Pine** (`{% if not paytm_mid %}`, show.html:571-573), max 63 attempts (~5 m15 s, matching AUTO_CANCEL + buffer), then shows "Auto-check timed out after 5 minutes. Please check status manually.". `onDestroy` clears the interval. Approved -> open invoice auto_print + reload; "INVALID PLUTUS ID" -> "Time Out, Initialize Transaction Again" + reload; "TRANSACTION NOT FOUND" -> reload; other -> "Status :{s}, Check Status Again".
- **index.html** (orders list, :560-760): same modal but **manual only** (`#btn-status-txn` click, :621-667), status URL chosen by `paytm_mid != "0"` (:633-637), cancel URLs :680/:737; payment modes fetched via `ajax-get-payment-mode-by-order-id` (:779).
- **AjaxPaymentStatusView** (`V:685-768`): grep across the pinned repo (all templates, static JS excluding vendor AdminLTE, all `.py`) finds only the URL registration `L/order/urls.py:40`. **No caller** exists; other services UNKNOWN (no sibling repos in scope). It is a manual mark-paid/revert API: it rewrites `order_store` payment columns, `orders` statuses, `comments`, every `has_products.status` (to the selected OrderStatus name, or "PLACED" on revert), transaction log, Kinesis/EM push and day-close stale marks.
- **Rewrite**: `PaymentPanel` restores the original attempt from local recovery (`payment-recovery.ts`) or `GET payment-attempts` (PP:119-195). Status is advanced only by the explicit "Check payment status" -> `POST …/reconciliations` (PP:250-282, 352-358). There is no interval polling (grep `setInterval|refetchInterval` in checkout/order-history finds none for payments). Settlement on `TXN APPROVED`/Paytm `0000` sets `has_products.status` = OrderStatus 3 name in the same transaction (PR:575-625), matching `complete_order`. Gap: Pine auto-poll (5 s ×63) MISSING (C-64, P1). `AjaxPaymentStatusView` intentionally not ported (no caller); a revert workflow is separately covered by `payment-reversals.md`.

#### Order submission (validate -> order)

Legacy:
1. `ajax-validate-process-order` (validatecheckout + processorder). It blocks membership without a user, empty carts and gift cards without numbers, and refreshes totals.
2. Toast "Order is ready to be placed. Please Wait for a while". Reads the NPS switch and `overall_performance_time` (localStorage `globalTime{tab}`), and resets salesperson selects to 0 (`$('.select2').val("0")`).
3. payable>0: payment form -> confirm -> `ajax-order` -> `ajax-cart clear` -> `ajax-transaction-upload`. Fast/prepaid path: `ajax-order` first. payable<=0: Order Confirmation -> `ajax-order` -> clear -> reload + `invoice/?auto_print=1`.
4. The upstream `pos/order` payload is built in `AjaxOrderView.order` (V:2843-2879), with confirmation to `PAYMENT_MICROSERVICE_ORDER_URL` (V:2881-2897).
5. Success also writes salesperson per line, performance_json, invoice number, gift voucher status 0, NPS add-on, SMS task and PG addon rows (see Endpoint details).

Rewrite: `POST …/quotes` (CS:1759-1797) then `POST …/order-submissions` (CR:1660-1676 -> CS:1855-1990). Revalidation, quote-binding check, discount approval authorization, `pos/order` via `orderPayload` (payloads.ts:103-122), checkpointing, `confirmationPayload` to the payment microservice (CS:1945), then `completeOrder`/finalizer (invoice finalizer.ts:145-170; NPS/SMS finalizer.ts:220-242). Then `PaymentPanel` for payable>0, or the prepaid status read.
Gaps: **salesperson mandatory check absent on the normal path** (C-16, P1). The order is created before payment details rather than after the confirmed payment form (C-21, DIFFERENT). No "Are you sure ?" (C-34). Invoice opens in a protected preview instead of `window.open(...auto_print=1)` (documented).

#### Fast checkout (ajax-fast-checkout) vs FastCashCheckout.tsx

Legacy (C-40..C-44): Fast Cash validates store-PG remark/reason, runs the manager OTP unless exempt or no discount, and routes zero payable to `PayProceedButtonFast`. It then opens the cash-only dialog (received default = payable; below-payable auto-bumped; change; editable message). `ajax-fast-checkout` does validate -> processorder -> order -> confirm -> `complete_order` (cash = pay_amt, message = order_msg) -> PG addon/performance/store_disc_pg. On "Cash Delivered" the UI clears the cart, reloads and auto-prints the invoice.
Rewrite: `FastCashCheckout.tsx:223-283` mounted at CR:1601. It is gated by quote + discount approval (`canStart`) and salesperson readiness (:55). It saves a settlement note (`PUT settlement-note`, routes.ts:557-567; HMAC-bound, latin1 ≤255), then performs the durable order + cash payment (`R/backend/parity/fast-cash.md`).
Differences: received < payable is an error, not an auto-bump (C-42, P2). Inline panel instead of a modal. The message is always required for positive totals (same as legacy "Provide a valid message"). Prepaid uses prepaid evidence rather than a cash attempt (documented correction). DONE otherwise.

#### Customer OTP / registration / mobile & email update

- Verification (C-07/C-08): legacy API-v2 omnichannel OTP and Redis `{user}_{tab}` flag vs rewrite `customer-otp` scoped 6-digit OTP (documented security correction, `customer-otp.md:12`). Verified state gates gift voucher/TSS money/points (markup F:279, 386, 418, 442-444) and employee coupons. Rewrite: `requireVerified` (CS:223-248) for wallet/employee coupon.
- Registration (C-10..C-14): rewrite `CustomerRegistration.tsx` + `customers/service.ts` (`store-register` at :693, `temp.id` default :229). MISSING Self Verify (C-12). Stricter GSTIN/mobile validation, default B2C, unified duplicate message, and an explicit connect step (C-14).
- Mobile add (C-45) / email add (C-48): rewrite `CustomerContactPanel` (CR:804) with proof-bound flows (`customer-contacts.md`). DIFFERENT by design. The automatic temp.id email prompt after adding membership is missing.
- Online-order handoff (C-09): DIFFERENT by design (`customer-website-handoff.md`).
- Birthday-missing prompt (C-50): MISSING.

#### Keyboard shortcuts

Inventory (all `Mousetrap.bind` in the pinned repo): create_order.html F:1024 `p`, F:1032 `f`, F:1040 `r`, F:1045 `e`, F:1050 `n`, F:1055 `b`, F:1060 `s`; tab.html:242 `t`. There is no other Mousetrap or dblclick binding in non-vendor files. P and F are suppressed when the cart table has <=1 row, `#btn-confirm-order` exists, or the payment spinner is visible. Mousetrap ignores keystrokes in inputs/textareas/selects by default. Help page `key-shortcuts` lists 9 rows including "PP", which has no implementation.
Rewrite: `R/frontend/src/pages/cashier-shortcuts/shortcuts.ts:16-130` (same 8 keys, PP = second P within 500 ms, modifier/IME/repeat/typing/modal suppression), reference page `reference.tsx` at `/shortcut-reference`, per-operator off switch `preference.ts`. F and R are deliberately different (documented, `cashier-shortcuts.md:10-15`). Help text is not verbatim (C-62, P2).

#### Gaps

- **P0**
  - C-16: the normal "Create order" path has no salesperson-selected check. Legacy blocks with "Please Select The Salesperson" (master <=0 or any per-product select = 0). Orders can be created with salesperson 0, which breaks staff attribution/commission (CS:1860-1990, CR:1660-1680; only fast cash checks).
  - C-38/C-29: definitive provider rejections at upload and Pine "INVALID PLUTUS TXN REF ID" are treated as `uncertain` (PG:94-97, 258-277). Legacy deactivated or rejected and allowed re-initiation. This can block billing of an order until manual reconciliation.
  - C-29: payment modes other than {1,10,1001,1003,1004,1005,1006} are silently dropped (PR:130-141). Legacy routes any other active mode to Pine `UploadBilledTransaction` with that `AllowedPaymentMode`, so configured tender types may be unavailable. The actual production mode set is UNKNOWN; downgrade to P1 if only those IDs are active.
- **P1**
  - C-71: coupon/PG module flag gating (GLOBAL_SHOW_COUPON_MODULE, GLOBAL_SHOW_PG_DISCOUNT_MODULE, ENABLE_OLD/NEW_PG_DISCOUNT, IN_HOUSE+user_type override) is not implemented, so franchise stores see controls legacy hides.
  - C-32: the payment message textarea is missing. `order_store.message` stores "Complete" instead of the cash/card breakdown for normal, split and terminal payments.
  - C-27: no change-due ("Cash To Be Return") display in PaymentPanel.
  - C-64: Pine auto status polling (5 s × 63 with timeout message) is missing; manual check only.
  - C-12: Self Verify (Without OTP) registration is missing.
  - C-02/C-03/C-04: the role gate is applied to store discount (PG) and to removals, where legacy has none, so role-5 operators lose access.
  - C-05: the employee-coupon verification rule differs (any employee coupon requires a verified customer).
  - C-14: registration does not auto-connect or sync the walk-in cart.
  - C-25/C-26/C-28: no auto-split or clamp of cash vs card, and no received auto-raise. Cash/card split UX differs (cash as a separate method).
  - C-21: order created before payment form confirmation (ordering differs from the legacy normal path).
  - C-48: no automatic temp.id email prompt after adding an exclusive membership.
  - C-52: customer insights do not auto-open after connect.
- **P2**
  - C-34: no "Are you sure ?" payment confirmation.
  - C-29: option labels without "N." numbering or "Select Payment Mode" placeholder; "No payment option available" note absent.
  - C-30/C-31: generic external-reference label and restrictive pattern.
  - C-42: fast cash received below payable errors instead of auto-bump.
  - C-62: shortcut help text not verbatim.
  - C-47: transient toasts replaced by inline messages; verbatim legacy toasts (e.g. "Applied Succesfully", "Removed Succesfully", "OTP Sent To Managers", "Order Created!") not reproduced.
  - C-50: birthday-missing auto prompt.
  - C-73: `AUTO_CANCEL_DURATION_IN_MINUTES` env name not honoured.
  - C-10: stricter GSTIN/mobile patterns and B2C default.
  - C-18: OTP attempt lock copy.
  - C-24: legacy transaction ID not shown before dispatch.

Status counts (C-01..C-74): DONE 33, PARTIAL 18, MISSING 7, DIFFERENT 16.

---

## Prioritised gap table (consolidated, de-duplicated across Parts A–C)

How to read this table:
- The order is by severity, then by blast radius.
- Rewrite paths are relative to the worktree. Legacy paths are relative to the pinned export.
- "→ D2" means the root cause is documented in `phase-d-order-routes.md`.
- Rows marked "needs decision" are deliberate rewrite hardening. Under the 1:1 rule they need explicit user sign-off, not silent acceptance.

| # | Sev | Gap | Legacy evidence | Rewrite evidence | Row IDs |
|---|---|---|---|---|---|
| 1 | P0 | Order submission is refused (503) unless four upstream contracts are configured: checkout projection, refund-allocation patch hash, customer consent, and customer context. The API-v2 patches for these are recorded as not deployed, so against the pinned API-v2 no ordinary sale can be completed. With partial configuration, the order is created upstream and then marked uncertain. | `order/views.py:2843-2879` dispatches `pos/order` unconditionally | `backend/src/modules/checkout/gateway.ts:331-338`, `:234-244`; `service.ts:1860-1880` | C-22, C-36, C-43; → D2 payload section |
| 2 | P0 | The normal "Create order" path has no salesperson guard. Legacy blocks with "Please Select The Salesperson" when the master salesperson is ≤ 0 or any per-product select is 0. Only fast cash checks this in the rewrite. | `create_order.html:5061-5136`, `:6183-6258`, `:7311-7427` (toasts at `:5068`, `:5074`, `:6190`, `:6196`, `:7318`, `:7324`) | `backend/src/modules/checkout/service.ts:1860-1990` (no check); `FastCashCheckout.tsx:254-256` (check exists) | C-16 |
| 3 | P0 | Definitive terminal rejections are recorded as `uncertain`. This covers Pine non-APPROVED upload, Paytm 0333/0233 and Pine "INVALID PLUTUS TXN REF ID". Legacy let the cashier re-initiate; the rewrite blocks the order until a manual reconciliation. | `create_order.html:5964-6025`, `:6729-6805`; `order/views.py:3020-3070` | `checkout/payments/gateway.ts:85-125`, `:250-280`; `PaymentPanel.tsx:216-249` | C-38 |
| 4 | P0 (conditional) | Payment-mode IDs outside {1, 10, 1001, 1003-1006} are silently skipped. Legacy sends any other active mode to Pine `UploadBilledTransaction` with that `AllowedPaymentMode`. Production's active mode set is UNKNOWN; if only these IDs are active, this drops to P1. | `create_order.html:5849-5857`; `helpers/terminal_helpers.py:273-317` | `checkout/payments/repository.ts:130-141`, `:1072-1131` | C-29 |
| 5 | P0 | A gift-voucher PIN of 4–20 digits is required up front. Legacy applies with `gc_pin:0` and prompts for "GC PIN" only when the API-v2 response says `is_pin_required`, so PIN-less vouchers cannot be redeemed the legacy way. | `create_order.html:3433-3557` | `backend/src/modules/checkout/routes.ts:400`; `CheckoutReview.tsx` ~`:1428-1438` | B-48, B-49, A-43 |
| 6 | P0 | Customer verification no longer uses API-v2 `omnichannel-sendotp`/`verifyotp`, and the gateway refuses those calls. The local `customer-otp` module is off unless `CUSTOMER_OTP_ENABLED` and providers are configured. Until then, Money, Points, gift-voucher and employee-coupon spending cannot be verified. The code length changes from 4 to 6 digits. | `order/views.py:2536-2598`; `create_order.html:4706`, `:4758` | `checkout/gateway.ts:282`; `customer-otp/options.ts:19`; `checkout/service.ts:1527` | C-07, C-08; → D2 B12/B13 |
| 7 | P0 (needs verification) | The checkout JWT carries `iev: true` for exclusive members. Legacy checkout tokens never do, because `create_token(user_id)` is called without an email. If API-v2 prices off `iev`, every quote shown in this inventory can differ. | `helpers/helpers.py:535-564`; `order/views.py:1522`, `:1534`, `:2010`, `:2060` | `backend/src/modules/checkout/crypto.ts:27` | → D2 payload |
| 8 | P1 | Coupon and PG module flags are not implemented: `GLOBAL_SHOW_COUPON_MODULE`, `GLOBAL_SHOW_PG_DISCOUNT_MODULE`, the `IN_HOUSE` + `user_type==1` override, `ENABLE_OLD_PG_DISCOUNT` and `ENABLE_NEW_PG_DISCOUNT`. The coupon, old-PG and new-PG controls are always shown. This is P0 if production sets any of these flags to 0 (production values UNKNOWN). | `order/views.py:1562-1567`, `:1635-1636`; `create_order.html:260`, `:302-303`, `:329`; `POSAdmin/settings.py:611`, `:613`, `:634-635` | no reader in `backend/src/config.ts`; `CheckoutReview.tsx` ~`:1280-1314`, `:1464-1557` | A-42, A-45, A-46, C-71 |
| 9 | P1 | Voucher to money diverges in four ways: <br>• `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` (default 0) is not honoured; a different env, `GLOBAL_VOUCHER_CONVERSION_ENABLED`, is used instead. <br>• The "Check" step that shows balance and validity is missing. <br>• Top-up writes a native ledger instead of calling the upstream `gift_voucher_to_tss_money`. <br>• Conversion is disabled without a contract that needs DDL the schema freeze forbids. | `create_order.html:287`, `:3790-4060`; `order/views.py:4518-4582` | `backend/src/modules/global-vouchers/options.ts`; `frontend/src/pages/global-vouchers/conversion.tsx`; `global-vouchers/service.ts:108-116` | A-44, B-51…B-54; → D2 C24/C25 |
| 10 | P1 | Cashback gating default differs. Legacy `TEN_PER_SWITCH` defaults to on (`int(env,1)`). The rewrite defaults to off and rejects the value `1`, so the "Cashback Earned" row and eligibility are hidden by default. | `POSAdmin/settings.py:542`; `create_order.html:538-545`; `order/views.py:1540`, `:1634` | `backend/src/modules/customer-insights/benefits-gateway.ts:5-13`, `:79`; `CartQuoteSummary.tsx:126-145` | A-65, A-75, Part A verification 3 |
| 11 | P1 | Store discount (PG) role gate is stricter. The rewrite applies `PG_DISC_ROLE_PERM` to store-PG apply and to every discount removal. Legacy `AjaxStoreDiscountPGView` has no role check; legacy only disables old-PG apply in the UI and shows "You do not have permission.". | `order/views.py:2237-2283`; `create_order.html:310-321` | `checkout/service.ts:1351`; `checkout/discounts/policy.ts` | A-45, A-46, C-02…C-04 |
| 12 | P1 | Ordinary cart lines cannot have their quantity changed or be removed inside an open checkout. Only complimentary lines and gift cards can be removed, and editing the draft after the session exists raises a snapshot error. Legacy allows `ajax-cart opr=set/delete` at any time before payment. | `create_order.html:1385`, `:1956`, `:2383`, `:2583`; `order/views.py:1692-1993` | `CheckoutCartLines.tsx`; `CheckoutReview.tsx` (complimentary removal only) | B-21, B-35, B-38, A-17, A-20 |
| 13 | P1 | Money and Points toggles diverge: <br>• They are not initialised from the applied cart state and do not apply when toggled. <br>• Submitting can silently drop applied points or apply the full Money balance. <br>• `custom_tss_money` (partial money) semantics differ. <br>• There is no `balance > 0` gate, no `used/total` badge and no "(Partial Money Applied)" text. | `create_order.html:3057-3330`; `order/views.py:2138-2189` | `routes.ts:382` (`PUT …/wallet`); `checkout/payloads.ts:42-44`; `CheckoutReview.tsx` ~`:1346`, `:1397` | B-44…B-46, A-49…A-51 |
| 14 | P1 | Salesperson: the sale-level choice does not override per-product choices, and there is no "Not Selected" option to remove an assignment. | `create_order.html:2341`, `:2747`; `order/views.py:2969-3019` | `SalespersonAssignments.tsx`; `checkout/service.ts:1403-1422` | B-34, B-39, A-06, A-18 |
| 15 | P1 | Payment panel diverges: <br>• No message textarea: `order_store.message` stores "Complete" instead of the cash/card breakdown. <br>• No "Cash To Be Return" change-due display. <br>• No auto-split or clamp of cash vs card. <br>• No "Are you sure ?" confirmation. | `create_order.html:5820-5870`, `:6400-6450` | `checkout/payments/repository.ts:603`; `PaymentPanel.tsx:402-435` | C-25…C-28, C-32, C-33, C-34 |
| 16 | P1 | Automatic Pine status polling (every 5 s, up to 63 tries, with a timeout message) is missing; only a manual "Check payment status" button exists. | `order/templates/order/show.html:512-573`; `index.html:633-636`; `order/views.py:3117-3159` | `PaymentPanel.tsx:250-282`, `:352-358` | C-64 |
| 17 | P1 | The order is created before the payment form is confirmed. Legacy's normal path created no order until the operator confirmed payment; only fast checkout created first. | `create_order.html:6177-7239` | `CheckoutReview.tsx` ~`:1660-1680` then `PaymentPanel.tsx` | C-21, C-39 |
| 18 | P1 | Gift cards diverge: <br>• Blank start date ("Today's") and blank end date ("No Expiry") cannot be entered. <br>• There is no custom-value prompt when adding a card ("Add Original Value …" / "Submit Desired Value"). <br>• Dates are always sent explicitly, where legacy sends `""`. | `create_order.html:205-206`, `:2293-2330`, `:2533`; `order/views.py:4314-4400` | `GiftCardItems.tsx:77-98`; `checkout/service.ts:2160-2175` | A-32, A-33, B-12, B-30, B-32, B-33 |
| 19 | P1 (needs decision) | Customer registration: the "Self Verify (Without OTP)" path is missing. After registration there is no automatic connect or walk-in cart sync. | `create_order.html:4856-4857`, `:4954-4960`, `:5002-5024`; `order/views.py:2448` | `CustomerRegistration.tsx:154`, `:268-280` | C-12, C-14 |
| 20 | P1 | Employee-coupon verification rule differs. The rewrite verifies every employee coupon; legacy did so only when the customer's (or walk-in operator's) email had the company domain. | `create_order.html:4496-4598`; `order/views.py:2365-2415` | `checkout/service.ts:1141-1150` | C-05 |
| 21 | P1 | NPS feedback: legacy always sends `nps_feedback_switch=true` from a checked, disabled box. The rewrite defaults to `npsFeedback:false` and adds an SMS opt-out toggle that legacy lacks. | `create_order.html:76`, `:5646` | `checkout/service.ts:648`; `CheckoutReview.tsx` ~`:1077-1120` | A-04, K-06, B-05 |
| 22 | P1 | Customer lookup bypasses upstream `check-user-exclusive`, so blocked-user handling and the exclusive/cashback pre-display are lost. The query format is restricted, and the connected customer cannot be switched within a sale. | `create_order.html:2886-2998`; `users` views `ajax_user_details` | `backend/src/modules/checkout/customers/service.ts` | B-42, B-43 |
| 23 | P1 | The product picker and inventory lack these columns: special and exclusive price, held stock, storage stock, barcode, and the barcode-missing marker. Troubleshoot is limited to role 1 with `userType` 1 behind a preview/apply step; legacy offered it to every cashier with one click. | `create_order.html:1770-1872`; `core/datatables/store_products_datatable.py:276-312` | `frontend/src/pages/counter-catalog/`; `catalog-details/maintenance-authority.ts:8` | A-93, B-26, B-28, B-29 |
| 24 | P1 | Verified and applied state is not visible: <br>• "User is verified !" and "Verify the user to use Tss Money/Points/Voucher !" are absent. <br>• Applied coupon, voucher, PG amounts and Money are not prefilled. | `create_order.html:265`, `:279`, `:309`, `:335`, `:442` | `CheckoutReview.tsx` (empty `useState('')`) | A-41, A-42, A-43, A-45, A-46, A-51 |
| 25 | P1 | "Order on website" handoff diverges: <br>• Expiry is 300 s instead of `JWT_CUSTOM_EXPIRY_MIN` (10 min). <br>• The explanatory text is missing. <br>• Extra consent steps are added. <br>• The feature is off by default. <br>• The legacy `{WEB_URL}/pos/login/?token=…` URL is not produced. | `order/views.py:4486-4517`; `create_order.html:4785` | `backend/src/modules/customer-website-handoff/options.ts:15`, `:29` | A-81; → D2 C23 |
| 26 | P1 | These automatic prompts are missing: the `temp.id` email popup after adding an exclusive membership, the birthday-missing popup, and auto-opening customer insights after connect. | `create_order.html:7926` (`email_popup`), `:8387` | — | B-24, C-48, C-50, C-52, A-79 |
| 27 | P1 | Cart-read failure message "We have a little problem, please try again later !" is missing. Pass-through of the upstream `title` is UNKNOWN. | `order/views.py:1516-1691` | `checkout/gateway.ts:266-279` | A context guards |
| 28 | P2 | Summary labels differ: <br>• "Discount (excluding coupon)", "Total before rounding", "Official payable". <br>• "Rounding value" lacks the "-" prefix. <br>• TSS Points are shown with ₹. <br>• The "Membership Savings" relabel for `prod_type==5` is missing. <br>The values come from the same quote fields. | `create_order.html:449-547`, `:2509-2520` | `CartQuoteSummary.tsx:63-145`; `backend/src/domain/checkout-quote-display.ts:28-49` | A-54, A-56, A-62…A-64, B-36 |
| 29 | P2 | Legacy toasts are not reproduced verbatim, for example "Applied Succesfully", "Removed Succesfully", "OTP Sent To Managers" and "Order Created!". The rewrite shows inline messages. Payment-mode labels are not numbered and the "Select Payment Mode" placeholder is absent. | `create_order.html:7906` (`toast_message`) and call sites | various | C-29, C-47 |
| 30 | P2 | Keyboard shortcuts diverge: <br>• F focuses instead of clicking. <br>• R is inactive on the counter page. <br>• The help text is not verbatim. <br>• The rewrite adds shortcuts (PP, T, N, and an "Enable letter shortcuts" preference). | `order/templates/order/shortcuts.html`; `Mousetrap.bind` calls in `create_order.html` | `frontend/src/pages/cashier-shortcuts/shortcuts.ts`, `help.tsx` | K-01…K-11, B-01, B-07, C-62 |
| 31 | P2 | Fast cash with received below payable errors, where legacy auto-raised the received amount. `AUTO_CANCEL_DURATION_IN_MINUTES` is renamed (`TSS_TERMINAL_AUTO_CANCEL_MINUTES`). GSTIN and mobile patterns are stricter, and B2C/B2B labels changed. | `create_order.html:7690`; `order/views.py:3160-3364` | `FastCashCheckout.tsx`; `backend/src/config.ts` | C-10, C-42, C-73, A-70 |
| 32 | P2 | Item count excludes gift cards and complimentary quantity. Complimentary links use the parent id. Other banner and badge wording differs ("Freebie", connected/not connected). | `create_order.html:131-176`, `:1601` | `CheckoutCartLines.tsx` | A-01, A-02, A-08, A-21, A-22, B-22 |

Legacy security defects the rewrite must **not** copy. They are recorded so they are not mistaken for parity gaps:
- Raw f-string SQL in `AjaxUserUpdateView` (`users/views.py:684-689`) and in the behaviour query.
- `AjaxUpdateEndUserDataView` has no effective login check.
- The wallet and gift-voucher views trust a client-supplied `is_verified` field.
- `AjaxGiftVoucherCheck` and `AjaxGiftVoucherConvert` call upstream without an Authorization header.

UNKNOWN items carried forward:
- Production values of every flag in `legacy-flags.md`.
- Callers of `AjaxPaymentStatusView` outside this repository.
- API-v2 handling of `iev` and of a non-`0` PIN for vouchers that have no PIN.
- The production set of active payment modes.
- Whether per-line salesperson defaults are persisted at order time.
