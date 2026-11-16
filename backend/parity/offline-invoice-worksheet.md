# Offline manual invoice worksheet

The pinned source `core/templates/offline_billing/biller.html` and
`core/views.py:1882` supply a manual-price worksheet, separate from a settled POS
sale. The rewrite keeps product/barcode selection, customer label/email, per-row
quantity and manually entered price, row removal, subtotal, downward invoice
rounding, reset, printing and the original fourteen-column `invoice.csv` export.
Source UTC CSV timestamps and first-row order metadata remain intact. Continuation
rows now have all fourteen cells, with the source's missing final empty cell made
explicit. No order, payment, stock or customer write occurs.

The existing paginated primary catalog reader is reused with out-of-stock items
included, preserving its source sellability predicates. The former whole-catalog
stream/string assembly is replaced by search/keyset pages and the existing
owner/store-scoped offline cache. Manual prices never enter a cash receipt or an
automatic checkout command. Customer labels remain only in component memory and
the explicitly requested print/export; no browser persistence or logs retain them.

Validation retains decimal-string IDs and exact paise, bounds quantities/totals,
quotes CSV punctuation and refuses spreadsheet-formula customer fields. The
source's duplicate-product removal bug is corrected by using per-row identities.
Printing clones text-only React output into a sandboxed frame with scripts and
external content disabled. The printout is marked as an unpaid worksheet instead
of asserting a collected payment or a hardcoded store GST registration.

The source differential executes the original JavaScript export functions with
fixed time and synthetic DOM inputs. Its template hash is pinned, and ordinary
row/metadata/money semantics match in paise; binary float suffixes are replaced
by exact two-decimal amounts. Fourteen checks cover duplicate deletion,
wide IDs, exact paise, malformed input, CSV quoting/formula safety and empty
worksheets. Two actual Chromium scenarios pass for manual row selection/removal,
CSV downloads, sandboxed print content, no financial request, cached products
while offline and clearing prior customer labels after an operator change. The
print frame is intentionally invisible on screen; its prepared content and
print invocation are verified. These checks do not certify physical printers or
downstream financial import execution.

Desktop-only CI can replay the three exact extracted functions in
`frontend/tests/offline-worksheet/source-oracle.json`, bound to the original
commit/template/function hashes. When the protected source checkout is present,
the same test also compares that snapshot with the actual pinned template. Full
project parity verification still requires the clean pinned source checkout;
the standalone replay does not replace that release requirement.
