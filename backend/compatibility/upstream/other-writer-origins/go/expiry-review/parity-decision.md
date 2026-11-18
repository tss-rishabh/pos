# Approved correction: calendar date comparison on payment-failure wallet restoration

Status: user approved **Use correct calendar-date ordering** on 2026-11-18.
The reviewed correction is active in both owned producers. The final preserved-
baseline native run passed20 expiry subcases and2 TLS gateway cases under default
vet/race, recorded in `active-calendar-native.json`. The earlier scratch-candidate
evidence below remains historical and is not substituted for that fresh result.

Pinned payments `434f3e438d1cb48c64e5723222c6efda506db571`, `juspay/model.go` lines1677 and1763, calls **Format**, not Parse:

```go
expiry.Format("2006-02-01") >= time.Now().Format("2006-02-01")
```

Go's layout yields year-day-month. Lexicographic comparison therefore changes calendar ordering across month boundaries. The candidate replaces all four Format arguments in the two original money/points methods, and their two selected generated counterparts, with `2006-01-02` (DateOnly). It keeps native expiry, inclusive expiry-day behavior, IsExpired, amounts, original mapping, wallet rounding, and histories unchanged. It introduces no bank refund or new expiry period.

At 2026-11-18, for a source debit of10 and current wallet100:

| Native expiry | Original strings | Original result | Candidate result |
| --- | --- | --- | --- |
| 2026-12-01 | 2026-01-12 < 2026-18-11 | Wallet100; expired history−10 | Wallet110; PAYMENT_FAILED credit+10 |
| 2026-10-20 | 2026-20-10 >= 2026-18-11 | Wallet110; PAYMENT_FAILED credit+10 | Wallet100; expired history−10 |
| 2026-11-18 | equal | Wallet110 | Wallet110 |
| 2026-11-17 | earlier day | Wallet100 | Wallet100 |
| 2027-01-01 | later year | Wallet110 | Wallet110 |

These outcomes apply separately to TSS Money and TSS Points. Cashback remains unchanged by the selected money restoration. A wallet transaction list shows the original `PAYMENT_FAILED` or `TSS_MONEY_EXPIRED`/`TSS_POINTS_EXPIRED` ledger platform and amount; this patch does not alter frontend contracts or claim a cash/bank refund.

The selected Node/Python source-origin paths delegate this failure restoration to Go; they do not independently compare this Go layout. Independent Node cancellation restoration uses calendar dates and its own allocation policy. Python source history/preview has no replacement of this payment-failure predicate. Those independent paths should remain unchanged, with no broad expiry restoration introduced. A search for the swapped Go/Python layout found no literal counterpart in owned Node/Python sources; it is inherited by the Go producer from the pinned source.

The two original and two generated failure-restoration predicates now compose
together to calendar DateOnly. The swapped literal remains only in immutable
pinned source and as an explicit, checked input seam to the producers. No
dynamic-string workaround or vet suppression is introduced. The earlier default
vet failure remains historical evidence; the final activated output passed the
fresh default build/vet and race gates.

## Activation provenance

The user's approval explicitly requires preserving cashback. The retained
original Money method is used by authenticated webhook/cron fallbacks for
unregistered online orders, so its old combined cashback/Money UPDATE was not
unreachable. The composer now changes only that exact statement, within the
pinned original `RevertTssMoney` boundary, to the same Money-only UPDATE used by
the selected generated method. It removes the duplicate cashback binding while
retaining the amount expression and both original history writes. External
pinned source remains unchanged. The prior DateOnly-only assembly is historical
and cannot qualify this additional preservation correction.

The original Money method still writes `reward_point_history` alongside
`tss_money_history`, even though actual cashback remains unchanged. This mirror
is retained source behavior. The user explicitly approved retaining this extra
Points-history entry with **"use same behavior we have currently"**, reviewed at
2026-11-18 12:21:27 UTC; see `source-history-retention-approval.json`. The generated
selected Money method retains its existing deliberate omission of that mirror.
The approval does not unify those histories or authorize a generated-method
history change.

The exact reviewed `calendar-expiry-candidate.patch` is now applied to
`../compose.py` and `../transform_source.go`; the patch is retained unchanged as
the historical activation input. No external source repository is modified.

- `compose_payments()` changes the four exact `.Format("2006-02-01")`
  occurrences in the owned composed `juspay/model.go` to
  `.Format("2006-01-02")`, refusing a changed pinned occurrence count. These
  belong to the original `RevertTssMoney` and `RevertTssPoints` predicates.
- The pinned AST transformer changes exactly two string literals in each
  selected original method before writing `juspay/origin_source.go`, yielding
  `revertOtherOriginMoney` and `revertOtherOriginPoints` with the same calendar
  comparison. A changed count in either selected function fails generation.
