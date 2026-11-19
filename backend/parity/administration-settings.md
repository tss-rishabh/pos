# Delivery timing and order settings

Source: `PosDeliveryTimingEdit`, `AjaxDeliveryTimingUpdate` (`core/views.py:1794-1879`),
`AjaxThresholdUpdate`, `AjaxOrderBufferUpdate`, `AjaxEcomSettingUpdate` (`core/views.py:1998-2167`).

## Effects (inline, after commit)

The settings outbox and `worker:settings` are removed. After the writer transaction commits, the service
runs the source effects in order: common-Redis `SET HYPERLOCAL_STOCK_THRESHOLD` /
`SET ORDER_CREATION_BUFFER_TIME_IN_SEC` (seconds), and the Slack notices (buffer, slot timing, slot
availability, ecommerce threshold, ecommerce availability) with source text. A failed effect is logged
(`administration.settings-effect.failed`, static code) and never raised. Slack failures are swallowed in the
source too (`helpers/helpers.py:1117-1121`); a common-Redis failure raised a 500 in the source after the
database update was already committed.

Options (`settings-options.ts` `readSettingsOptions`): `COMMON_REDIS_URL`, `SLACK_URL`,
`ECOM_DELIVERY_CHANGES_TIME` (default 180, 1-3600). `SETTINGS_WORKER_*` are unused.

## Replay

Each mutation carries `operationId`. `pos:idem:settings:{operationId}` holds
`{actorId, hash, state: pending|done, result}` (SET NX, EX 86400). A completed replay returns the stored
result without effects; reuse with other input or by another actor is 409 `SETTINGS_OPERATION_REUSED`; a
replay while the first is running is 409 `SETTINGS_OPERATION_IN_PROGRESS`. Legacy has no replay
protection. Optimistic version checks and row locks are unchanged; no administration lock is taken
(legacy has none).

## Ecommerce

Role 1 only (`async_role_required([SUPERADMIN])`). The cooldown is the legacy key
`ecom_delivery_{store_id}` on the POS Redis, set with `SET NX EX ECOM_DELIVERY_CHANGES_TIME` (source used
EXISTS then SET) before the update and deleted when nothing changed (`core/views.py:2108-2132`). A change
sends the notices and enqueues `core.tasks.sync_ecom_inventory` `{store_id}` on `core`; an enqueue failure
is logged at error level. Rewrite-only refusals (stale version, store not found) also delete the key so a
refused request does not hold the cooldown.

| Case                       | Legacy                                                                                                       | Rewrite                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| cooldown active            | 200 `{status:"fail", message:"You cannot perform the action at this time, Please try again after sometime"}` | 409 `ECOMMERCE_CHANGE_COOLDOWN`, same message |
| no change                  | 200 "No changes detected"                                                                                    | 200 "No changes detected"                     |
| change                     | 200 "Ecom Setting Updated! Please wait, It will take time to reflect"                                        | 200, same message                             |
| threshold/buffer saved     | 200 "Data Successfully Updated"                                                                              | 200, same                                     |
| slot timing / availability | redirect "Delivery Time Slot has been updated!" / "Updated"                                                  | 200, same messages                            |

Removed tables: `pos_rewrite_settings_effects`, `pos_rewrite_settings_mutations`,
`pos_rewrite_ecommerce_changes`.
