Native validation, 18 November 2026
=================================

The composed payments source uses upstream commit
434f3e438d1cb48c64e5723222c6efda506db571, the owned producer fixes, the fresh Go
head audit, and the shared descriptor/counter definitions from 16baef2.
Pinned Go 1.25.4 and MySQL 8.4 images ran against disposable databases only;
module files remained unchanged and dependency/build caches were task-local.
No real provider, production database or external financial endpoint was used.

Actual composed `go build -mod=readonly ./internal/poscheckout ./juspay` passed.
`go vet -mod=readonly ./internal/poscheckout` passed. Both new native test
families passed with default test vet, `-race`, and `-count=1`:

* Fresh full sixteen-section metadata audit accepts the isolated reviewed
  installation and actual RC transaction, rejects actual RR and a session-RC
  spoof, and rejects seven current changes: owner role exposure, an additional
  administrator-owned trigger, a head view alias, global CREATE, head UPDATE,
  native TRIGGER, and global SELECT WITH GRANT OPTION. Every restored policy
  passes again. Both fixed functions, all four source triggers and all nine
  counter triggers plus their procedure are real reviewed SQL installed by
  `tests/native-head-metadata/fixture.ts` under distinct locked owners.
* Actual `Engine.Start` independently tests an invalid baseline and a global
  writer introduced after command/creation signing. Both return signed immutable
  NO_EFFECT/noProviderDispatch receipts without calling the provider. An ordinary
  valid initial start commits SENDING before a separate connection in the provider
  spy can observe it; a lost ACK becomes UNCERTAIN and POST replay never starts
  again. Each case resets a disposable command lifecycle; no receipt is deleted
  to authorize a production retry. The provider request builder and provider are
  fixture ports here; the actual gateway transport has separate tests below.

The previous six native terminal/read/recovery/effect/funding/key-bound tests
were rerun against the updated actual package with default vet and race enabled;
all passed. In particular stage recovery stays on existing attempts, terminal
GET wins, unknown delivery stays uncertain, and reads never redispatch effects.

The dedicated runner is `run-head-native-tests.mjs`. Invoke it using the existing
backend tsx loader, with backend-root, composed-source, module-cache and
build-cache arguments. It requires an explicit local passwordless-root
`CHECKOUT_MYSQL_TEST_URL` ending in `/pos_rewrite_checkout_test` and an isolated
`POS_ORIGIN_HEAD_DOCKER_NETWORK` with the disposable server at alias `mysql`.
It copies tests into a fresh artifact, builds the actual source, runs default
vet and native fixtures, then cleans fixture accounts and copied artifacts.

Full-source default vet remains blocked by the original wallet date layout
`2006-02-01` in the upstream juspay package. The runner refuses this by default.
For the reported focused native run only,
`POS_ORIGIN_DIAGNOSTIC_UPSTREAM_VET_GAP=1` leaves native poscheckout vet enabled
and clearly reports the outstanding upstream gate. This is not a full-source
pass or permission to activate the financial date correction.

Earlier actual gateway tests passed with race and diagnostic `-vet=off`: local
TLS accepted a provider POST and lost its ACK; recovery made GET-only calls and
preserved native jp_orders/customer bindings. An artifact-only startup shim
prevented upstream config.InitEnv from overwriting the disposable DB settings
and AutoMigrating an upstream configured database. No production loader changed.

Four Python issuer/cart tests passed on disposable native MySQL using actual
owned issuer, legacy_staff issuance, source authentication/JWT cryptography and
source HMACs. They cover immutable recovery proof lifetime, stale/native changed
scope refusal, genuine staff cart grant payload matching, SQL release before
HTTP, stale actor refusal and closed URL scope. Django middleware/request and
HTTP transport are fixture adapters; this is not a deployed browser/login test.

The calendar-expiry candidate and decision document remain inactive review
artifacts. Candidate-only native evidence is recorded separately in
`expiry-review/parity-decision.md`; user authorization is still required before
any financial date predicate changes. No broad security or parity certification
is claimed by these focused results.
