# Pending decision: calendar date comparison on payment-failure wallet restoration

Status: review candidate only. The active source predicates remain unchanged.

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

Acceptance needed: change the two original and two generated failure-restoration predicates together to calendar DateOnly. The default Go vet gate presently identifies this existing source defect. Its warning will remain reported until the decision is resolved; no dynamic-string workaround will conceal it.


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
`/tmp/pos-origin-expiry-candidate-native-20261118.log`. The original expiry
predicate remains active in the owned producer until the requested decision.
