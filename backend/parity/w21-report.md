# W21 report: release blocker 3 (flaky tests)

Branch `w21/flaky`, from `1ed3b130`. Everything ran on loopback:
- a private MySQL 8.4 (`--sql-mode=''`, port 33921, data dir under the worktree `.tmp/w21`);
- the stacks' own private `redis-server` instances;
- the real backend and the W17 fakes.

Nothing connected to production. Every service was stopped at the end.
Node 24.22.3, Electron 45.3.2, Playwright 1.65.1.

## 1a. Flake 1: frontend `tests/administration/workflows.test.ts`, profile image upload

**Cause (confirmed and reproduced deterministically).**
- `PrivateImages` (`frontend/src/components/private-images.tsx`) rendered two independent status paragraphs:
  - the progress text while `busy` (`phase !== 'idle'`);
  - the saved `message`.
- `attach()` sets `message = 'Image saved.'` and then awaits `onAttached()`, which is the profile reload. `phase` stays `attaching`
  until `run()` finishes.
- So during the reload both "Checking and attaching your image…" and "Image saved." were shown. Only the first was stale: it
  belonged to the same attempt but was no longer true.
- The strict `getByRole('status')` locator failed whenever the reload was slow enough to be observed. That happened under
  full-suite load.
- Holding the reload in the test reproduces it 3/3: `toHaveCount(1)` received 2.

**Fix (component).** The component now shows one status, derived from the current attempt:
- the saved message once the attachment is confirmed;
- otherwise the phase's progress text.

The controls stay disabled until the reload settles, as before. `run()` still clears the message at the start of every
attempt, so an earlier attempt's message is never shown.

**Test made deterministic** (no timeouts lengthened, no retries).
- After clicking "Retry image attachment", the test holds the profile reload with a one-shot `page.route` gate. While the reload
  is pending it asserts:
  - exactly one status, reading "Image saved.";
  - the retry button is gone.
- It then releases the reload and waits until the file input is enabled again.
- It also waits for the cover-image attempt to finish (input enabled, saved status) before choosing the next file.
- Fake timers do not apply: nothing in this flow is timer-driven. The race is a pending request, which the route gate controls.
- After the fix: the file passed 3/3 in a row (18/18 tests each time).

Commits: `4e6e8e6f`, `b8bbd202` (formatting).

## 1b. The authenticator dialog: the same race as flake 1 (added at the coordinator's request)

- Test: `workflows.test.ts` › "verifies a local authenticator QR…". It was seen in my first full run and in W20's run.
- Error: `getByRole('dialog').getByRole('status')` resolved to "Authenticator replaced." **and** "Loading authenticator
  settings…".
- **Cause:** `frontend/src/pages/administration/mfa.tsx`. `refresh()` sets `message` and then awaits `onChanged()`, a React
  Query invalidation that refetches the operator list. `busy` stays true during that refetch, so the busy status rendered beside
  the message status.
- **Fix:** the busy text now yields to the current action's message, `busy && !message`. `run()` clears the message when each
  action starts.
- **Test:** holds every `/api/v1/` GET except the dialog's own `/mfa` read while the reset completes, then asserts exactly one
  status, "Authenticator replaced.". It releases the refresh and waits for "Close authenticator" to be enabled.
- **Results:** the gated test failed 3/3 before the fix (`toHaveCount(1)` received 2). After the fix the file passed 18/18 in
  3/3 runs.
- Commit: `2cc7ab79`.

## 1c. Flake 3: backend `tests/checkout/customer-mysql.integration.test.ts` (added at the coordinator's request)

- **Case:** "locks a registration after five wrong codes and rate-limits resends per phone". W19 saw it fail once with
  "promise resolved … instead of rejecting".
- **Cause (shared state: the clock-hour bucket).** `consumeSendBudget` (`src/modules/checkout/customers/service.ts`) counts sends
  per **clock hour**: key `…:sends:phone:{digest}:{floor(now/1h)}`, limit 5. This is the documented fixed-window design.