- Those two Go files are generated owned build outputs. Checking in or editing
  the external pinned payments tree would bypass the composition contract.
  Native expiry values, `IsExpired`, inclusive expiry day, allocation mappings,
  rounding, ledger behavior, cashback preservation and independent cancellation
  policies retain their existing implementation.

Follow-up verification now adds ten direct original Money/Points expiry
subcases to the retained ten generated subcases and two real TLS gateway
recovery cases, all with default vet and the race detector. Every wallet case
requires cashback7. Use the calendar expectation mode
`POS_ORIGIN_EXPIRY_CANDIDATE=1` in the retained review fixture; its original
expectation mode remains available to reproduce the historical source defect.
The additive `active-original-calendar_test.go` temporarily binds `utils.Db` to
the same guarded disposable ORM and restores it after the test; it performs no
provider calls. Four precisely counted comparison clocks are frozen only in
the disposable test copy. The expanded native scope passed in the final run.


## Native fixture evidence (2026-11-18)

The ten matrix cases above now ran against the actual generated money/points
reversal functions and a disposable MySQL8.4 schema. Only the disposable copy's
clock was bound to 2026-11-18. Original-source behavior passed10 subcases in a
diagnostic `-vet=off` run; this does not pass the blocked default source gate.
The inactive candidate patch was applied to a scratch producer, regenerated,
and passed10 native subcases plus2 real TLS gateway recovery tests with the
default vet gate and race detector. The observed wallet amounts, ledger
platforms/deltas and unchanged cashback7 matched the table above for both
assets. No source/production schema or provider was contacted.

Review fixture: `expiry_candidate_test.go`; scratch candidate output:
`/tmp/pos-origin-expiry-candidate-native-20261118.log`. This evidence preceded
the user approval and activation above. It does not replace fresh native
verification of the activated owned build outputs.

## Strict native NULL mapping correction

The later original-method diagnostic found numeric MySQL1292 for unset expiry
inserts under unchanged strict/NO_ZERO_DATE mode. Verified physical Money and
Points history expiry columns are nullable DATETIME with DEFAULT NULL; both
original and generated methods share the original Go models' `time.Time` expiry.
The generated negative-history helper already omits an unset expiry.

The composer redirects only the two original Money-history, two original
Points-history and two retained reward-history Create sites, under exact pinned
method/count guards, to typed
helpers in `payload/juspay/origin_failure_history.go`. Only `Expiry.IsZero()`
omits SQL expiry; a real earning expiry uses the original full Create unchanged.
Amounts, native expiry values, mappings, cashback7 and `IsExpired` remain intact.
No table/default/SQL-mode modification or global model hook is introduced.

Additive native assertions now require SQL NULL to scan into the original
Go/GORM model as zero `time.Time`, with the same Go JSON expiry representation
as an unset original Go field. A nonzero earning expiry must retain its actual
time value and representation. Those assertions passed in the final canonical
run. They do not prove Django/frontend or another consumer's serialization.

The user explicitly chose to retain the separate original Money reward-history
entry, matching the already implemented and natively verified source baseline.
Its amounts/platform and count remain unchanged. The typed zero-expiry mapping applies
only to its two pinned Create sites, allowing the existing entry to persist under
the actual nullable expiry contract. No runtime policy flag or mirror removal is
introduced. SQL NULL/Go-zero/Go-JSON representation assertions cover that model
too. The fresh assembly/native run passed on this preserved baseline before the
explicit retention answer. That answer requires no new code or native run.
Earlier failed artifacts and the final execution receipt remain immutable.

## Final canonical execution (2026-11-18)

`active-calendar-native.json` binds the pinned clean source, all four actual
method hashes, active producer/fixture/runner hashes and the 115-file fresh
assembly manifest `14ef21d7808117167de15f27ebd149fef9f0a29caf269a31e746028254463ba8`.
The unchanged output built and passed default vet before any disposable clock or
startup-loader substitution. The exact native target then passed ten original
expiry subcases, ten generated subcases and two real TLS gateway recovery cases
with the race detector/default vet, no failures/skips and the unchanged five-
minute test deadline. Both parent test events also passed (24 named events).
All six original history-write sites, retained reward mirror, native earning
expiry/mappings and independent cashback7 were checked.

Four exact owned containers, one internal network and its one anonymous MySQL
volume were confirmed absent after cleanup. No production database/provider was
contacted, and no release ledger was promoted. The prior zero-test executable-
tmpfs failure, seven-case original-history failure and numeric1292 diagnostic
remain separately retained; none is counted as a pass. This bounded success is
not a global feature parity or production-readiness certificate.
