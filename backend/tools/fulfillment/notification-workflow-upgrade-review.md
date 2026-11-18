# Notification readiness revalidation

The unchanged complete seven-group native/source/App target passed in 43.22 seconds on production `2db8152`, including the pre-upgrade broker-readiness fix integrated as `1fa260f`. The separate upgrade receipt binds 1,245 unchanged rewrite inputs (explicitly including `notification-stream.ts`) and 17 pinned original source inputs. The original receipt remains byte-for-byte intact.

This run uses the actual production App, real native cookies/API/MySQL, original Channels/Django/native methods and header controls, real Redis, and the fixture's actual TCP WebSocket upgrade proxy. Both scoped strict projects and changed/runtime ESLint passed before the canonical invocation. No test, assertion, deadline, payload protocol or fixture behavior changed for this run. Exact owned container and anonymous volumes were verified absent afterward.

The controlled ordering regression remains separate evidence: source `notification/consumers.py:10–14` awaits `group_add` before acceptance; the unit on old `dbe23bb` proved that transport OPEN previously preceded broker readiness. The fixed implementation passed that original unit and its 12-case lifecycle/security file before this native run. The new result validates integration on the fixed graph; it does not establish the cause of the earlier isolated auxiliary zero-frame timeout.

The proposed admission scope remains exactly `notification/routing.py:6` and `notification/urls.py:7`. Entire base/navbar templates, global shell/reminder features, providers/warehouse/history/downstream order resolution, financial/webhook producers, OS speaker output, desktop package acceptance and full release readiness remain excluded. Root retains independent admission ownership.

Canonical command and dependencies remain those in `notification-workflow-review.md`. The new retained log is `/tmp/pos-notification-private-20261118/native-workflow-upgrade.log`; its exact digest is in `notification-workflow-upgrade-receipt.json`. Earlier original and red diagnostic receipts/logs are preserved.
