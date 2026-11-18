package poscheckout

import (
	"context"
	"database/sql"
	"github.com/go-sql-driver/mysql"
	"os"
	"strings"
	"testing"
)

// The fixture installer uses the actual reviewed four origin triggers, nine
// counter triggers/procedure, both locked audit functions and isolated accounts.
func TestOriginNativeHeadFreshAuthorityAndActualIsolation(t *testing.T) {
	raw := os.Getenv("POS_ORIGIN_HEAD_DSN")
	cfg, err := mysql.ParseDSN(raw)
	if err != nil || cfg.Net != "tcp" || cfg.Addr != "mysql:3306" || cfg.DBName != "native_head_go_validation" || cfg.User != "origin_go_app" {
		t.Fatal("explicit isolated full-head fixture required")
	}
	app, err := sql.Open("mysql", raw)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	admin, err := sql.Open("mysql", "root@tcp(mysql:3306)/native_head_go_validation?parseTime=true")
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	ctx := context.Background()
	qualify := func(level sql.IsolationLevel) error {
		tx, e := app.BeginTx(ctx, &sql.TxOptions{Isolation: level})
		if e != nil {
			return e
		}
		defer tx.Rollback()
		var n int
		if e = tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); e != nil {
			return e
		}
		_, e = counterMetadata(ctx, tx)
		return e
	}
	if err = qualify(sql.LevelReadCommitted); err != nil {
		t.Fatalf("valid full isolated installation refused: %v", err)
	}
	if err = qualify(sql.LevelRepeatableRead); err == nil {
		t.Fatal("actual repeatable-read transaction passed")
	}
	// Session default RC cannot authorize an actual RR transaction.
	app.SetMaxOpenConns(1)
	if _, err = app.Exec(`SET SESSION transaction_isolation='READ-COMMITTED'`); err != nil {
		t.Fatal(err)
	}
	if err = qualify(sql.LevelRepeatableRead); err == nil {
		t.Fatal("session RC spoof authorized actual RR")
	}
	counterOwner := strings.Split(os.Getenv("POS_SCREENING_COUNTER_TRIGGER_DEFINER"), "@")
	if len(counterOwner) != 2 {
		t.Fatal("counter owner required")
	}
	quotedCounter := "'" + counterOwner[0] + "'@'" + counterOwner[1] + "'"
	for _, attack := range []struct{ name, setup, restore string }{
		{"owner role exposure", "GRANT 'origin_go_unknown'@'%' TO " + quotedCounter, "REVOKE 'origin_go_unknown'@'%' FROM " + quotedCounter},
		{"administrator implicit trigger", "CREATE TRIGGER origin_unknown_writer AFTER INSERT ON coupons FOR EACH ROW SET @origin_fixture_marker=1", "DROP TRIGGER origin_unknown_writer"},
		{"head alias", "CREATE VIEW origin_unknown_head_alias AS SELECT * FROM pos_rewrite_screening_counter_heads", "DROP VIEW origin_unknown_head_alias"},
		{"late global writer", `GRANT CREATE ON *.* TO 'origin_go_unknown'@'%'`, `REVOKE CREATE ON *.* FROM 'origin_go_unknown'@'%'`},
		{"late head mutation", `GRANT UPDATE ON native_head_go_validation.pos_rewrite_screening_counter_heads TO 'origin_go_unknown'@'%'`, `REVOKE UPDATE ON native_head_go_validation.pos_rewrite_screening_counter_heads FROM 'origin_go_unknown'@'%'`},
		{"late table trigger", `GRANT TRIGGER ON native_head_go_validation.orders TO 'origin_go_unknown'@'%'`, `REVOKE TRIGGER ON native_head_go_validation.orders FROM 'origin_go_unknown'@'%'`},
		{"late grant option", `GRANT SELECT ON *.* TO 'origin_go_unknown'@'%' WITH GRANT OPTION`, `REVOKE SELECT,GRANT OPTION ON *.* FROM 'origin_go_unknown'@'%'`},
	} {
		t.Run(attack.name, func(t *testing.T) {
			if _, e := admin.Exec(attack.setup); e != nil {
				t.Fatal(e)
			}
			e := qualify(sql.LevelReadCommitted)
			if _, restoreErr := admin.Exec(attack.restore); restoreErr != nil {
				t.Fatal(restoreErr)
			}
			if e == nil {
				t.Fatal("changed current authority passed fresh audit")
			}
			if e = qualify(sql.LevelReadCommitted); e != nil {
				t.Fatalf("restored exact policy refused: %v", e)
			}
		})
	}
}
