# Store city reference in create and edit forms

Pinned source `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` renders `stores/templates/stores/_form.html` from both `create.html` and `edit.html`. The shared partial at line200 posts `<input type="hidden" name="city_id" id="city_id" value="1111">`; it does not expose an editable internal city identifier. Its postal script changes city/state names, country/state references and exact coordinates while leaving city_id/address unchanged. `StoreCreateForm` accepts city_id as a required integer.

The rewrite now initializes **new** store editor state to cityId1111 and removes the City reference control. It still submits a validated numeric cityId through the unchanged backend contract. Postal/country/state behavior and other controls are unchanged. Editing initializes from the actual stored cityId, including0, and preserves it on save; a successful postal lookup or an unrelated unsaved edit does not reset it.

The source edit quirk is explicit: because its shared partial hardcodes1111, an existing store with another city reference would be rewritten to1111 on submission. Per the instructed correction, the rewrite retains that store's actual reference. This is a bounded data-preservation correction, not a claim of identical source edit output for those rows. Source role-two empty role options and all permissions remain outside this change.

Four focused Chromium component workflows passed: complete new-store POST body equality after no-match/matching postal lookups, existing-franchise create body cityId1111, and stored cityId0/7 edit PUT preservation. They also assert that the City reference control is absent and unsaved address/name edits survive lookup. These use the real React editor/client but intercepted API fixtures; they are not native database or full Django/API/UI form parity. Frontend strict, separately scoped test strict and changed-file ESLint passed. [The bounded receipt](evidence/administration/store-city-default.json) records hashes and the four executed cases;23 unrelated cases were filtered out.

The existing joined-lookup test was adapted to the removed control: every native postal response, coordinate/country/state display, no-match, address and privacy assertion remains, and it asserts the internal city control is absent. Its old premise of manually typing city7 is replaced by the focused edit/save payload cases above. The joined runner was **not rerun** for this change, and historical receipts are untouched. The wider source store/operator create/update proof remains separate.

Focused command from `frontend`, with Node24 and locked dependencies:

```sh
CI=true NODE_ENV=test TZ=UTC ADMINISTRATION_BROWSER_TESTS=true \
  node node_modules/vitest/vitest.mjs run tests/administration/workflows.test.ts \
  --maxWorkers=1 \
  -t 'source new-store city default|preserves stored city reference|associates an existing franchise'
```
