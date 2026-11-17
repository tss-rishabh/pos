# Independent native ESM startup

Direct `benefit-profile/contracts` import previously loaded financial crypto → financial schemas → benefit completion before `automaticCouponReceiptSchema` initialized. Membership domain/completion had the corresponding schema cycle. Vitest's transform/import order hid these failures.

The schema-free `financial-adapter-primitives.ts` owns only the existing `AppError` factory and canonical constant-time hash comparison. Financial crypto re-exports both functions for every existing caller. Benefit contracts/crypto and membership domain import that leaf directly. No schema, HMAC algorithm, purpose/key derivation, authorization or error response changes.

`tools/legacy-import-esm/check.ts` imports 16 independent entries in separate native processes, once using `node --import tsx` and once using actual emitted NodeNext JavaScript with plain `node`. Before extraction, 22/32 passed; benefit contracts, benefit completion, benefit source history, membership domain and membership completion failed in both modes. After extraction, all 32 pass. Emission uses an isolated temporary directory removed in `finally`; shared `dist` is untouched. Child processes receive no inherited service/cloud credentials, and failed import output/errors are never forwarded.

The compatibility tests retain pre-extraction golden key/financial/source/benefit HMAC bytes, exact error name/status/code/message, canonical hash rejection and re-export function identity. The 72 related benefit/membership/compatibility cases pass. This startup check executes no provider/database operation and adds no release certification.

```sh
node --import tsx tools/legacy-import-esm/check.ts
npx tsc -p tools/legacy-import-esm/tsconfig.json --noEmit
npx vitest run tests/legacy-import-esm --maxWorkers=1
```

Keep the native-process tool as a separate verification step; Vitest imports alone cannot establish this initialization property.
