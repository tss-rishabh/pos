# Exchange cell guards — legacy semantics (for W4 re-implementation)

Source: `backend-pos-web@78d5b63`. These are the exact rules the rewrite must reproduce.
Owner: W4 (checkout/returns re-home). Status: **not yet implemented** in the rewrite.

## 1. `exchange_feature_enabled` (EXCHANGE_ENABLED_STORE_IDS)

`POSAdmin/settings.py:588-592`

```
raw = env EXCHANGE_ENABLED_STORE_IDS, default "1", stripped
EXCHANGE_ENABLED_FOR_ALL_STORES = raw.lower() == "all"
EXCHANGE_ENABLED_STORE_IDS = {} if all else {int(s) for s in raw.split(",") if s.strip()}
```

`order/views.py:338-340` (`get_exchange_context`):
`exchange_feature_enabled = FOR_ALL_STORES or (checkin_store_id and checkin_store_id in STORE_IDS)`.

- It is computed from the operator's **check-in store**, not the order's store.
- Legacy enforces it **in templates only**: `online/_return_exchange_cells.html:10,22,66` and
  `order/show.html` (~lines 207, 219, 276-280). No server-side exchange endpoint checks it. The rewrite
  should gate the same UI states. Adding a server check would be stricter than legacy, so it needs user approval.
- Default `"1"` means only store id 1 has exchanges unless the env is set. The rewrite config must use the same
  default and parsing. Invalid integers raise at startup in legacy (`int(s)`), so fail-fast config validation is parity.

## 2. `prod_type == 8` — "Not Applicable For Exchange"

Online order template `order/templates/order/online/_return_exchange_cells.html`. Branches are evaluated in order:

| # | Condition | Exchange UI | prod_type 8 checked? |
|---|-----------|-------------|----------------------|
| 1 | `not is_return or not is_exchange` | "Check-in first to check exchange status" | no |
| 2 | `hp.failed_exchange` (retryable, `pos_exchange_retryable`) | retry button / "contact tech support" if flag off / "retry from <store>" if wrong store | **no — retry allowed for type 8** |
| 3 | `hp.return_exchange_merged` (both statuses true and `return_upto == exchange_upto`, `order/views.py:534`) | return button + exchange button if flag on | **no** |
| 4 | statuses/reasons empty and `hp.status == PRODUCT_RETURNED` | "Already Returned" | no |
| 5 | statuses/reasons empty and status `EXCHANGE_INITIATED`/`EXCHANGE_COMPLETED` | "Already Exchanged" | no |
| 6 | else → exchange cell: | | |
|   | `hp.product.prod_type == 8` | text **"Not Applicable For Exchange"** (exact casing) | **yes, first** |
|   | `hp.exchange.status and exchange_feature_enabled` | exchange button + "Valid for exchange till {exchange_upto}" | |
|   | `hp.exchange.status` | badge "Not applicable for exchange" | |
|   | `hp.exchange.reason` | the reason | |
|   | status PRODUCT_RETURNED / EXCHANGE_* | "Already Returned" / "Already Exchanged" | |
|   | otherwise | badge "Not applicable for exchange" | |

Store order template `order/templates/order/show.html` (~line 258) has a related **return** guard.
In the fallback branch, when the line is neither returned nor exchanged:
- The **force-return** button (`id="force-return"`, `click-type="extreme"`) is shown only when
  `hp.status == "DELIVERED" and hp.product.prod_type != 8`.
- Otherwise the badge "Not applicable for return" is shown.
- The rewrite must apply the same type-8 exclusion to force return on store orders.

So the guard is **narrow**:
- It suppresses a *new* exchange only in branch 6.
- Failed-exchange retry/recovery (branch 2) and the merged return+exchange cell (branch 3) stay available for type 8.
- `prod_type` is the **current** `products.prod_type` of `hp.product`, not a value snapshotted on the order line.

## Implementation notes for W4
- Eligibility response per line must expose enough to choose the branch: failed-exchange retry info, merged flag,
  `productType` (current), exchange status/reason/upto, return status/reason/upto, line status.
- Branch selection belongs in one pure function, tested against every row of the table above. Store the expected
  outputs as golden JSON derived from this table.
