# W24 report: Windows desktop app, complete with end-to-end proof on Windows

Branch `windows/desktop-complete`, from `593a53d4` (`main`). All runs used synthetic data on loopback
services only (MySQL 8.4 with an empty `sql_mode`, a private Redis-7-compatible server, the real
backend, the W17 API-v2 stand-in and fake adapters). Nothing connected to production. Logs and
artifacts are public; they contain no credentials, production URLs or personal data.

## 1. Result

**Green run on both legs:** <https://github.com/tss-rishabh/pos/actions/runs/44580343629>
(commit `442a5c13`, `workflow_dispatch` on `windows/desktop-complete`).

| Check | Windows (`windows-latest`, Server 2025, x64) | macOS (`macos-latest`, arm64) |
|---|---|---|
| Frontend unit tests (vitest) | 294 passed, 115 skipped (gated) | 294 passed, 115 skipped |
| Redis command compatibility (20 command families) | 20/20, Memurai 4.1.8 (Redis API 7.2.12) | 20/20, redis-server 8.10.3 |
| Electron shell specs (`e2e/electron.spec.ts`) | **2/2** | 2/2 |
| Desktop offline billing (`playwright.desktop.config.ts`, real Electron + real stack) | **12/12** (6.4 min), real DPAPI | 12/12 (6.2 min), mock keychain |
| Receipt print (Electron print pipeline) | printToPDF 200,044 B; **spooled to a real Windows print queue** (Microsoft Print to PDF driver), 156,649 B PDF | printToPDF 227,933 B |
| Web Playwright suite (`e2e/`, real stack, Chromium) | **39/39**, 0 flaky | 39/39, 0 flaky |
| Browser vitest files (sign-in, customer, order recovery, …) | 69/69 in 9 files | 69/69 |
| Scoped invoice browser checks | pass | pass |
| Order copy browser tests | 8/8 | 8/8 |
| Real-stack harness: order history / order search | 1/1, 1/1 | 1/1, 1/1 |
| Package | NSIS x64 installer (`--win nsis --x64`) | `--dir` (unsigned `.app`) |
| Packaged-app smoke (`tools/smoke-desktop-package.mjs`) | **pass**, incl. DPAPI-opened DB | pass, incl. real login Keychain on the runner |
| NSIS lifecycle (`tools/smoke-desktop-installer.mjs`) | **pass**: install → DPAPI DB → upgrade 0.1.0→0.1.1 → uninstall | n/a |

Windows job time: 19 min. Earlier runs on the branch, kept for the record:
- <https://github.com/tss-rishabh/pos/actions/runs/44575316681>: baseline at `593a53d4`, before any change.
  Both legs failed at the same stale step (§2, G16); nothing desktop-related ran on Windows.
- <https://github.com/tss-rishabh/pos/actions/runs/44577067867>: first run of the new leg. The Windows
  packaged smoke already passed with real DPAPI; it exposed G2 (app name / userData) and the MySQL wait
  (G18). macOS was green except one web test (G19).

Artifacts of the green run (14 days): `desktop-windows-latest` holds both installers, the
installer-lifecycle evidence `release/desktop-installer-windows-x64.json`, the Playwright HTML and JUnit
reports (`playwright-report/{electron-shell,desktop-offline,web}`, `junit-*.xml`; the desktop report
attaches `receipt-print-to-pdf.pdf` and `receipt-spooled-windows.pdf`), and
`backend/evidence/desktop-{package,runtime}-windows-x64.json` (generated on the runner, not committed).
`desktop-macos-latest` holds the same for macOS.

**Installer size:** `Souled POS-0.1.0-win-x64.exe` = 122,657,196 bytes (117.0 MiB), unsigned NSIS,
per-user, x64. Install takes about 13 s silently, upgrade about 10 s, uninstall about 3 s.