- The test's injected clock started at `Date.now()` when the file loaded and advanced by `3600_001` ms per test. Its position
  within the hour therefore followed the wall clock at the start of the run.
- The case sends at T, T+61 s, T+122 s, T+183 s and T+244 s, then expects the send at T+305 s to be refused. For a run started
  in roughly the last 5 minutes of a wall-clock hour, those sends straddle an hour boundary. The per-phone count resets and the
  sixth send succeeds. Running the file again a few minutes later passes, which is why it passed 11/11 in isolation.
- **Reproduced** by temporarily placing the case 100 s before an hour boundary. It failed with W19's exact message:
  `promise resolved "{ status: 'succeeded', …(2) }" instead of rejecting`.
- **Fix (test).** `beforeEach` now starts every case at the beginning of a fresh clock hour, at least an hour after the previous
  case: `clock = (floor(clock / 1h) + 2) * 1h`.
- The per-hour budget itself is the documented product design (table-disposition, `service.ts` key comment), so I did not change
  it.
- **Results:** the file passed 11/11 in 3/3 runs. With the initial clock forced to 100 s before an hour boundary it passes 11/11.
- Commit: `42926ef3`.

## 2. Flake 2: Electron `e2e-desktop/offline-billing.spec.ts`, "blocks billing after the offline time window"

### 2.1 What W18's run 1 actually shows

Sources: W18's saved output and trace in the session scratchpad (`w18/pw-desktop-run1.txt` and
`w18/pw-desktop-run1-results/*/trace.zip`). The trace and the backend's own request log give an exact timeline:

| UTC | Event |
|---|---|
| 13:03:53 | Last online heartbeat. Then `network(false)`. |
| 13:04:08 | Heartbeat fails, so the device is offline. The sale is billed through the bridge. |
| 13:04:09.6 | `page.waitForTimeout(62000)` starts. |
| 13:04:19.3 | It fails after **9.7 s**, not 39 s; 39 s was the whole test. Error: `Target page, context or browser has been closed`. |
| +165 ms | `afterAll` finishes. `app.close()` returned at once. |
| 13:04:23 | The **same Electron app** sends a full heartbeat and **syncs the billed sale** (POST 201). `afterAll` had just re-enabled the network. |
| 13:07:41–13:08:03 | The app's **renderer** is still polling: notifications, express-expiry alert, check-in, day-close prompt. |
| +300 s | `Worker teardown timeout of 300000ms exceeded`. |

**Conclusion.**
- The window, the renderer and the main process were all alive. The main process still had its heartbeat interval, so its
  `before-quit` had never run.
- What closed was Playwright's DevTools (CDP) connection to the browser process.
- Probing Playwright 1.65.1 with a minimal Electron app separates the possible causes:
  - a destroyed window reports exactly this message;
  - a renderer crash reports "Page crashed" instead;
  - a CDP disconnect marks the context closed, which produces this message for every page.
- Once the context is closed, `ElectronApplication.close()` is a no-op (its quit handler never runs). Playwright's own worker
  cleanup then waits for a process exit that nobody requested. That is the 300 s hang.

### 2.2 Candidates checked

- **Clock-shift seam.** Ruled out. The `Date.now` override runs only in O11, after O10. It is process-local and ends with the
  process.
- **App relaunch while the page handle is in use.** Ruled out. The relaunch happens in O3. `launch()` reassigns `page`, and O10
  used that page successfully: bridge IPC is accepted only from the main window's `webContents`. The old app's close waits for
  its process to exit.
- **Window teardown racing the sync loop.** Not the trigger.
  - The window was never torn down: the renderer kept polling.
  - `stop()` on `before-quit` clears both intervals before closing SQLite.
  - A heartbeat still in flight afterwards fails into the logged `.catch`.
  - Probed: an unhandled rejection or uncaught exception in Electron 45's main process does not block quit.
  - Probed: an in-flight `net.request` does not delay exit (the process exits in under 1 s).
