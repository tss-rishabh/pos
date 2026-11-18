// Runner-only cooperative maintenance entry. Copied solely into the disposable
// Go fixture assembly, never included in a production overlay.
package poscheckout

import (
	"context"
	"database/sql"
	"sort"
)

func ImportNativeFixtureBegin(ctx context.Context, db *sql.DB, customers, orders, lines []int64) (*sql.Tx, func() error, error) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, nil, err
	}
	p := &importConfirmationPrelude{}
	release := func() error { return releaseScreeningCounter(ctx, tx, p) }
	fail := func(e error) (*sql.Tx, func() error, error) { release(); tx.Rollback(); return nil, nil, e }
	if len(customers) < 1 || len(customers) > 10 || len(orders) > 100 || len(lines) > 100 {
		return fail(ErrReview)
	}
	for _, ids := range [][]int64{customers, orders, lines} {
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		for i, id := range ids {
			if id < 1 || (i > 0 && ids[i-1] == id) {
				return fail(ErrReview)
			}
		}
	}
	for _, id := range customers {
		var found int64
		if err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE id=? FOR UPDATE`, id).Scan(&found); err != nil || found != id {
			return fail(ErrReview)
		}
	}
	if err = qualifyScreeningCounter(ctx, tx); err != nil {
		return fail(err)
	}
	for _, id := range customers {
		if err = acquireCounterName(ctx, tx, p, "u", id); err != nil {
			return fail(err)
		}
	}
	for _, group := range []struct {
		table, kind string
		ids         []int64
	}{{"orders", "o", orders}, {"has_products", "p", lines}} {
		for _, id := range group.ids {
			var found int64
			err = tx.QueryRowContext(ctx, "SELECT id FROM "+group.table+" WHERE id=? FOR UPDATE", id).Scan(&found)
			if err != nil && err != sql.ErrNoRows {
				return fail(err)
			}
			if err = acquireCounterName(ctx, tx, p, group.kind, id); err != nil {
				return fail(err)
			}
		}
	}
	return tx, release, nil
}
