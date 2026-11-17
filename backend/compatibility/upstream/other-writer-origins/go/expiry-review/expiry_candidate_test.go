package juspay

// Review-only fixture: source predicates are tested in a disposable copy with
// their clock replaced by this fixture clock. The active producer is unchanged.
import (
	"fmt"
	"github.com/jinzhu/gorm"
	"os"
	"testing"
	"time"
)

func originExpiryFixtureNow() time.Time { return time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC) }
func TestOriginExpiryReviewNativeWallets(t *testing.T) {
	db := originGatewayDB(t)
	orm, err := gorm.Open("mysql", db)
	if err != nil {
		t.Fatal(err)
	}
	orm.LogMode(false)
	cases := []struct {
		expiry             string
		original, calendar bool
	}{{"2026-12-01", false, true}, {"2026-10-20", true, false}, {"2026-11-18", true, true}, {"2026-11-17", false, false}, {"2027-01-01", true, true}}
	for _, asset := range []string{"money", "points"} {
		for _, entry := range cases {
			t.Run(asset+"/"+entry.expiry, func(t *testing.T) {
				for _, table := range []string{"tss_money_history", "tss_point_history", "order_tss_money", "order_tss_point"} {
					if _, err = db.Exec("DROP TABLE IF EXISTS " + table); err != nil {
						t.Fatal(err)
					}
				}
				for _, table := range []string{"tss_money_history", "tss_point_history"} {
					if _, err = db.Exec("CREATE TABLE " + table + "(id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id BIGINT,order_id BIGINT,added_amt DOUBLE,used_amt DOUBLE,amt_before_update DOUBLE,amt_after_update DOUBLE,comment TEXT,platform VARCHAR(64),added_user BIGINT,expiry DATETIME NULL,created_at DATETIME NULL,updated_at DATETIME NULL,is_expired INT DEFAULT 0,game_category_id BIGINT)"); err != nil {
						t.Fatal(err)
					}
				}
				for _, table := range []string{"order_tss_money", "order_tss_point"} {
					column := "tss_money_id"
					if table == "order_tss_point" {
						column = "tss_point_id"
					}
					if _, err = db.Exec("CREATE TABLE " + table + "(id BIGINT AUTO_INCREMENT PRIMARY KEY," + column + " BIGINT,order_id BIGINT,used_amount DOUBLE,created_at DATETIME NULL,updated_at DATETIME NULL)"); err != nil {
						t.Fatal(err)
					}
				}
				if _, err = db.Exec(`UPDATE users SET tss_money=100,tss_points=100,cashback=7 WHERE id=77`); err != nil {
					t.Fatal(err)
				}
				history, mapping, column, balance := "tss_money_history", "order_tss_money", "tss_money_id", "tss_money"
				if asset == "points" {
					history, mapping, column, balance = "tss_point_history", "order_tss_point", "tss_point_id", "tss_points"
				}
				if _, err = db.Exec("INSERT INTO "+history+"(id,user_id,order_id,added_amt,used_amt,amt_before_update,amt_after_update,platform,expiry,is_expired) VALUES(1,77,1,100,10,0,100,'ORDER_MONEY',?,0)", entry.expiry+" 00:00:00"); err != nil {
					t.Fatal(err)
				}
				if _, err = db.Exec("INSERT INTO " + mapping + "(" + column + ",order_id,used_amount) VALUES(1,700,10)"); err != nil {
					t.Fatal(err)
				}
				order := Order{ID: 700, User: 77}
				if asset == "money" {
					err = order.revertOtherOriginMoney(orm)
				} else {
					err = order.revertOtherOriginPoints(orm)
				}
				if err != nil {
					t.Fatal(err)
				}
				credited := entry.original
				if os.Getenv("POS_ORIGIN_EXPIRY_CANDIDATE") == "1" {
					credited = entry.calendar
				}
				expectedBalance, expectedDelta := float64(100), float64(-10)
				expectedPlatform := "TSS_MONEY_EXPIRED"
				if asset == "points" {
					expectedPlatform = "TSS_POINTS_EXPIRED"
				}
				if credited {
					expectedBalance, expectedDelta, expectedPlatform = 110, 10, "PAYMENT_FAILED"
				}
				var current, cashback, delta float64
				var platform string
				if err = db.QueryRow("SELECT "+balance+",cashback FROM users WHERE id=77").Scan(&current, &cashback); err != nil {
					t.Fatal(err)
				}
				if err = db.QueryRow("SELECT added_amt,platform FROM "+history+" WHERE order_id=700 ORDER BY id").Scan(&delta, &platform); err != nil {
					t.Fatal(err)
				}
				if current != expectedBalance || delta != expectedDelta || platform != expectedPlatform || cashback != 7 {
					t.Fatalf("%s", fmt.Sprintf("balance=%v delta=%v platform=%s cashback=%v expected=%v/%v/%s", current, delta, platform, cashback, expectedBalance, expectedDelta, expectedPlatform))
				}
				t.Logf("expiry=%s wallet=%v ledger=%v/%s cashback=%v candidate=%v", entry.expiry, current, delta, platform, cashback, os.Getenv("POS_ORIGIN_EXPIRY_CANDIDATE") == "1")
			})
		}
	}
}
