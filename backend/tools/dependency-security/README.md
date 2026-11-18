# Picomatch development-toolchain mitigation

Status: **selected local mitigation**. Both project manifests and lockfiles
resolve the reviewed, integrity-pinned archive through a development-only
`picomatch` dependency and npm `$picomatch` override. The upstream version remains
4.0.7; this does not claim an officially fixed release or an audit-zero result.
No original/shared installed dependency, live service or production deployment
was modified. Isolated installs verify the selected parser bytes.

## Installed exposure and upstream state

Both current lockfiles deduplicate the local `picomatch@4.0.7` archive with
`dev: true`. Its archive SHA-256 is
`33cac3937347df24b2c9e03fc163fe62357829b4a5ca1675807c0d7af499184f`;
its selected parser SHA-256 is
`a9cd16504c08652f1beae523a517b210edacefc79c49ec24275df29a84d37ab5`.
Backend: Vitest 5.1.0 → picomatch, Vite 8.3.8 → picomatch, and tinyglobby
0.2.17 → picomatch/fdir 6.5.0 → picomatch. Frontend has the same graph, with
Vite also a direct development dependency. No micromatch package is installed.
The complete `npm explain` graph also includes TypeScript ESLint 8.72.2 →
`@typescript-eslint/typescript-estree` → tinyglobby in both projects, and
frontend electron-builder 26.18.0 → app-builder-lib → @electron/rebuild 4.2.1 →
node-gyp 12.4.0 → tinyglobby (also through dmg-builder). Frontend
`@vitejs/plugin-react` and Vitest's `@vitest/mocker` add peer paths to Vite.
These are all development-rooted paths. `inventory.mjs` records every path and
each direct picomatch consumer in `exposure.json`.
The prior baseline audit found zero production findings with `--omit=dev`; its
full backend/frontend counts propagated the advisory through this graph. The
current local mitigation retains the original package version and advisory
visibility; it must be reviewed together with the installed-file integrity proof.

Observed installed call paths:

| Consumer                                                        | Actual input and options                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Vitest `dist/chunks/index.Di8au7q4.js:6680`                     | Repository test include/exclude patterns, `{dot:true}`                                         |
| Vitest `dist/chunks/cli-api.COfZo8lK.js:7014`                   | Coverage include/exclude and force-rerun globs                                                 |
| tinyglobby `dist/index.mjs:22`                                  | Per-segment matchers compiled from its caller's glob                                           |
| fdir `dist/index.mjs:443`                                       | Optional picomatch-backed file discovery                                                       |
| Vite `dist/node/chunks/node.js:1934`                            | Plugin/include/exclude filters, `{dot:true}`                                                   |
| Vite `dist/node/chunks/node.js:27724`                           | `import.meta.glob` filters already set `noextglob:true`                                        |
| Vite `dist/node/chunks/node.js:37870`                           | Configured development-server filesystem deny patterns                                         |
| TypeScript ESTree `dist/parseSettings/resolveProjectList.js:63` | Configured `parserOptions.project` globs when project discovery is selected                    |
| node-gyp `lib/build.js:87`                                      | Fixed Windows build discovery `build/*.sln` / `build/*.mk` during native dependency rebuilding |

These are development/build/test paths, not an application HTTP glob API.
Current checked configuration glob sources are identical under the selected mitigation.
This reachability evidence does not make the vulnerable package safe for an
arbitrary plugin or caller supplying new patterns.

`npm ls picomatch --omit=dev --all --json` has no matching package in either
project. AST inspection found no runtime import/require of picomatch, its
glob consumers or development roots in backend/src, frontend/src or
frontend/electron, and no `import.meta.glob` call there. The existing frontend
dist snapshot contained 57 JavaScript files with no picomatch parser/option
markers. The desktop packaging allowlist includes dist/electron/package.json
and explicitly excludes `node_modules/**/*`. Together these establish no
observed shipped-runtime reachability. The marker scan is labeled
nonexhaustive, is not a substitute for the bundler's module graph, and does not
certify an independently unpacked final Electron artifact.

