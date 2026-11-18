# Picomatch development-toolchain mitigation candidate

Status: **review candidate, not activated**. No application manifest, lockfile,
installed dependency, source harness or production image was changed.

## Installed exposure and upstream state

Both current lockfiles deduplicate `picomatch@4.0.7` with `dev: true`.
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
The parent audit found zero production findings with `--omit=dev`; its full
backend/frontend counts propagate the same advisory through this graph.

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
Current checked configuration glob sources are identical under the candidate.
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

## Executed checks

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

Reproduce from the repository root (the optional argument selects the project
whose installed baseline/configs are inspected):

```sh
node backend/tools/dependency-security/prepare.mjs backend/node_modules/picomatch
node backend/tools/dependency-security/inventory.mjs /absolute/project/root
node backend/tools/dependency-security/review.mjs /absolute/project/root
node backend/tools/dependency-security/review-upstream254.mjs /absolute/project/root
node backend/tools/dependency-security/integration-smoke.mjs
```

Only `review-upstream254` reads the immutable public GitHub proposal;
`integration-smoke` downloads public dependencies to its private temporary npm
cache with lifecycle scripts disabled. `review` itself is offline. Package
source hashes are reproducible; archive bytes also depend on the platform tar
implementation and are separately pinned for the committed artifact.

## Integration checklist for the parent owner

1. Review the deliberate unsupported-pattern/capture restrictions and source
   patch. Approve or reject this candidate explicitly in project review.
2. If selected, add a development-only file dependency on the reviewed tgz and
   `overrides: {"picomatch":"$picomatch"}` to each package, preserving all
   existing overrides. Backend's file path is
   `tools/dependency-security/picomatch-4.0.7-pos-review.tgz`; frontend's is
   `../backend/tools/dependency-security/picomatch-4.0.7-pos-review.tgz`.
3. Regenerate both lockfiles through isolated npm operations. Verify every
   installed picomatch parser SHA against the manifest; do not trust the
   unchanged version string alone. Ensure the tgz is copied into every relevant
   Docker/build context before dependency reification, including omitted-dev
   installs if npm still needs the local resolution target.
4. Run the actual Vite build, Vitest discovery/tests, native desktop matrix and
   normal project security checks against the selected artifact. Keep audit
   output and the local mitigation evidence together; never silently remove
   the still-unpublished advisory from status.
5. Replace the local patch with a verified upstream patched release after
   compatible semantics and actual toolchain checks are established.

Until those steps are completed, the checked project dependencies remain
unchanged and the full development-dependency audit findings remain open.
