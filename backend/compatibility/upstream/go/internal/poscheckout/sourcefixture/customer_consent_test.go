package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"
)

func TestCustomerConsentRequiredBeforeEveryBenefitMutation(t *testing.T) {
	for _, mutation := range []string{
		`UPDATE orders SET tss_money_used=10 WHERE id=5001`,
		`UPDATE orders SET tss_points_used=10 WHERE id=5001`,
		`UPDATE orders SET voucher_used=99,voucher_amt_used=10 WHERE id=5001`,
		`UPDATE orders SET coupon_used=8,coupon_amt_used=10 WHERE id=5001`,
	} {
		t.Run(mutation, func(t *testing.T) {
			db := fixture(t)
			seedWalletCredit(t, db)
			seedOrder(t, db, 5001, 14, 0, 0)
			execute(t, db, `INSERT INTO gift_vouchers(id,order_id,status,gv_type,voucher_value) VALUES(99,'4000',1,'GIFT_CARD',100)`)
			execute(t, db, mutation)
			called := false
			_, err := poscheckout.Confirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
			if err == nil || called || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_customer_consents`) != 0 || number(t, db, `SELECT tss_money FROM users WHERE id=77`) != 100 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 {
				t.Fatal("missing customer consent reached a financial mutation")
			}
		})
	}
}

func TestNativeCustomerConsentBindsExactScopeContactRevisionAndExpiry(t *testing.T) {
	for _, change := range []string{"order", "customer", "store", "counter", "email", "telephone", "revision", "expired", "key", "actor"} {
		t.Run(change, func(t *testing.T) {
			db := fixture(t)
			seedWalletCredit(t, db)
			seedOrder(t, db, 5001, 14, 10, 0)
			value, err := consentValue(db, 5001)
			if err != nil {
				t.Fatal(err)
			}
			key, actor := consentFixtureKey, "44"
			switch change {
			case "order":
				value.OrderID = "5002"
			case "customer":
				value.CustomerID = "78"
			case "store":
				value.StoreID = "2"
			case "counter":
				value.CounterID = "4"
			case "email":
				execute(t, db, `UPDATE users SET email='changed@example.test' WHERE id=77`)
			case "telephone":
				execute(t, db, `UPDATE users SET telephone='9000000001' WHERE id=77`)
			case "revision":
				execute(t, db, `INSERT INTO pos_rewrite_customer_contact_revisions VALUES('77',9007199254740993)`)
			case "expired":
				value.ExpiresAt = time.Now().UnixMilli() - 1
			case "key":
				key = strings.Repeat("other-key", 8)
			case "actor":
				actor = "45"
			}
			ctx, _ := poscheckout.WithCustomerConsent(context.Background(), signedConsent(value, key), consentFixtureKey, actor, time.Now())
			called := false
			_, err = poscheckout.Confirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
			if err == nil || called || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_customer_consents`) != 0 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 {
				t.Fatal("mismatched consent reached source mutations")
			}
		})
	}
}

func TestFinalHeaderMutationIncludingEmployeeCouponRollsBackEverything(t *testing.T) {
	for _, mutation := range []string{
		`UPDATE orders SET tss_money_used=1 WHERE id=5001`,
		`UPDATE orders SET tss_points_used=1 WHERE id=5001`,
		`UPDATE orders SET voucher_used=99,voucher_amt_used=1 WHERE id=5001`,
		`UPDATE orders SET coupon_used=8,coupon_amt_used=1 WHERE id=5001`,
		`UPDATE orders SET coupon_amt_used=1 WHERE id=5001`,
		`UPDATE orders SET coupon_used=7 WHERE id=5001`,
	} {
		t.Run(mutation, func(t *testing.T) {
			db := fixture(t)
			seedOrder(t, db, 5001, 14, 0, 0)
			called := false
			_, err := poscheckout.Confirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error {
				called = true
				if err := sourceApply(tx, 5001, false); err != nil {
					return err
				}
				if err := poscheckout.EnqueueEffect(context.Background(), tx, poscheckout.Effect{OrderID: 5001, UserID: 77, Resource: "order-engagement", RequestID: "late-header-fixture"}); err != nil {
					return err
				}
				_, err := tx.Exec(mutation)
				return err
			})
			if err == nil || !called {
				t.Fatal("late financial header mutation was accepted")
			}
			for query, want := range map[string]float64{
				`SELECT stock FROM product_store WHERE id=1`: 20, `SELECT order_status FROM orders WHERE id=5001`: 0,
				`SELECT coupon_used FROM orders WHERE id=5001`: 0, `SELECT coupon_amt_used FROM orders WHERE id=5001`: 0,
				`SELECT COUNT(*) FROM pos_rewrite_checkout_customer_consents`: 0, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`: 0,
				`SELECT COUNT(*) FROM pos_rewrite_checkout_projection_effects`: 0,
			} {
				if number(t, db, query) != want {
					t.Fatal("late mutation left a committed financial effect")
				}
			}
		})
	}
}

func TestCommittedConsentReplayKeepsOriginalEvidenceWithoutNewOTP(t *testing.T) {
	db := fixture(t)
	seedWalletCredit(t, db)
	seedOrder(t, db, 5001, 14, 10, 0)
	execute(t, db, `INSERT INTO pos_rewrite_customer_contact_revisions VALUES('77',9007199254740993)`)
	if _, err := confirm(db, 5001); err != nil {
		t.Fatal(err)
	}
	var revision string
	if err := db.QueryRow(`SELECT CAST(contact_revision AS CHAR) FROM pos_rewrite_checkout_customer_consents WHERE order_id=5001`).Scan(&revision); err != nil || revision != "9007199254740993" {
		t.Fatal("native revision lost precision")
	}
	execute(t, db, `UPDATE users SET email='later@example.test',telephone='9000000001' WHERE id=77`)
	execute(t, db, `UPDATE pos_rewrite_customer_contact_revisions SET revision=revision+1 WHERE customer_id='77'`)
	called := false
	result, err := poscheckout.Confirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
	if err != nil || called || result.Created || number(t, db, `SELECT tss_money FROM users WHERE id=77`) != 90 {
		t.Fatal("committed proof required current contact or repeated a spend")
	}
	execute(t, db, `UPDATE pos_rewrite_checkout_customer_consents SET input_hash=REPEAT('0',64) WHERE order_id=5001`)
	if _, err := confirm(db, 5001); err == nil {
		t.Fatal("tampered committed consent accepted")
	}
}

func TestUncredentialedCallbackCannotStartBenefitConfirmation(t *testing.T) {
	db := fixture(t)
	seedWalletCredit(t, db)
	seedOrder(t, db, 5001, 14, 10, 0)
	if _, err := poscheckout.Confirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, 5001, false) }); err == nil {
		t.Fatal("callback spent benefits without Node consent")
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 {
		t.Fatal("callback changed stock")
	}
	if _, err := confirm(db, 5001); err != nil {
		t.Fatal(err)
	}
	if result, err := poscheckout.Confirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, 5001, false) }); err != nil || result.Created {
		t.Fatal("callback did not recover immutable evidence")
	}
}