The configured frontend dev and preview commands bind to `127.0.0.1`.
Development-server URLs and discovered filenames are matcher **subjects**;
current filesystem deny/include patterns come from configuration, not a
public pattern parameter. No application request endpoint supplies patterns
to these packages in the inspected source. However, the desktop CI workflow
is triggered on pull requests and executes checked-out config/tests/builds.
An unreviewed or malicious repository change can supply new config/plugin
patterns to that CI/development execution. Developer CLI/config input can do
the same. Thus development/CI execution remains a real reachable surface;
current fixed-pattern coverage and loopback binding do not close the advisory.

The [reviewed advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
still lists versions through 4.0.7 and no patched release (checked November 18,
2026). [PR194](https://github.com/micromatch/picomatch/pull/194) explicitly leaves
`+(*a)` unresolved. [PR254](https://github.com/micromatch/picomatch/pull/254) is
an unmerged linearization proposal. Its immutable commit is
`c63a5bf4e61dbdb81bc41e97dc2616c30acce337`; the reviewed parser Git blob is
`379ea41bae6ca13a855d4687b6d50e28dc79faff`.

`review-upstream254.mjs` verifies that blob before executing it. It proves a
separator counterexample: `+([a/]*)` matches `a/a` on published 4.0.7 but not on
PR254. The proposal also leaves `+(*a|*b)` beyond the isolated deadline. It is
not adopted unchanged.

## Candidate behavior and provenance

The candidate changes **only `lib/parse.js`**. All other eight package files,
including its MIT license, retain their published hashes. The original nine
files were independently compared with the registry tarball after verifying
its full SHA-512 npm integrity (`upstream-files.json`). `prepare.mjs` refuses
any mismatch before packaging. `manifest.json` records each original/candidate
SHA-256, source patch hash and packaged archive hash. `candidate.patch` is the
complete human-readable delta; `LICENSE.picomatch` retains attribution.

For a single branch consisting of literal text, question wildcards and exactly
one default segment star, the outer repeat is redundant. The parser preserves
the original parsed body and turns `+(...)` into one occurrence, `*(...)` into
an optional occurrence. Separators/escapes/brackets, Bash stars, extra stars,
nested or regular-expression constructs are not admitted by that argument.
The existing safe character-class rewrites are retained. Prefix-free literal
alternatives retain their original regex. Other unqualified repeated forms
use the parser's existing literal fallback, including when a caller sets
`maxExtglobRecursion:false`.

That fallback is an intentional compatibility restriction. It does **not**
preserve arbitrary repeated-extglob semantics. Qualified single-star matching
has differential coverage, while its inner capture distribution can differ
from the old last-repeat capture. Current owned build/test patterns keep
byte-identical regex sources, including under `capture:true`. Raw regex mode
and unrelated regex/glob complexity are outside this bounded candidate's
security claim; it is not a general untrusted-regex sandbox.

The archive's package identity remains **picomatch 4.0.7**. No version increase,
alias or advisory ignore is used to make a scanner green. An advisory scanner
can still report the original package version after this local mitigation.
Official patched-release status remains unresolved and must stay visible.

## Historical candidate checks

All potentially slow regexes execute in separate 128-MB Node children, with
SIGKILL deadlines and no inherited credential/config environment. No
application data, network service, provider or database is used.

- Eight published-version cases exceeded a 1.5-second child deadline:
  `+(*)`, `+(*a)`, `*(*)`, `*(*a)`, `+(*)a`, `+(*a|*b)`, `+(ab|abab)` and
  `+(*a*a)`. Candidate cases with 10,000-character inputs completed within the
  same bound (about 6–7 ms inside the child on this host).
- 127 collected repository config/tool-default patterns × 5,675 tracked or
  generated fixture paths × six option sets: **4,324,350 equal match results**
  and **762 byte-identical owned regex sources**.
- **9,750** short-input comparisons for the qualified linearizations had no
  boolean differences. Unsupported-form tests assert the actual regex source
  is literalized, rather than relying on picomatch's equal-input shortcut.
- An isolated public-package installation verified the real npm
  `$picomatch` override, one deduplicated candidate copy, tinyglobby 0.2.17 and
  fdir 6.5.0. Its actual filesystem glob discovered exactly three fixture tests
  and excluded `.git`/`node_modules`. The temporary package/cache was removed.
- Local host: Node 22.23.2 on macOS. These are focused candidate checks, not
  Windows/Linux acceptance, a full Vite/Vitest project run, or a new audit-zero
  claim.

## Selected integration and focused Node 24 checks

The selected archive is mirrored into each project's `tools/dependency-security`
directory so both Docker build contexts remain independent. Each Docker stage
verifies the archive and exact lockfile resolution **before** npm reification,
then verifies every installed package file before compiling. Runtime `--omit=dev`
reification verifies that the matcher is absent. Both project lifecycle hooks for dev, build, test, lint and typecheck perform
the installed check too; existing preview, watch and e2e commands are covered. Desktop CI checks both archives before install,
then checks installed hashes and mirrored bytes before any Vite/Vitest execution;
its existing Windows/macOS workflow remains intact. A separate three-minute
workflow step executes the guard tests and offline pattern/hostile-input review.
Regex children have 128-MB memory and hard deadlines with a credential-free
PATH/TZ-only environment; the review performs no network requests.

`verify.mjs` uses only Node built-ins. It checks the archive SHA-256, lockfile
SHA-512 integrity, selected override, single deduplicated development copy and
all nine installed file hashes. It inventories nested package directories and
rejects unexpected copies or package symlinks that could bypass that inventory.
`sync-mirrors.mjs` separately checks the four repository mirror files; Docker's
self-contained verifier never requires the sibling project. `--write` explicitly
copies the canonical backend bytes after an intentional artifact regeneration.

Focused checks executed with exact Node **24.22.3** in an isolated worktree and
private npm cache, with lifecycle scripts disabled during initial installs:

- Actual backend and frontend `npm ci --ignore-scripts` select one reviewed copy;
  installed hashes, package identity and archive integrity pass in both projects.
- Eight guard tests cover genuine selection, missing/tampered archive, stale
  parser, symlink substitution, registry/integrity substitution, nested lock and
  unrecorded installed copies, production exclusion, mirror identity and lifecycle-hook prerequisites.
- Actual backend and frontend builds and Vitest file discovery pass. Separate
  Linux/arm64 Docker build contexts pass too, including final backend runtime
  reification with its `--omit=dev` integrity check and the final frontend build.
  No application, database or provider is started by these build checks.
- Actual `npm ci --omit=dev --ignore-scripts` reification in separate copies
  passes for both projects; no picomatch package is installed there.
- Current 127 owned patterns × 5,891 paths × six option sets produce
  **4,488,942 equal matches** and **762 identical regex sources**. All **9,750**
  qualified short-input comparisons pass. Eight baseline hostile patterns exceed
  their isolated deadline; all selected-mitigation cases complete within it.

These checks qualify the deliberate restriction for this owned toolchain; they
do not promise arbitrary repeated-extglob/capture semantics. Complete latest-head
project/platform validation and final shipped artifact/security acceptance remain
separate. The upstream advisory is not ignored, removed or relabeled as patched.

Run from the repository root with Node 24. The default differential review
reconstructs the exact original parser offline by reversing the two reviewed
transforms; every resulting file must match the registry-verified original
SHA-256. It never compares the mitigation with itself. An optional second
argument may instead point to an unmodified baseline package, read-only:

```sh
node backend/tools/dependency-security/verify.mjs
node frontend/tools/dependency-security/verify.mjs
node backend/tools/dependency-security/sync-mirrors.mjs
node --test backend/tools/dependency-security/verify.test.mjs
node backend/tools/dependency-security/review.mjs /absolute/project/root
```

To intentionally regenerate the selected archive from an integrity-verified
unmodified npm package (never from an already patched installation):

```sh
node backend/tools/dependency-security/prepare.mjs /absolute/unmodified/picomatch
node backend/tools/dependency-security/sync-mirrors.mjs --write
```

Regenerate both lockfiles with isolated npm operations after archive changes and
rerun the guard, actual build/discovery and full platform checks. The official
advisory still lists no patched release as of November 18, 2026; registry latest
remains 4.0.7 and upstream PR254 remains open. Replace the local mitigation only
after verifying a compatible official fix. No risk acceptance or advisory ignore
is introduced by this integration.

Current npm advisory visibility after integration: backend full audit exits1
with11 high propagated packages; frontend full audit exits1 with18. Every root
advisory is the same `GHSA-fc5q-39xc-vjpf`; both `--omit=dev` audits exit0 with
zero findings. This is expected version-based visibility for the local patch,
not a claim that the full audit passed or that other security gates are closed.
