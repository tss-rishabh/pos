# Legacy settings flags the rewrite must honour

Source: `backend-pos-web@78d5b63`. Status: **not implemented** in the rewrite as of `eea480c`.
Each flag must be read from env with exactly the legacy default and parsing, validated by zod in `backend/src/config.ts`.
The exchange flag is covered in [exchange-cell-guards.md](exchange-cell-guards.md).

| Env | Legacy default / parse (`POSAdmin/settings.py`) | Where used | Behaviour |
|-----|-----------------------------------------------|-----------|-----------|
| `EXCHANGE_ENABLED_STORE_IDS` | `"1"`; `"all"` → all stores; else comma ints (`:588-592`) | `order/views.py:338` | See exchange-cell-guards.md |
| `GLOBAL_SHOW_COUPON_MODULE` | `int(env, 1)` (`:634`) | `CreateOrderView` `order/views.py:1566` → `create_order.html:260` | `show_coupon_module = GLOBAL or (store.category == "IN_HOUSE" and request.user.user_type == 1)`; hides the coupon block in checkout |
| `GLOBAL_SHOW_PG_DISCOUNT_MODULE` | `int(env, 1)` (`:635`) | `order/views.py:1567` → `create_order.html:302` | Same formula; hides the whole PG-discount block |
| `ENABLE_OLD_PG_DISCOUNT` | `int(env, 1)` (`:611`) | `order/views.py:1635` → `create_order.html:303` | Inside the PG block: show the old PG-discount control |
| `ENABLE_NEW_PG_DISCOUNT` | `int(env, 1)` (`:613`) | `order/views.py:1636` → `create_order.html:329` | Inside the PG block: show the new PG-discount control |
| `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` | `int(env, 0)` (`:622`) | `order/views.py:1639` → `create_order.html:287` | Shows the voucher→money check/convert control (default **off**) |
| `ENABLE_WHATSAPP_INVOICE` | `env 'False'`, true if lower in `['true','1']` (`:638`) | `ShowOrderInvoiceView.get` `order/views.py:798` | Each store-invoice view GET (after auth/store checks) POSTs `{order_id}` to `MJML_HOST + 'api/v2/mailr/send-invoice-whatsapp/'` (`helpers/helpers.py:2062`). Non-200 is only logged; the page still renders. Must go through a message adapter, sandboxed in verification |
| `LOGIN_FIXED_OTP_ENABLED` | `int(env, 0)` (`:494`) with `LOGIN_FIXED_OTP` (str, stripped) and `LOGIN_FIXED_OTP_USER_IDS` (comma ints, non-digits skipped) (`:495-496`) | `core/tasks.py:92` login OTP send | If enabled, OTP non-empty and user id in list: store the fixed OTP under the normal login-OTP key and skip SMS/email |
| `MPOS_QR_SINGLE_DOWNLOAD` | `int(env, 1)` → bool (`:539`) | imported in `core/views.py:46`, **never read** | No behaviour; do not implement |

Notes:
- The coupon/PG formula uses the **checkout store's** `category` and the **operator's** `user_type`.
- The flags are passed into the checkout template context. The rewrite should return the resolved booleans in the
  checkout bootstrap/quote response and gate the same controls in `frontend/src/pages/checkout`.
- Owner: W4 (checkout), except `LOGIN_FIXED_OTP_*`, which belongs to W3 (auth).
