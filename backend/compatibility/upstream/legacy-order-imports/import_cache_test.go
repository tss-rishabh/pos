package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"database/sql"
	"os"
	"reflect"
	"testing"
)

func TestImportCacheOriginalConfirmationReplay(t *testing.T) {
	if os.Getenv("POS_CSV_MEMBERSHIP_BRIDGE") != "1" {
		t.Skip("isolated source cache/Go race only")
	}
	db := importApplicationBridgeDB(t)
	tables := []string{"orders", "has_products", "product_store", "user_eav", "pos_rewrite_membership_versions", "pos_rewrite_cancellation_membership_provenance", "pos_rewrite_checkout_projections", "pos_rewrite_checkout_projection_lines"}
	before := snapshot(t, db, tables)
	result, err := importFixtureConfirm(importContext(t, importMembershipCapability(t, db)), db, 5001, poscheckout.DefaultHashes, func(*sql.Tx) error { t.Fatal("cache race replay reached original allocation"); return nil })
	if err != nil || result.Created || !reflect.DeepEqual(before, snapshot(t, db, tables)) {
		t.Fatalf("cache worker raced immutable original confirmation: %v", err)
	}
}
