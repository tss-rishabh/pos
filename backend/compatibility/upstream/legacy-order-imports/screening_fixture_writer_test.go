package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"context"
	"database/sql"
	"testing"
)

func screeningFixtureWriter(t *testing.T, db *sql.DB, customers, orders, lines []int64) (*sql.Tx, func() error) {
	t.Helper()
	raw, ok := importFixtureApplications.Load(db)
	if !ok {
		t.Fatal("independent application writer missing")
	}
	app, ok := raw.(*sql.DB)
	if !ok {
		t.Fatal("invalid application writer")
	}
	tx, release, err := poscheckout.ImportNativeFixtureBegin(context.Background(), app, customers, orders, lines)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { release(); tx.Rollback() })
	return tx, release
}
func screeningFixtureMutation(t *testing.T, db *sql.DB, customers, orders, lines []int64, query string, args ...interface{}) {
	t.Helper()
	tx, release := screeningFixtureWriter(t, db, customers, orders, lines)
	if _, err := tx.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
