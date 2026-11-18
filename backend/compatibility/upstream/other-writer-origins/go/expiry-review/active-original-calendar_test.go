package juspay

import (
	"errors"
	"testing"

	"backend-tss-domestic_payments_api/utils"
	"github.com/go-sql-driver/mysql"
	"github.com/jinzhu/gorm"
)

// No parallel tests: the original methods use both their argument and utils.Db.
// The runner binds only their disposable comparison clocks to the fixture date.
func TestOriginActiveOriginalCalendarWallets(t *testing.T) {
	db := originGatewayDB(t)
	orm, err := gorm.Open("mysql", db)
	if err != nil {
		t.Fatal(err)
	}
	orm.LogMode(false)
	var sqlMode string
	if err := db.QueryRow("SELECT @@session.sql_mode").Scan(&sqlMode); err != nil {
		t.Fatal("fixture SQL mode unavailable")
	}
	t.Logf("fixture metadata sql_mode=%s", sqlMode)
	type createFailure struct {
		table  string
		number uint16
	}
	var createFailures []createFailure
	orm.Callback().Create().After("gorm:create").Register("pos:expiry:diagnostic", func(scope *gorm.Scope) {
		if scope.DB().Error == nil {
			return
		}
		table := scope.TableName()
		if table != "tss_money_history" && table != "tss_point_history" && table != "reward_point_history" {
			t.Error("unexpected fixture create-error table")
			return
		}
		var driverError *mysql.MySQLError
		if !errors.As(scope.DB().Error, &driverError) {
			t.Error("fixture create error did not expose a typed MySQL code")
			return
		}
		createFailures = append(createFailures, createFailure{table: table, number: driverError.Number})
	})
	t.Cleanup(func() { orm.Callback().Create().Remove("pos:expiry:diagnostic") })
	originalDB := utils.Db
	utils.Db = orm
	t.Cleanup(func() { utils.Db = originalDB })
	cases := []struct {
		expiry string
		credit bool
	}{
		{"2026-12-01", true},
		{"2026-10-20", false},
		{"2026-11-18", true},
		{"2026-11-17", false},
		{"2027-01-01", true},
	}
	for _, asset := range []string{"money", "points"} {
		for _, entry := range cases {
			t.Run(asset+"/"+entry.expiry, func(t *testing.T) {
				createFailures = nil
				for _, table := range []string{"tss_money_history", "tss_point_history", "reward_point_history", "order_tss_money", "order_tss_point"} {
					if _, err := db.Exec("DROP TABLE IF EXISTS " + table); err != nil {
						t.Fatal(err)
					}
				}
				for _, table := range []string{"tss_money_history", "tss_point_history", "reward_point_history"} {
					if _, err := db.Exec("CREATE TABLE " + table + "(id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id BIGINT,order_id BIGINT,added_amt DOUBLE,used_amt DOUBLE,amt_before_update DOUBLE,amt_after_update DOUBLE,comment TEXT,platform VARCHAR(64),added_user BIGINT,expiry DATETIME NULL,created_at DATETIME NULL,updated_at DATETIME NULL,is_expired INT DEFAULT 0,game_category_id BIGINT)"); err != nil {
						t.Fatal(err)
					}
				}
				for _, table := range []string{"order_tss_money", "order_tss_point"} {
					column := "tss_money_id"
					if table == "order_tss_point" {
						column = "tss_point_id"
					}
					if _, err := db.Exec("CREATE TABLE " + table + "(id BIGINT AUTO_INCREMENT PRIMARY KEY," + column + " BIGINT,order_id BIGINT,used_amount DOUBLE,created_at DATETIME NULL,updated_at DATETIME NULL)"); err != nil {
						t.Fatal(err)
					}
				}
				if asset == "money" && entry.expiry == "2026-12-01" {
					rows, err := db.Query("SELECT table_name,is_nullable,data_type FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tss_money_history','tss_point_history','reward_point_history') AND column_name='expiry' ORDER BY table_name")
					if err != nil {
						t.Fatal("fixture expiry metadata unavailable")
					}
					for rows.Next() {
						var table, nullable, kind string
						if err := rows.Scan(&table, &nullable, &kind); err != nil {
							t.Fatal("fixture expiry metadata unreadable")
						}
						t.Logf("fixture expiry metadata table=%s nullable=%s type=%s", table, nullable, kind)
					}
					if err := rows.Close(); err != nil {
						t.Fatal("fixture expiry metadata close failed")
					}
				}
				if _, err := db.Exec("UPDATE users SET tss_money=100,tss_points=100,cashback=7 WHERE id=77"); err != nil {
					t.Fatal(err)
				}
				history, mapping, column := "tss_money_history", "order_tss_money", "tss_money_id"
				if asset == "points" {
					history, mapping, column = "tss_point_history", "order_tss_point", "tss_point_id"
				}
				if _, err := db.Exec("INSERT INTO "+history+"(id,user_id,order_id,added_amt,used_amt,amt_before_update,amt_after_update,platform,expiry,is_expired) VALUES(1,77,1,100,10,0,100,'ORDER_MONEY',?,0)", entry.expiry+" 00:00:00"); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Exec("INSERT INTO " + mapping + "(" + column + ",order_id,used_amount) VALUES(1,700,10)"); err != nil {
					t.Fatal(err)
				}
				order := Order{ID: 700, User: 77}
				if asset == "money" {
					order.RevertTssMoney(orm)
				} else {
					order.RevertTssPoints(orm)
				}
				for _, failure := range createFailures {
					t.Logf("fixture create failure table=%s mysql_error_number=%d", failure.table, failure.number)
				}
				expected, delta, platform, expired := float64(100), float64(-10), "TSS_MONEY_EXPIRED", 1
				if asset == "points" {
					platform = "TSS_POINTS_EXPIRED"
				}
				if entry.credit {
					expected, delta, platform, expired = 110, 10, "PAYMENT_FAILED", 0
				}
				var money, points, cashback float64
				if err := db.QueryRow("SELECT tss_money,tss_points,cashback FROM users WHERE id=77").Scan(&money, &points, &cashback); err != nil {
					t.Fatal(err)
				}
				expectedMoney, expectedPoints := float64(100), float64(100)
				if asset == "money" {
					expectedMoney = expected
				} else {
					expectedPoints = expected
				}
				if money != expectedMoney || points != expectedPoints || cashback != 7 {
					t.Fatal("original method must preserve independent wallet and cashback")
				}
				var gotDelta, before, after float64
				var gotPlatform string
				var gotExpired, count int
				if err := db.QueryRow("SELECT added_amt,amt_before_update,amt_after_update,platform,is_expired FROM "+history+" WHERE order_id=700").Scan(&gotDelta, &before, &after, &gotPlatform, &gotExpired); err != nil {
					t.Fatal(err)
				}
				if gotDelta != delta || before != 100 || after != expected || gotPlatform != platform || gotExpired != expired {
					t.Fatal("original method ledger contract differs")
				}
				if err := db.QueryRow("SELECT COUNT(*) FROM " + history + " WHERE order_id=700").Scan(&count); err != nil || count != 1 {
					t.Fatal("original restoration ledger is missing or duplicated", err)
				}
				if entry.credit {
					var retainedExpiry string
					if err := db.QueryRow("SELECT DATE_FORMAT(expiry,'%Y-%m-%d') FROM " + history + " WHERE order_id=700").Scan(&retainedExpiry); err != nil || retainedExpiry != entry.expiry {
						t.Fatal("restored earning expiry changed", err)
					}
				}
				if err := db.QueryRow("SELECT COUNT(*) FROM " + mapping + " WHERE " + column + "=1 AND order_id=700 AND used_amount=10").Scan(&count); err != nil || count != 1 {
					t.Fatal("original debit mapping changed", err)
				}
				if err := db.QueryRow("SELECT COUNT(*) FROM "+history+" WHERE id=1 AND used_amt=10 AND is_expired=0 AND DATE_FORMAT(expiry,'%Y-%m-%d')=?", entry.expiry).Scan(&count); err != nil || count != 1 {
					t.Fatal("original earning changed", err)
				}
				if asset == "money" {
					// Retain the original source mirror as a separate financial-
					// acceptance item; generated Money intentionally has no mirror.
					var mirrorDelta, mirrorBefore, mirrorAfter float64
					var mirrorPlatform string
					if err := db.QueryRow("SELECT added_amt,amt_before_update,amt_after_update,platform FROM reward_point_history WHERE order_id=700").Scan(&mirrorDelta, &mirrorBefore, &mirrorAfter, &mirrorPlatform); err != nil {
						t.Fatal(err)
					}
					expectedMirror := "CASHBACK_EXPIRED"
					if entry.credit {
						expectedMirror = "PAYMENT_FAILED"
					}
					if mirrorDelta != delta || mirrorBefore != 100 || mirrorAfter != expected || mirrorPlatform != expectedMirror {
						t.Fatal("retained original reward-history mirror differs")
					}
					if err := db.QueryRow("SELECT COUNT(*) FROM reward_point_history WHERE order_id=700").Scan(&count); err != nil || count != 1 {
						t.Fatal("original reward mirror missing or duplicated", err)
					}
				} else if err := db.QueryRow("SELECT COUNT(*) FROM reward_point_history").Scan(&count); err != nil || count != 0 {
					t.Fatal("Points restoration manufactured a reward mirror", err)
				}
			})
		}
	}
}
