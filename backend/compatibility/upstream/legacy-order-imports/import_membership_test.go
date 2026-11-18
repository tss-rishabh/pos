package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"database/sql"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestImportMembershipInitialize(t *testing.T) {
	if os.Getenv("POS_CSV_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("isolated cross-language runner only")
	}
	db, _ := importSourceFixture(t)
	kind := os.Getenv("POS_CSV_MEMBERSHIP_KIND")
	execute(t, db, `UPDATE has_products SET qty=1,price=100 WHERE order_id=5001`)
	if strings.HasSuffix(kind, "upgrade") {
		execute(t, db, `INSERT INTO user_eav(entity,attribute,value,is_active,created_at,updated_at) VALUES('fixture@example.test','EXCLUSIVE_MEMBER','1',1,'2025-01-02 03:04:05','2025-02-03 04:05:06'),('fixture@example.test','EXCLUSIVE_EXPIRY','2030-01-01T00:00:00',1,'2025-01-02 03:04:05','2025-02-03 04:05:06')`)
	}
	if strings.HasSuffix(kind, "auto-free") || strings.HasSuffix(kind, "auto-history") {
		value := 2300
		if strings.HasSuffix(kind, "auto-history") {
			value = 1999
		}
		execute(t, db, `UPDATE orders SET pay_amt=? WHERE id=5001`, value)
		execute(t, db, `UPDATE has_products SET price=0 WHERE order_id=5001`)
		execute(t, db, `INSERT INTO has_products(id,order_id,prod_id,qty,price,status) VALUES(6002,5001,11,1,?,'INCOMPLETE')`, value)
	}
	if strings.HasPrefix(kind, "shopify") {
		execute(t, db, `UPDATE orders SET payment_method=15,payment_status=1,order_status=1 WHERE id=5001`)
	}
}
func importMembershipCapability(t *testing.T, db *sql.DB) map[string]interface{} {
	t.Helper()
	var raw []byte
	if err := db.QueryRow(`SELECT state FROM pos_rewrite_import_financial_operations WHERE id=?`, importOperation).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var state map[string]interface{}
	if json.Unmarshal(raw, &state) != nil {
		t.Fatal("fixture state malformed")
	}
	now := time.Now().UnixMilli()
	return map[string]interface{}{"contract": "pos-legacy-order-import-source-v1", "phase": "confirmation", "operationId": importOperation,
		"requestHash": strings.Repeat("a", 64), "planHash": strings.Repeat("b", 64), "namespace": "pos-import-v1:" + importOperation,
		"planDigest": strings.Repeat("c", 64), "scope": state["scope"], "authority": state["authority"], "orderId": "5001", "nonce": importNonce, "issuedAt": now, "expiresAt": now + 60000}
}
func TestImportMembershipActivationRollback(t *testing.T) {
	if os.Getenv("POS_CSV_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("isolated bridge only")
	}
	db := importApplicationBridgeDB(t)
	tables := []string{"user_eav", "pos_rewrite_membership_versions", "pos_rewrite_cancellation_membership_provenance", "product_store", "orders", "pos_rewrite_import_financial_source_receipts"}
	before := snapshot(t, db, tables)
	execute(t, db, `ALTER TABLE pos_rewrite_checkout_projections ADD CONSTRAINT csv_member_late_failure CHECK(order_id<0)`)
	called := false
	_, err := importFixtureConfirm(importContext(t, importMembershipCapability(t, db)), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
	execute(t, db, `ALTER TABLE pos_rewrite_checkout_projections DROP CHECK csv_member_late_failure`)
	if importFixtureError(err) != "mysql3819" || !called || !reflect.DeepEqual(before, snapshot(t, db, tables)) {
		t.Fatalf("CSV source membership activation escaped late stock rollback: called=%t error=%v", called, importFixtureError(err))
	}
}
func TestImportMembershipActivate(t *testing.T) {
	if os.Getenv("POS_CSV_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("isolated bridge only")
	}
	db := importApplicationBridgeDB(t)
	var group sync.WaitGroup
	var created atomic.Int32
	failures := make(chan error, 20)
	ctx := importContext(t, importMembershipCapability(t, db))
	for index := 0; index < 20; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			result, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, 5001, false) })
			if err != nil {
				failures <- err
			} else if result.Created {
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
	if created.Load() != 1 || contract != poscheckout.MembershipContract || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 19 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts WHERE kind='confirmation'`) != 1 {
		t.Fatal("CSV original source activation was not exactly once")
	}
	if strings.HasSuffix(os.Getenv("POS_CSV_MEMBERSHIP_KIND"), "upgrade") {
		var expiry string
		if err := db.QueryRow(`SELECT value FROM user_eav WHERE attribute='EXCLUSIVE_EXPIRY'`).Scan(&expiry); err != nil {
			t.Fatal(err)
		}
		if expiry != "2032-01-01T00:00:00.000000" {
			t.Fatal("literal source double-extension changed")
		}
	}
}
func TestImportMembershipShopifyRemainsPending(t *testing.T) {
	if os.Getenv("POS_CSV_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("isolated bridge only")
	}
	db := importApplicationBridgeDB(t)
	before := snapshot(t, db, []string{"user_eav", "orders", "product_store", "pos_rewrite_cancellation_membership_provenance"})
	called := false
	_, err := importFixtureConfirm(importContext(t, importMembershipCapability(t, db)), db, 5001, poscheckout.DefaultHashes, func(_ *sql.Tx) error { called = true; return nil })
	if err == nil || called || !reflect.DeepEqual(before, snapshot(t, db, []string{"user_eav", "orders", "product_store", "pos_rewrite_cancellation_membership_provenance"})) {
		t.Fatal("Shopify pending import gained ordinary paid activation")
	}
}
func TestImportMembershipMissingDescriptor(t *testing.T) {
	if os.Getenv("POS_CSV_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("isolated bridge only")
	}
	db := importApplicationBridgeDB(t)
	execute(t, db, `UPDATE pos_rewrite_import_financial_source_receipts SET proof_hash=REPEAT('0',64) WHERE kind='membership'`)
	before := snapshot(t, db, []string{"user_eav", "orders", "product_store", "pos_rewrite_cancellation_membership_provenance"})
	called := false
	_, err := importFixtureConfirm(importContext(t, importMembershipCapability(t, db)), db, 5001, poscheckout.DefaultHashes, func(_ *sql.Tx) error { called = true; return nil })
	if err == nil || called || !reflect.DeepEqual(before, snapshot(t, db, []string{"user_eav", "orders", "product_store", "pos_rewrite_cancellation_membership_provenance"})) {
		t.Fatal("Changed descriptor reached source activation")
	}
}

func TestImportMembershipExternalWriter(t *testing.T) {
	if os.Getenv("POS_CSV_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("isolated bridge only")
	}
	db := importApplicationBridgeDB(t)
	// The exact EAV value is restored. Native all-writer revisions still prove
	// another write occurred; equality cannot manufacture original provenance.
	execute(t, db, `UPDATE user_eav SET value='2' WHERE attribute='EXCLUSIVE_MEMBER'`)
	execute(t, db, `UPDATE user_eav SET value='1' WHERE attribute='EXCLUSIVE_MEMBER'`)
	before := snapshot(t, db, []string{"user_eav", "orders", "product_store", "pos_rewrite_cancellation_membership_provenance"})
	called := false
	_, err := importFixtureConfirm(importContext(t, importMembershipCapability(t, db)), db, 5001, poscheckout.DefaultHashes, func(_ *sql.Tx) error { called = true; return nil })
	if err == nil || called || !reflect.DeepEqual(before, snapshot(t, db, []string{"user_eav", "orders", "product_store", "pos_rewrite_cancellation_membership_provenance"})) {
		t.Fatal("external membership revision reached source activation")
	}
}