- **SQLite handle left open.** Not the trigger. The database is closed in `stop()` on every quit path, including SIGTERM (probed:
  SIGTERM runs `before-quit`, then `will-quit`, then `quit`, exit 0). The spec's own read-only handle in O4 is closed in `finally`.
- **Ruled out in Playwright itself:** `CRConnection._onMessage` is async, so a failing event handler cannot close the socket
  through the transport's "failed onmessage callback" path. The transport has no ping or idle timeout.
- **Load.** W18's run 1 took 14.6 min, against 6.2 min for its run 2, so the machine was heavily loaded. During this work the
  load average reached 140 on 8 cores, from other agents.

**Not reproduced.** What closed the DevTools socket while Electron kept running is **unconfirmed**. The desktop suite never
reproduced it: 10 complete runs, all 12/12, at load averages of about 4–25. Those are 3 exploratory runs, 2 runs of a first
final set that was interrupted externally (§3), and the 5 final runs. W18's failing run was at much higher load.

### 2.3 Fix (spec, at the teardown root)

The hang does not depend on why the connection dropped. The spec handed the app's exit to an API that cannot act once
Playwright believes the app is closed.

- **`closeApp()`** in `offline-billing.spec.ts`, used for the O3 restart and in `afterAll`:
  1. Start `ElectronApplication.close()` without awaiting it unbounded, because it never settles if the app does not quit.
  2. Wait up to 15 s for the **process** to exit.
  3. Otherwise log `[desktop-e2e] The app did not exit after quit; sending SIGTERM.` and send SIGTERM. Electron runs its
     normal quit path, so `before-quit` runs `stop()` and the encrypted database is closed.
  4. After a further 15 s, send SIGKILL and fail the hook loudly.
- Probed with an app that ignores its first quit request (the W18 condition): it exits cleanly via SIGTERM in 15 s with exit
  code 0, instead of hanging.
- `afterAll` now closes the app **before** re-enabling the network. A surviving app can no longer sync after the test.
- **Diagnostics.** If Playwright loses the window while the app process is still running (and the spec did not close it), the
  spec logs `[desktop-e2e] Playwright lost the window while the app process is running.` Running with `DEBUG=pw:browser` also
  records Playwright's `<ws disconnected> code=…` lines. Together these identify a recurrence immediately.
- **Ports.** The desktop stack ports were fixed at 4173 and 4410, the same ports as the web e2e stack, so the two suites could
  not run at the same time. `E2E_DESKTOP_PORT_BASE` now moves the whole desktop stack to base…base+4: web gate, preview,
  backend gate, backend and control. The defaults are unchanged. This is done through:
  - `e2e-desktop/ports.ts`;
  - `e2e-desktop/vite.preview.config.ts`, which merges into `vite.config.ts` and overrides only the preview proxy target.

  `vite.config.ts` itself is not edited.

**Also observed (not a failure).** At the O3 restart, the first app took 10 s and 16 s to exit after its window closed in 2 of
the 3 exploratory runs. In every other run, including all 5 final runs, both closes took about 60–130 ms. Main-process JavaScript was idle during the
gap (`stop()` had run), and an in-flight request does not cause it (see the probes above). `closeApp()` tolerates this; a gap
over 15 s gets SIGTERM and still quits cleanly.

Commit: `f52deab7`.

## 3. Repeat-run results

All three sets ran on the final code: head `42926ef3` plus this report. Every service was private and on loopback.

