package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"database/sql"
	"errors"
	mysql "github.com/go-sql-driver/mysql"
	"os"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
)

// These entrypoints run only in the disposable database created by the
// cross-language runner. They do not initialize an upstream application.
func bridgeDB(t *testing.T) *sql.DB {
	t.Helper()
	if os.Getenv("POS_CHECKOUT_MYSQL_DSN") != "root@tcp(mysql:3306)/pos_checkout_contract_test?parseTime=true" {
		t.Fatal("isolated bridge database required")
	}
	db, err := sql.Open("mysql", os.Getenv("POS_CHECKOUT_MYSQL_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if os.Getenv("POS_BASE_MEMBERSHIP_HEAD_FIXTURE") == "1" {
		return nativeHeadFixtureApplication(t, db, "connect")
	}
	return db
}
func TestMembershipBridgeInitialize(t *testing.T) {
	if os.Getenv("POS_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("cross-language runner only")
	}
	db := fixture(t)
	seedOrder(t, db, 5001, 14, 0, 0)
	if os.Getenv("POS_MEMBERSHIP_BRIDGE_KIND") == "upgrade" {
		execute(t, db, `INSERT INTO user_eav(entity,attribute,value,is_active,created_at,updated_at) VALUES('fixture@example.test','EXCLUSIVE_MEMBER','1',1,'2025-01-02 03:04:05','2025-02-03 04:05:06'),('fixture@example.test','EXCLUSIVE_EXPIRY','2030-01-01T00:00:00',1,'2025-01-02 03:04:05','2025-02-03 04:05:06')`)
	}
}
func TestMembershipBridgeActivationRollback(t *testing.T) {
	if os.Getenv("POS_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("cross-language runner only")
	}
	db := bridgeDB(t)
	tables := []string{"user_eav", "pos_rewrite_membership_versions", "pos_rewrite_cancellation_membership_provenance", "product_store", "orders"}
	before := snapshot(t, db, tables)
	execute(t, db, `ALTER TABLE pos_rewrite_checkout_projections ADD CONSTRAINT fixture_membership_stock_failure CHECK(order_id<0)`)
	ctx, err := consentContext(db, 5001)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	_, err = poscheckout.Confirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
	execute(t, db, `ALTER TABLE pos_rewrite_checkout_projections DROP CHECK fixture_membership_stock_failure`)
	var native *mysql.MySQLError
	if !errors.As(err, &native) || native.Number != 3819 || !called || !reflect.DeepEqual(before, snapshot(t, db, tables)) {
		t.Fatal("late source failure did not roll membership/revision/proof/stock back")
	}
}
func TestMembershipBridgeActivate(t *testing.T) {
	if os.Getenv("POS_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("cross-language runner only")
	}
	db := bridgeDB(t)
	var created atomic.Int32
	var group sync.WaitGroup
	failures := make(chan error, 20)
	for index := 0; index < 20; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			result, err := confirm(db, 5001)
			if err != nil {
				failures <- err
				return
			}
			if result.Created {
				created.Add(1)
			}
		}()
	}
	group.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	var contract string
	if err := db.QueryRow(`SELECT contract_version FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=5001`).Scan(&contract); err != nil {
		t.Fatal(err)
	}
	if created.Load() != 1 || contract != poscheckout.MembershipContract || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 18 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 1 || number(t, db, `SELECT COUNT(*) FROM user_eav WHERE is_active=1`) != 2 {
		t.Fatal("source activation/proof was not exactly once")
	}
	if os.Getenv("POS_MEMBERSHIP_BRIDGE_KIND") == "upgrade" {
		var expiry, member string
		if err := db.QueryRow(`SELECT value FROM user_eav WHERE attribute='EXCLUSIVE_EXPIRY'`).Scan(&expiry); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(`SELECT value FROM user_eav WHERE attribute='EXCLUSIVE_MEMBER'`).Scan(&member); err != nil {
			t.Fatal(err)
		}
		// Literal API-v2 adds365 while staging; literal Go adds365 again.
		// Preserve the source result in evidence; cancellation still restores2030.
		if expiry != "2032-01-01T00:00:00.000000" || member != "6" {
			t.Fatal("literal source upgrade activation changed")
		}
	}
}
func TestMembershipBridgeImmutableReplay(t *testing.T) {
	if os.Getenv("POS_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("cross-language runner only")
	}
	db := bridgeDB(t)
	before := snapshot(t, db, []string{"user_eav", "pos_rewrite_membership_versions", "product_store"})
	result, err := confirm(db, 5001)
	if err != nil || result.Created || !reflect.DeepEqual(before, snapshot(t, db, []string{"user_eav", "pos_rewrite_membership_versions", "product_store"})) {
		t.Fatal("historical paid replay repeated or depended on a later membership change")
	}
}
