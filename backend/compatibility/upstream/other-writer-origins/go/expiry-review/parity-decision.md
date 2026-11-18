# Approved correction: calendar date comparison on payment-failure wallet restoration

Status: user approved **Use correct calendar-date ordering** on 2026-11-18.
The reviewed correction is active in both owned producers. Fresh native
verification of this activation remains pending until implementation is complete
and the native verification slot is available; the evidence below remains the
historical scratch-candidate result, not a new execution receipt.

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
vet failure remains historical evidence until a fresh default-gate run verifies
the activated output.

## Activation provenance

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

The follow-up verification remains the same ten native Money/Points expiry
subcases and two real TLS gateway recovery cases with default vet and the race
detector. Use the calendar expectation mode
`POS_ORIGIN_EXPIRY_CANDIDATE=1` in the retained review fixture; its original
expectation mode remains available to reproduce the historical source defect.


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