| Set | Command | Result |
|---|---|---|
| Frontend vitest, all 7 browser gates, **10 in a row** | `ADMINISTRATION_… PRODUCT_FEEDBACK_BROWSER_TESTS=true npx vitest run` | **10/10 green.** Each run: 74/74 files, **409/409 tests**, 0 hook timeouts, about 33 s. Load average 5–23. |
| Desktop offline billing, 12 scenarios, **5 in a row** | `E2E_DESKTOP_PORT_BASE=4610 DEBUG=pw:browser E2E_MYSQL_URL=…/pos_rewrite_e2e_offline npx playwright test -c playwright.desktop.config.ts` | **5/5 green.** Each run: **12 passed**, about 6.1–6.2 min. No lost window, no SIGTERM fallback, the Electron process exited each time, and no stack process was left. Load average 3.5–6. |
| Backend vitest, every MySQL gate, **3 in a row** | W18's env (26 URLs, `ORDER_DETAIL_BROWSER_TEST=true`, `ORDER_SEARCH_SOURCE_ROOT` = a checkout containing `78d5b63`), `npx vitest run --no-file-parallelism --maxWorkers=1` | **3/3 green.** Each run: 220 files passed and 1 skipped; **1187 passed, 0 failed**, 17 skipped (`live-readonly`, gated on the production URL). 136–150 s. |

Also run:
- Each fixed file in isolation, 3/3 before and after.
- `npx tsc --noEmit -p .` and `npx eslint` on the changed files (frontend and backend).
- `prettier --check` on the changed files.

**Interruption, recorded for completeness.** At 15:22:08 UTC, something outside my commands sent a clean shutdown to my
MySQL (port 33921) and killed my background loop shells at the same moment. At that point the first final desktop set was 2/2
green and the first backend set was 2/2 green. I stopped the orphaned runs, dropped the leftover schemas and restarted MySQL.
Both sets were then rerun from the start: they are the desktop and backend rows above.

**Frontend runs before the fixes, for contrast.** Two early loops ran before the authenticator fix, at load average
60–140. They completed 8 runs, and I stopped both:
- 2 runs failed in the authenticator test with the strict-mode status violation (§1b);
- 6 runs had `afterAll` hook timeouts (§4), each time with all 409 tests passing.

At load average 5–23 the hook timeouts did not occur in any of the 10 final runs.

**Scope note.** The desktop runs served the renderer built after the `PrivateImages` fix. The later one-line `mfa.tsx` change is
not in that bundle. It is unrelated to the offline-billing scenarios, and the frontend vitest runs cover it.

## 4. Found outside my ownership (described, not edited)

1. **`afterAll` hook timeouts in browser test files under extreme load.**
   - In 6 of the 8 early full frontend runs, at load average 60–140, every one of the 409 tests passed, yet between 2 and 7
     browser test files failed, each only in `afterAll`: `browser.close(); server.close()` hit vitest's 10 s default hook timeout.
   - Affected files: `history.browser`, `workflows`, `customer-otp/otp.browser`, `order-copy/browser`,
     `order-payments.browser`, `barcodes/browser`, `model-accounts/browser`, `product-feedback/browser`.
   - Measured: `browser.close()` takes 1.4–2.9 s at load average 90; `server.close()` takes 3–11 ms. With 7 vitest workers each
     closing its own Chromium at the same moment on a saturated host, 10 s is exceeded.
   - At load average 15–20 the same file closes in under 3 s. At load average 5–23, none of the 10 final full runs had a hook
     timeout.
   - This is an environment-load effect, not a logic race. The owners (W19 for `verify-project` runs, or the test owners) could
     cap browser-test concurrency (`--maxWorkers` or `poolOptions`) for verification runs. Raising `hookTimeout` would hide it.

## 5. Files changed

- `frontend/src/components/private-images.tsx`
- `frontend/tests/administration/workflows.test.ts`: the profile-image and authenticator tests only.
- `frontend/src/pages/administration/mfa.tsx`: one line, at the coordinator's request.
- `backend/tests/checkout/customer-mysql.integration.test.ts`: `beforeEach` clock alignment.
- `frontend/e2e-desktop/offline-billing.spec.ts`
- `frontend/e2e-desktop/ports.ts` (new)
- `frontend/e2e-desktop/vite.preview.config.ts` (new)
- `frontend/playwright.desktop.config.ts`

`backend/tools/e2e/offline-billing-stack.ts` was not changed: it already read every port from the environment.

No shared files, no schema, no backend source and no `verify-project` changes.
