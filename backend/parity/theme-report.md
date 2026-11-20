# TSS brand theme (branch `theme/tss-brand-tokens`)

User request (20 November 2026): apply the supplied theme tokens (fonts, primary and secondary colours) and the ghost logo,
using tokens and variables instead of hardcoded colours. This applies to all three clients through the shared renderer.

## What changed

### Tokens (`frontend/src/styles.css`, `:root`)
- **Brand palette, exactly as supplied:**
  - TSS Primary Red `#ED3833`, Deep Brand Red `#D40709`
  - Charade `#2C2D37`, Navy `#282D3F`, White, Athens Gray `#F8F8F9`
  - Teal `#148C8D`, Orange `#E76A52`, Purple `#894DB3`
  - Success `#1E9053` / `#4CAF50`, Error `#DD231D`, Warning `#FF6813`
  - Gold `#E7AE1A` / `#FFBE27`
- **Derived tokens:**
  - a cool grey scale on the Charade hue (`--gray-50`…`--gray-900`)
  - soft tints for status surfaces (`--red-soft`, `--success-soft`, `--gold-soft`, …)
  - darker inks for small text that meet AA contrast (`--red-ink` = Deep Brand Red, `--success-ink`, `--gold-ink`,
    `--error-ink`)
  - semantic aliases (`--ink`, `--muted`, `--line`, `--surface`, `--danger`, `--link`, `--focus`, `--overlay`)
- **Colour literals:** about 350 hardcoded colours in 29 stylesheets were mapped by hue, lightness and context onto
  these tokens:
  - error text goes to the red inks
  - links and selected tabs go to teal
  - "OK" statuses go to success
  - the old olive greys go to the cool greys
  - `rgb()` overlays and the named `white`/`black` were tokenised too

  The tokens these files used before but never defined (`--surface`, `--paper`, `--panel`, `--border`, `--accent`,
  `--success`, `--danger`, `--warning-soft`) are now defined.
- **Places CSS variables cannot reach:**
  - The dashboard SVG chart uses token styles; the series run red, teal, purple, gold.
  - The sandboxed guide iframe reads `--ink`/`--line` through `lib/theme.ts`, which passes through only hex values.
- **Colours that must stay literal**, because they are painted before CSS loads:
  - the Electron window background, `#f8f8f9` = `--athens-gray`
  - `theme-color` and the manifest, Navy and Athens Gray
- **Guard:** `frontend/tests/theme-tokens.test.ts`:
  - checks the brand values
  - finds no hex, `rgb()`/`hsl()`/etc. or named colour outside the `:root` block
  - finds every `var(--x)` defined

  A mutation check confirmed it fails on an injected `#abc` or `rgb(…)`.

### Fonts
- `frontend/src/fonts.css` and `src/assets/fonts/`, from @fontsource 5.3.0 under the SIL OFL 1.1 (`OFL.txt`).
- Only Latin and Latin Extended woff2 are bundled; Latin Extended carries ₹. There are 22 files, 472 KB in total.
- They are self-hosted, so they satisfy CSP `font-src 'self'` and work offline in the desktop app. They are also
  precached by the service worker.
- Roles:
  - Source Sans Pro 300/400/600/700 for body text, buttons and forms
  - Montserrat 400/500/600/700 for h1–h4 and the wordmark
  - Open Sans 400/600/700 for input, select, textarea and table values
- Not bundled: ExtraLight (200) and the italics, which the UI doesn't use, and the campaign display fonts (Gilroy,
  Roboto, Sen, Optima, Mulish, Big Shoulders, Phonk, SF Florencesans).

### Logo
- The supplied 152 px icon (`~/Downloads/152.png`) was traced into a vector. The method was marching squares, then
  RDP simplification, then clamped Catmull-Rom curves.
- Rendered at 152 px, it differs from the source by a mean of 0.57/255 per pixel; 1 pixel differs by more than 64.
- The tile colour is sampled from the icon: `--logo-red` `#ED2C31`.
- Where it is used:
  - sidebar brand and login header (`components/brand-mark.tsx`)
  - favicon and PWA icon (`public/icon.svg`)
  - desktop app icon, `build/icon.png` (1024 px, rounded tile like the previous icon). electron-builder derives the
    macOS `.icns` and the Windows `.ico`/NSIS icons from it.
- The sidebar is now Navy, with a red active indicator and the wordmark "THE SOULED STORE" in Montserrat.

## Verification
- Frontend:
  - `tsc` clean, ESLint clean, Prettier clean on the changed files
  - vitest 61 files passed / 15 skipped, 298 tests passed, including the new guard
  - `vite build` OK
- **Web (Chrome, 1440×900) and macOS Electron dev shell (2×):** 20 screens each on the real e2e stack, with an isolated
  loopback MySQL 8.4, seeded synthetic data only. They are in `theme-screens/web` and `theme-screens/macos`; the
  pre-theme screens are `w27-screens/*/after-*`.
- **Windows:** needs the `windows-latest` leg of `desktop-platforms.yml` on this branch, which runs the web and desktop
  suites and the packaged-app and NSIS smoke tests. The renderer is shared, and the only desktop change is the icon PNG
  and the window background colour.

## Notes for review
- The logo is a high-fidelity trace of a 152 px raster. If design has a master SVG, it can replace `ghostPath` and
  `public/icon.svg` directly.
- Teal `#148C8D` on white is about 4.1:1 contrast; brand teal is kept for links as supplied. `--red-ink` and
  `--success-ink` cover small error and success text.
