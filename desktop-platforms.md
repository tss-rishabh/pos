# Windows and macOS desktop distribution

Both operating systems are required. The supported packaging targets are Windows
x64 and macOS arm64/x64, using the shared React frontend and sandboxed Electron
shell. Web remains available from the same HTTPS origin. Linux packaging is an
optional existing target and does not satisfy either required desktop target.

On the target operating system, use Node 24, `npm ci` in both project folders,
then run these commands in `frontend/`:

| Target                      | Unpacked review build      | Installer/archive build    |
| --------------------------- | -------------------------- | -------------------------- |
| Windows x64                 | `npm run desktop:pack:win` | `npm run desktop:dist:win` |
| macOS Apple Silicon / Intel | `npm run desktop:pack:mac` | `npm run desktop:dist:mac` |

Windows uses a per-user NSIS installer. macOS produces DMG and ZIP artifacts for
each architecture. Artifact filenames include OS and architecture. NSIS preserves
application data during uninstall; users must explicitly erase local records
under the organization's retention process after pending financial work is
reconciled. Normal upgrades retain the Electron profile and IndexedDB ledger.

Configure the deployed HTTPS `POS_DESKTOP_URL`, exact `POS_SSO_ORIGINS`, optional
`POS_OAUTH_ORIGINS`, optional approved `POS_APP_LINK_ORIGINS`, the optional single
`POS_CUSTOMER_WEBSITE_ORIGIN`, and trusted media origins identically on both OSes. No shell
command, OS-specific file path, privileged renderer or mobile runtime is needed.
Receipt printing uses the operating system print dialog from an isolated
same-origin frame. Initial connection prepares the offline shell and bounded
offline cash authority; a first-ever launch without cached application data
cannot complete a sale.

The checked-in `desktop-platforms.yml` workflow runs frontend/unit, native
Electron and offline browser checks on Windows and macOS runners, then packages
unsigned review artifacts. It performs no release/upload to customers and uses
no signing secrets. The initial native run on both operating systems reached
the frontend tests and failed because two source-comparison tests required an
untracked sibling checkout. Their exact DataTables function extracts now ship
as a checksummed fixture; when the sibling exists its source bytes are also
verified. Full-project parity still requires the clean pinned source checkout.
The corrected native run passed both operating systems at commit
`88b7a4e24745a0fd272f429fabaa7e48a4b5a4ac`, including Electron/browser checks,
unsigned native packaging and packaged integrity/restart/offline smoke checks.
Run: https://github.com/thesouledstore-tss/pos/actions/runs/43983200922.
The source-bound job/step/artifact summary is in
`backend/evidence/desktop-native-ci.json`; subsequent source changes require
another native run. Initial failing run: https://github.com/thesouledstore-tss/pos/actions/runs/43980750466.

Packaged binaries disable running as Node, Node environment injection, Node
Inspector arguments and extra file-protocol privileges. They enable encrypted
cookies, embedded ASAR validation and loading only from ASAR, following the
[Electron fuse guide](https://www.electronjs.org/docs/latest/tutorial/fuses)
and [electron-builder integration](https://www.electron.build/docs/tutorials/adding-electron-fuses/).
These are packaging settings; development Electron remains usable for controlled
tests. REA verified the actual macOS arm64 artifact bytes in
`backend/evidence/desktop-fuses-rea-macos-arm64.json`; package hashes are in
`backend/evidence/desktop-package-macos-arm64.json`. This proves configured fuse states,
not complete runtime security or Windows behavior.

After packaging, run `node tools/verify-desktop-package.mjs` from `frontend/`
using Node 24. It reads each supported packaged artifact, checks its actual fuse
bytes against the policy, verifies the packaged entry and application identity,
and compares the macOS ASAR header with its embedded integrity metadata.
Platform/architecture reports are written under `backend/evidence/desktop-package-*.json`.
The native CI workflow runs this check before retaining its review artifacts.

Then run `node tools/smoke-desktop-package.mjs` on the package's native operating
system. It launches the packaged executable with an isolated temporary profile
and controlled development-only loopback page. It checks renderer Node isolation,
blocked external navigation/popups, local-state retention across a native restart,
and a service-worker response after the fixture server stops. It uses a temporary
Chromium CDP endpoint; packaged Node Inspector and RunAsNode fuses stay disabled.
The runner removes its own profile and processes and writes
`backend/evidence/desktop-runtime-*.json` only for successful checks and cleanup.
The macOS arm64 check has passed locally, and the Windows/macOS native CI run
above passed its packaged runtime steps. A synthetic page does not certify production TLS, authentication,
signed OS credential-store behavior, legal invoices or physical printers.
The macOS fixture uses Chromium's mock Keychain for its temporary unsigned
profile, matching Playwright's Electron test isolation. Production app settings
and fuse bytes stay unchanged; signed Keychain acceptance remains separate.

Cookie encryption is a one-way profile transition. Keep it enabled in later
releases and test upgrades with the signed applications and the actual OS
credential store. Cookie encryption does not itself encrypt IndexedDB records.
On macOS, final Keychain behavior requires the signed app. The local package
uses an ad-hoc signature after fuse changes and remains a review artifact.

Before release, retain native evidence for installation, upgrade/profile retention,
offline restart and receipt reprint, concurrent counters, reconnect/manager
conflicts, authentication/logout/SSO and permitted redirects, private downloads,
keyboard shortcuts, display scaling and the actual store receipt printers on
each OS/architecture. Validate Windows path/permission and macOS Gatekeeper
behavior with the signed installer. Windows code signing and Apple signing plus
notarization are release requirements; local unsigned packaging is development
evidence only. `desktop-windows-macos` remains pending in the production gate
until both targets have current reviewable evidence.

Use OS versions supported by the pinned Electron release. Electron-builder
supports separate Windows/macOS packaging and notes that macOS code signing
requires macOS: [platform build guidance](https://www.electron.build/v26/docs/features/multi-platform-build/),
[architecture guidance](https://www.electron.build/v26/docs/architecture/).
