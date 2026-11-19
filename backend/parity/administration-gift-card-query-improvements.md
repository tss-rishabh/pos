# Gift-card batch query improvements

The legacy list (`gift_card_datatable.py`) counts, pages and then fetches creators separately. The rewrite runs one
`COUNT(*)` and one bounded `LEFT JOIN pos_user` page on the primary reader with the same sort column and Django
paginator fallback, and adds `id` as a tiebreaker for non-id sorts (legacy order among ties is unspecified).
Authorization is confirmed on the writer. `gift_card_collection` is small (one row per batch), so no index is proposed;
the schema freeze forbids DDL in any case.

The legacy search raises `FieldError` for every non-empty term; the rewrite's literal `id`/`size`/`message` match is a
behaviour repair, not query tuning.
