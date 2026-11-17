# Source membership replacement

The pinned `AddFreeMembership.process()` can add the free membership SKU and
call `remove_exclusive_membership()` to remove an explicitly requested paid
membership. This occurs both above the source cart threshold and when the
literal historical eligibility rule qualifies a smaller cart.

The selected profile records that actual removal call. Its optional
`pos-csv-membership-replacement-v1` descriptor binds the unchanged original CSV
SKU, quantity, price and row numbers to the exact native free-membership HP.
Final quantities alone cannot establish that a replacement occurred. Admission
requires one nonactive customer's original paid-member line of quantity one,
one source-added free-member line and every unchanged ordinary line. Existing
descriptors omit the new optional field and retain their original signed bytes.
Multiple-quantity or otherwise unqualified membership cases remain refused.

The original plan, historical date, customer and prices are retained. For an
offline plan containing paid membership at ₹100 and another product at ₹25.49,
the literal source calculator produces ₹25 after replacing the paid member.
The source profile raises the qualified tender-mismatch review before PosOrder;
it does not import that order against ₹125.49 or invent a financial variance.
The existing manager-correction and approval workflow is still required. The
native source reader independently retains the same original-tender check.

Node admission and benefit ownership remove only the authenticated original
member from the expected HP quantities. Offline stock follows actual source HP;
Shopify stock retains the literal original CSV plan, including its original paid
member. Frozen completed proofs validate replacement bindings only after their
enclosing financial HMAC, without current catalog, contact or membership keys.

Validation uses disposable local MySQL and synthetic source catalog/stock:

- 114 tests across the affected member adapter/domain/completion and benefit
  suites pass, including native Python/Node SQL-hash agreement, both staged
  member modes, actual Shopify financial completion, stock and immutable replay.
- Four new literal Cart/removal/calculator cases verify high/low eligibility,
  tender refusal, missing causality, unchanged unqualified history and swallowed
  source refusal aborting the enclosing private transaction.
- The 14 existing source preparation cases and its 84-vector batching matrix
  pass, including 168 HP/refund comparisons. Strict member compilation passes.

This scope does not certify full installed source startup, every custom catalog
or bamboo-product combination, real providers, all cooperating writers or a new
consolidated project release. Production selectors remain unselected.
