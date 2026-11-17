# Windows and macOS desktop configuration

Package the desktop app for the actual approved HTTPS workspace origin. Set
`POS_DESKTOP_URL` in the build process before invoking `desktop:dist:mac` or
`desktop:dist:win`. The Electron `beforePack` hook validates that origin and
includes its nonsecret configuration inside the ASAR archive before signing.
Normal Finder/Start Menu/shortcut launches then use that configuration without
requiring an operating-system environment variable.

macOS build shell (replace the placeholder origin):

```sh
POS_DESKTOP_URL=https://pos.example.invalid npm run desktop:dist:mac
```

Windows PowerShell build shell:

```powershell
$env:POS_DESKTOP_URL = 'https://pos.example.invalid'
npm run desktop:dist:win
```

Keep credentials, access tokens, customer data and OAuth client secrets out of
this configuration. Backend authentication and browser-based SSO remain server
concerns. A missing or invalid workspace origin must not select a default public
site. Provision production signing/notarization separately and preserve the
existing ASAR integrity and renderer isolation settings.

The shared workspace owns offline receipt upload and reconciliation while the
operator is signed in, including after leaving Counter. It waits for current
store/counter data, retains per-receipt claims, and stops when identity or scope
changes. Already collected cash remains eligible for reconciliation after its
selling grant expires; new offline sales still require their valid grant.
Manager stock conflicts stay explicit review actions.

These deployment inputs accompany implementation work. No desktop build,
signing, device/printer action or acceptance test was run while authoring them;
final verification remains deferred until implementation is complete.
