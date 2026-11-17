# Native browser fixture readiness

Native run 44072806981 at `3f5a269` passed Electron/offline checks on Windows and
macOS, then failed later recovery-browser steps. Its failed outcome is retained
in `evidence/desktop-ci-3f5a269.json`; this document does not replace that result.

On Windows, the first model-account and parent/store browser workflows exceeded
Vitest's existing 5-second test deadline. The other 103 cases in that step
passed. Each failing suite created a fresh Vite cache and launched Chromium in
`beforeAll`, but deferred the first module compilation, dependency discovery and
page load to its first timed workflow. Cold setup is a likely contributor; a
fresh Windows run remains the authority for the proposed fixture correction.

Both suites now use `prepareBrowserFixture` in their existing startup hook. A
throwaway browser context loads the same real harness through synthetic GET
handlers, waits for the actual workspace controls and finishes static-import
processing. Closing that context discards its storage and API fixture state.
Individual cases still create fresh contexts and independently verify every
original action, response and storage invariant. No test/action/hook deadline,
retry count, product code or business assertion changes. Both affected suites
pass locally: 14 cases with their existing deadlines.

The macOS failure was independently reproduced in the correction fixture. A
request was added to `state.posts` before an awaited browser-journal check and
before its receipt was stored. The test used the request-start count as if it
were the commit boundary. A controlled gate now proves the receipt is absent
while that check is pending. After releasing it, the test waits for the actual
Recorded correction receipt with the second operation UUID, then keeps its
original final assertions. Separate waits ensure the original 404 and 500
responses are both exercised and neither creates a native fence. All 8
correction-browser cases pass locally, along with their strict compiler check.

Run `44091182603` on `0f865c8` passes the complete macOS job. Windows passes
the previously failing order-payment cases, native Electron/offline checks and
105 browser cases, then fails the first customer-profile workflow at its existing
five-second deadline. No browser trace captured the exact point of that deadline;
cold setup is a possible contributor, not a proved product latency diagnosis.

The customer-profile suite now prepares its real harness in `beforeAll` using
the same helper and a fresh temporary Vite cache. The throwaway page reaches
the actual controls, makes no API requests and closes before each independent
workflow context begins. All 23 local cases, including escaping, offline privacy,
lost replies and authority changes, pass with their original deadlines. The
strict fixture compiler check passes. Target Windows acceptance remains pending.

These changes validate fixture ordering. They do not establish production
latency, complete legacy parity, signing, hardware printing or a passing native
release gate. Both target operating systems must run the published revision.