**Local macOS (arm64, this machine):** Electron shell specs 2/2 and the desktop suite 12/12 (6.1 min)
on a private MySQL 8.4 (port 33724, `sql_mode=''`) and private redis-server, run twice: once on the first tooling commit and once on the final code (2/2 and 12/12 both times, receipt printToPDF 2 pages). The packaged smoke was not run locally on purpose: without the mock keychain (now refused by packaged builds) it would write into this machine's login Keychain; the macOS CI leg ran it against the runner's Keychain instead.

## 2. Gap list (each fixed, verified, or reported)

| # | Gap | Status |
|---|---|---|
| G1 | **NSIS installer never built or run.** | Fixed/verified. CI builds the NSIS x64 installer and the next-version installer, then runs silent install, launch, single instance, switch refusal, DPAPI DB open, silent upgrade over the installed version, silent uninstall (§3). |
| G2 | **The packaged app was named `@pos/frontend`.** `package.json` had `productName` only under `build`, so Electron named the app after `name`. On Windows the installed app therefore kept its profile (offline DB, wrapped key) outside `%APPDATA%\Souled POS`, which the NSIS installer's app-data handling and W17's documentation ("Souled POS Safe Storage") assume. The macOS leg uses the same `package.json`, so its app name now comes from the same field. Found by the installer smoke (`DEFAULT_PROFILE_NOT_USED`). | Fixed: top-level `"productName": "Souled POS"` in `frontend/package.json`. The installed app now uses `%APPDATA%\Souled POS`. No release was ever shipped, so there is no profile to migrate. |
| G3 | No application icon (W17). | Fixed: `frontend/build/icon.png` (1024², rendered from `public/icon.svg`), `directories.buildResources` and `icon` in the build config. electron-builder generates the `.ico` (exe, installer, taskbar, shortcuts) and `.icns`; the "default Electron icon is used" warning is gone on both legs. |
| G4 | SQLCipher (`better-sqlite3-multiple-ciphers` 13.0.3) on win32-x64. | Verified. It is an N-API prebuild (`prebuilds/win32-x64.node`): it loads in Node 24 (spec O4, smokes) and in Electron 45 (dev e2e), and in the packaged/installed app from `resources\offline-sqlite` outside the ASAR (bridge reports `available: true`). `npmRebuild: false` stays correct. |
| G5 | `safeStorage` with real DPAPI (no mock keystore on Windows). | Verified (§4). The desktop specs now pass `--use-mock-keychain` only on macOS. |
| G6 | Single-instance lock. | Verified on the packaged and the installed app: a second launch on the same profile exits with code 0 and opens no window; the first keeps running. |
| G7 | Debugging and mock-keychain switches in packaged builds (W17 fix). | Verified on Windows: the packaged app exits 1 for `--remote-debugging-port`, `--remote-debugging-pipe` and `--use-mock-keychain` and writes nothing into the profile; the installed app the same for the first and last. |
| G8 | **The packaged smoke could no longer run anywhere.** It drove the packaged app over CDP (`--remote-debugging-port`, plus `--use-mock-keychain` on macOS), which W17's hardening makes the app refuse; it had never run in CI. | Fixed: rewritten without CDP (§3). |
| G9 | Paths: userData location, spaces, non-ASCII, long paths. | Verified: install dir `%LOCALAPPDATA%\Programs\Souled POS` and userData `%APPDATA%\Souled POS` (both with a space); the packaged smoke uses a temp profile named `pos packaged runtime ü-…` (space and non-ASCII) for SQLCipher, DPAPI and the service worker. Long paths (>260) were not exercised: every app path is short and fixed, and the only user-influenced path (`POS_DESKTOP_PROFILE_DIR`) is development-only. |
| G10 | Printing. | Verified (§5). The app has no silent-print setting: the cashier's button calls `window.print()` (OS dialog). Bug reported, not fixed (outside ownership): the offline receipt prints as **2 identical pages** on both OSes (§5). |
| G11 | Keyboard shortcuts (Ctrl vs Cmd). | No change needed. Cashier shortcuts are single unmodified letters and are ignored when Ctrl, Meta or Alt is held (`src/pages/cashier-shortcuts/shortcuts.ts`), so they behave the same on both OSes; `e2e/checkout/cashier-shortcuts.spec.ts` passes on Windows Chromium. Electron's default menu uses `CmdOrCtrl` accelerators (Ctrl+R, Ctrl+W, …). |
| G12 | Window and menu behaviour. | Reported, unchanged (parity). Windows shows Electron's default menu bar inside the window (File/Edit/View/Window/Help); macOS shows the same default menu in the system bar. Help › "Learn More" etc. open electronjs.org in the browser and View › "Toggle Developer Tools" is a no-op in packaged builds (`devTools` is off unless `NODE_ENV=development`). Hiding or trimming the menu would be a new product decision, so it is listed under §8. Window title, minimum size and `AppUserModelId` (`com.thesouledstore.pos`, taskbar grouping) were already set. |
| G13 | Offline detection on Windows. | Verified for the app's own reachability probe: the 12 scenarios cut the network with the stack's TCP gates, and the device switches to offline billing, restarts offline from the service worker, and auto-syncs on reconnect. Not exercised: `net.isOnline()` flipping because a Windows network adapter was disabled (would cut the runner off). |
| G14 | Auto-start and auto-update. | Not present in the app, so nothing was added. electron-builder writes `latest.yml` and a blockmap next to the installer by default; no updater code consumes them. |
| G15 | CSP and sandbox flags in the packaged build. | Verified: sandbox, context isolation, no Node integration (shell spec on Windows), renderer has no `require`/`process` and external navigation/popups are blocked (packaged smoke), fuses match policy, and the **Windows ASAR integrity resource** is now checked statically (`INTEGRITY/ELECTRONASAR` in `Souled POS.exe` equals the ASAR header hash; previously "not covered" on Windows). CSP is set by the web server (nginx), not by Electron; unchanged. |
| G16 | **CI referenced deleted scripts.** `tests/order-history/browser-check.mjs` and `tests/order-search/browser-check.mjs` were removed in `cf4ab60d`; both legs failed there (baseline run). | Fixed: the steps run the real-stack harnesses (`tests/harness/playwright.config.ts order-history/` and `order-search/`), as `verify-project` does. |
| G17 | Line endings. GitHub's Windows runners check out with `core.autocrlf=true`. | Fixed: `.gitattributes` (`* text=auto eol=lf`, binaries marked, one vendored CRLF licence file kept as-is), so hashes, fixtures and the desktop tooling see the same bytes on every OS. Desktop tooling uses `path.join` throughout; the CI shell steps on Windows are PowerShell. |
| G18 | Windows MySQL and Redis for the e2e stack. | Fixed. MySQL 8.4.6 from the official no-install zip (cached), `my.ini` with `sql-mode=""`, `bind-address=127.0.0.1`, `mysqlx=OFF`. `mysqladmin ping` never connected on the runner although mysqld was ready; `backend/tools/e2e/wait-mysql.ts` waits with mysql2 (the stack's own client) and asserts the empty `sql_mode` and the loopback bind. Redis: Memurai Developer via Chocolatey (the shared 6379 service is stopped); `E2E_REDIS_SERVER` lets `tests/helpers/private-redis.ts` start private loopback Memurai instances with the same flags as redis-server. `backend/tools/e2e/redis-compat.ts` proves SET NX EX/XX PX, PTTL/EXPIRE/TTL, EVAL/EVALSHA (Lua), LMOVE, BLMOVE (incl. timeout), LPUSH/LRANGE/LREM, ZADD/ZRANGEBYSCORE/ZREM, SCAN, EXISTS/MGET, TIME, MULTI/EXEC, PUBLISH/SUBSCRIBE and DEL/UNLINK. Old Windows Redis 3.x/5.x ports were not used (no BLMOVE). |
| G19 | Web suite flake (`e2e/checkout/order-link.spec.ts`, aborted `POST …/orders/searches` during a store transition) on macOS in run 44577067867; it passed in the baseline and the green run. | Reported (web owner). The web suite step now has `--retries=1`; a retried pass is listed as "flaky" in the output and JUnit. The green run had 0 flaky on both legs. |

## 3. How the packaged and installed apps are tested without CDP

`frontend/tools/desktop-native-fixture.mjs` serves a synthetic workspace page on 127.0.0.1 (development-only
loopback origin, `NODE_ENV=development` + `POS_DESKTOP_URL`, the existing explicit provisioning path).
The page's own script reports to a separate loopback report server: `typeof require/process`, the
offline billing bridge, a localStorage canary, service-worker control, `offline:status` from the real
bridge, and whether `window.open`/`location.assign` to an "escape" server were blocked (the escape server
must receive 0 requests). Apps are quit like a user closing the window (`taskkill` without `/F` on Windows,
SIGTERM elsewhere), so `before-quit` closes the encrypted DB; a forced kill fails the smoke.

`tools/smoke-desktop-package.mjs` (both OSes, `release/win-unpacked` or `release/mac-arm64`):
static verification (fuses, ASAR, integrity metadata, entry hash) → refused switches → launch 1
(isolation, worker, `available: true`, navigation blocked) → second instance exits → restart (canary
retained) → origin closed, launch 3 loads from the service worker only → DB inspection (§4).

`tools/smoke-desktop-installer.mjs` (Windows): see the evidence JSON in the artifact; the green run
recorded:

```json
{"install":{"version":"0.1.0","installLocation":"%LOCALAPPDATA%\\Programs\\Souled POS"},
 "refusedSwitches":["--remote-debugging-port","--use-mock-keychain"],
 "singleInstance":{"secondInstanceExitCode":0},
 "dpapi":{"localStateKeyProtection":"DPAPI (CurrentUser)","wrappedKeyPrefix":"v10","wrappedKeyBytes":95,
          "plaintextHeader":false,"opensWithoutKey":false,"opensWithWrongKey":false,
          "opensWithDpapiReleasedKey":true,"tables":13},
 "upgrade":{"from":"0.1.0","to":"0.1.1","retained":["local-storage","offline-database","device-key","device-id"]},
 "uninstall":{"programFilesRemoved":true,"uninstallEntryRemoved":true,"startMenuShortcutRemoved":true,
              "profileRetained":["offline-billing.db","offline-billing.key","Local State"],
              "retainedDatabaseOpensWithDpapi":true}}
```

Install also checks the exe, the uninstaller, `resources\offline-sqlite\prebuilds\win32-x64.node`, the
Start-menu shortcut and exactly one HKCU uninstall entry whose `DisplayVersion` matches the packaged
version; upgrade checks the entry was replaced, not duplicated. The upgrade installer is the same source
built with `-c.extraMetadata.version=<patch+1>`.

## 4. What was verified with real DPAPI

On the Windows runner's own user, with no mock:
1. Electron `safeStorage` (async API) is available; the offline key is generated and wrapped, the
   encrypted DB is created and opened, and `offline:status` reports `available: true`: in the dev
   e2e (12 scenarios), in the unpacked package, and in the installed app with its real
   `%APPDATA%\Souled POS` profile.
2. From outside the app, the smokes reproduce the unwrap with nothing but the OS: Chromium's
   `Local State` → `os_crypt.encrypted_key` is `"DPAPI"` + a CryptProtectData blob; Windows
   `ProtectedData.Unprotect(CurrentUser)` (PowerShell) releases the 32-byte AES key; the key file is
   `v10` + 12-byte nonce + AES-256-GCM ciphertext + tag, which decrypts to the 64-hex DB key. The key
   is never printed.
3. With that key the DB opens with SQLCipher (`cipher=sqlcipher`, `legacy=4`) and shows the 13 offline
   tables and the device id. Without a key, and with a wrong key, it fails ("file is not a database");
   the file header is not `SQLite format 3`, and the key file is not the raw hex key (spec O4 and both
   smokes).
4. The same key and device id survive a silent upgrade, and the profile (DB, key file, `Local State`)
   survives uninstall and still opens with DPAPI.

Not verified: another Windows user (or another machine) failing to unwrap. That is DPAPI's documented
CurrentUser scope; it would need a second account on the runner. `offline-billing.key` is written with
mode 0600, which Windows ignores; the protection is DPAPI plus the per-user ACL on `%APPDATA%`.

## 5. Printing results

- The app prints with `window.print()` (offline receipt) and `iframe.contentWindow.print()` (invoice,
  shipping label, offline worksheet). Both open the OS print dialog in Electron; there is no
  `silent` or `deviceName` setting anywhere in the app, so nothing Windows-specific to configure.
- New check in scenario O2 (`printReceipt()` in `offline-billing.spec.ts`), with the provisional
  receipt dialog open:
  - every OS: `webContents.printToPDF` through the receipt's `@media print` stylesheet → a valid PDF
    (Windows 200,044 B, macOS 227,933 B), attached to the report;
  - Windows: CI adds a print queue "POS Receipt to PDF" on the real spooler with the built-in
    **Microsoft Print To PDF** driver and a file port; the test checks both queues are listed by
    `getPrintersAsync()`, prints the receipt with `webContents.print({ silent: true, deviceName })`,
    and checks the spooled file is a PDF (156,649 B, attached). This is the same Chromium/Windows print
    path as the cashier's dialog print, without the dialog.
- **Bug (reported, outside ownership: `frontend/src/pages/offline-billing/styles.css`): the receipt
  prints twice.** Both PDFs (printToPDF on both OSes and the Windows-spooled file) have **2 pages, each
  a complete copy of the receipt** (checked by extracting each page's text and rendering both pages of
  the run-44580343629 attachments). Cause: `@media print` hides the page with `visibility: hidden`,
  which keeps the hidden offline-billing page's height (2 pages), and the receipt sits in the modal's
  fixed-position layer, which Chromium repeats on every printed page. A cashier pressing "Print
  receipt" gets a duplicate receipt (and on a thermal printer, double the paper). Suggested fix for
  the owner: in `@media print`, `display: none` everything that does not contain the receipt (or
  print from a print-only root) and make the receipt `position: static`, then tighten the spec to
  expect exactly 1 page (`printReceipt()` already counts pages).
- Not covered: physical receipt printers and their drivers, paper sizes, and the dialog flow itself.

## 6. Signing prerequisites (not done: unsigned review build only)

Nothing secret is committed; `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps CI unsigned.

- **Certificate.** An Authenticode code-signing certificate for the publisher:
  - **EV** (or Microsoft **Azure Artifact/Trusted Signing**, which electron-builder 26 supports through
    `win.azureSignOptions`) gives immediate SmartScreen reputation.
  - **OV** works, but SmartScreen shows "Windows protected your PC" until the certificate/file builds
    reputation from installs. Since 2023 OV and EV private keys must live on a hardware token or a
    cloud HSM, so a plain `.pfx` in a CI secret is generally no longer obtainable from public CAs.
- **electron-builder inputs.**
  - `.pfx`-style: `WIN_CSC_LINK` (or `CSC_LINK`; base64 or https URL of the `.pfx`) and
    `WIN_CSC_KEY_PASSWORD` (or `CSC_KEY_PASSWORD`) as GitHub **environment** secrets on a protected
    environment; remove `CSC_IDENTITY_AUTO_DISCOVERY=false` for the release job.
  - Token/HSM: a `win.signtoolOptions.sign` hook (or `azureSignOptions` with `endpoint`,
    `certificateProfileName`, `codeSigningAccountName` and the `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET`
    environment variables).
  - `win.signtoolOptions.publisherName` must equal the certificate subject CN.
- **Timestamp.** RFC 3161, SHA-256: `win.signtoolOptions.rfc3161TimeStampServer`
  (e.g. `http://timestamp.digicert.com` or the CA's own), so signatures stay valid after the
  certificate expires.
- **What gets signed.** electron-builder signs `Souled POS.exe`, the NSIS installer and the
  uninstaller. Also sign `resources\offline-sqlite\prebuilds\win32-x64.node` (add it via
  `win.signExts: [".node"]`) so Smart App Control/WDAC policies that require signed DLLs accept it.
- **Order with integrity.** Signing changes the PE file but not `app.asar`; the `INTEGRITY/ELECTRONASAR`
  resource is written before signing, so the static verifier still applies. Re-run
  `tools/smoke-desktop-package.mjs` and `tools/smoke-desktop-installer.mjs` on the signed build, and
  check `Get-AuthenticodeSignature` = `Valid` on the exe, installer and uninstaller.
- **DPAPI continuity.** DPAPI is per Windows user, not per signature, so re-signing or changing the
  certificate does not lock out the offline key (unlike the macOS Keychain, W17 §4). Changing `appId` or
  `productName` would move `%APPDATA%\Souled POS` and orphan the device DB; keep both stable.

## 7. Files changed

- `.github/workflows/desktop-platforms.yml`: Windows MySQL 8.4 + Memurai + print queue, Redis
  compatibility, Electron shell specs, desktop suite, web suite, harness steps (G16), NSIS build, next-
  version build, installer smoke, per-OS artifacts, Playwright HTML/JUnit reports, `!cancelled()` so
  every step reports, 120 min timeout.
- `.gitattributes` (new, repository-wide: shared-file edit).
- `frontend/package.json`: top-level `productName`; `directories.buildResources`, `icon`.
- `frontend/build/icon.png` (new).
- `frontend/tools/desktop-native-fixture.mjs` (new), `smoke-desktop-installer.mjs` (new),
  `smoke-desktop-package.mjs` (rewritten), `verify-desktop-package.mjs` (Windows integrity resource).
- `frontend/e2e-desktop/offline-billing.spec.ts`: macOS-only mock keychain, receipt printing.
- `frontend/e2e/electron.spec.ts`: macOS-only mock keychain (it never touched DPAPI semantics on
  Windows; on macOS it stops the shell specs writing into a developer's login keychain).
- `backend/tests/helpers/private-redis.ts`: `E2E_REDIS_SERVER` override (outside the desktop folders;
  default unchanged).
- `backend/tools/e2e/redis-compat.ts`, `backend/tools/e2e/wait-mysql.ts` (new).

`frontend/electron/**` needed no code change: every Windows behaviour it owns (DPAPI, single instance,
switch refusal, `AppUserModelId`, sandbox, navigation policy, offline billing start-up) passed on Windows
as written. No backend source, schema, `backend/evidence/**` or security-decisions file was changed.

## 8. Left over

1. **The offline receipt prints twice** (2 identical pages, §5): frontend offline-billing owner.
2. **Packaged builds still honour `NODE_ENV=development` + `POS_DESKTOP_URL`/`POS_DESKTOP_PROFILE_DIR`**
   (W17 §6 leftover): a loopback http origin and a profile override. The native smokes rely on it.
   Refusing it in packaged builds would need a different smoke seam (for example a test-only build
   flavour); NEEDS DECISION.
3. **Default menu** on Windows (G12): keep Electron's default, hide it (`autoHideMenuBar`) or replace
   it with a minimal menu; NEEDS USER DECISION (kiosk-style counters may prefer no menu).
4. Signing (§6) needs the user's certificate; SmartScreen will warn on the unsigned review installer.
5. Not run on hosted runners: Windows on ARM64 (no `windows-11-arm` leg; the `win32-arm64` prebuild
   exists), a second Windows user for DPAPI isolation, physical printers, long paths, and adapter-level
   offline (`net.isOnline`) changes.
6. Memurai Developer is free for development/testing only and stops after 10 days of uptime; fine for
   CI. Production stores keep using the backend's Redis; the desktop app never talks to Redis.
7. GitHub warns that `actions/cache` and `actions/upload-artifact` v4 run on deprecated Node 20; bump
   the pinned SHAs to their Node 24 releases when convenient.
