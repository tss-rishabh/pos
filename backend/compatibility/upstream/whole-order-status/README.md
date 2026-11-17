# Qualified STORE chain candidate

`pinned-source.js` contains seven executable functions extracted from sync API
commit `70b80159016db39a73572f80bfa87c47201c0a9f`, without bootstrap/global DB/logger
imports. `source-manifest.json` records their provenance and explicit corrections.
`pos-source.json` pins the original POS callback/helper/task for portable tests.

Regenerate from the read-only sibling checkouts, from `backend/`:

```sh
node node_modules/tsx/dist/cli.mjs tools/legacy-order-status/prepare-source.ts
python3 tools/legacy-order-status/prepare-pos-source.py
```

The executable receiver/fenced SQL worker is
`src/modules/legacy-order-status/receiver-plugin.ts`. It injects current native
authority, frozen lossless IDs, vendor attempt receipts, original next-stage
delays, globally serialized pacing and separate Netcore fences into the pinned
functions. It never executes the source AWS/Redis/bootstrap or original logger.
The ordinary STORE flow is supported; membership/Express are separate profiles.

Read `parity/whole-order-status.md` for routing, migration, secrets, explicit
qualification of negative-response retries and deployment exclusions. This
candidate has executable local/source/native evidence; no production receiver or
vendor action was invoked or certified.
