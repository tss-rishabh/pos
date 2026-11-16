package posstock

import (
	"context"
	"database/sql"
	"os"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/go-sql-driver/mysql"
)

func fixture(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv("POS_STOCK_MYSQL_DSN")
	if raw == "" {
		t.Skip("run-isolated-tests.sh supplies the isolated MySQL container")
	}
	options, err := mysql.ParseDSN(raw)
	if err != nil || options.Net != "tcp" || options.Addr != "mysql:3306" || options.DBName != "pos_exchange_contract_test" {
		t.Fatal("refusing non-isolated database configuration")
	}
	db, err := sql.Open("mysql", raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	statements := []string{
		`DROP TABLE IF EXISTS pos_rewrite_exchange_stock_confirmations`, `DROP TABLE IF EXISTS return_orders`, `DROP TABLE IF EXISTS product_store`, `DROP TABLE IF EXISTS order_stores`, `DROP TABLE IF EXISTS exchange_order_log`, `DROP TABLE IF EXISTS has_products`, `DROP TABLE IF EXISTS orders`,
		`CREATE TABLE orders(id BIGINT PRIMARY KEY,parent_order_id BIGINT NOT NULL,user_id BIGINT NOT NULL,payment_method BIGINT NOT NULL,pay_amt DOUBLE NOT NULL,payment_status BIGINT NOT NULL,order_status BIGINT NOT NULL) ENGINE=InnoDB`,
		`CREATE TABLE has_products(id BIGINT PRIMARY KEY,order_id BIGINT NOT NULL,prod_id BIGINT NOT NULL,qty BIGINT NOT NULL,status VARCHAR(40) NOT NULL,INDEX(order_id)) ENGINE=InnoDB`,
		`CREATE TABLE exchange_order_log(id BIGINT PRIMARY KEY,parent_order_id BIGINT NOT NULL,parent_has_product_id BIGINT NOT NULL,order_id BIGINT NOT NULL,has_product_id BIGINT NOT NULL,INDEX(order_id)) ENGINE=InnoDB`,
		`CREATE TABLE order_stores(id BIGINT PRIMARY KEY,order_id BIGINT NOT NULL,store_id BIGINT NOT NULL,counter_id BIGINT NOT NULL,INDEX(order_id)) ENGINE=InnoDB`,
		`CREATE TABLE product_store(id BIGINT PRIMARY KEY,store_id BIGINT NOT NULL,product_id BIGINT NOT NULL,stock BIGINT NOT NULL,is_avail BOOLEAN NOT NULL,is_del BOOLEAN NOT NULL,INDEX(store_id,product_id)) ENGINE=InnoDB`,
		`CREATE TABLE return_orders(id BIGINT PRIMARY KEY,order_id BIGINT NOT NULL,has_product_id BIGINT NOT NULL,prod_id BIGINT NOT NULL,store_id BIGINT NOT NULL,credit_note_no VARCHAR(100) NOT NULL) ENGINE=InnoDB`,
		`CREATE TABLE pos_rewrite_exchange_stock_confirmations(order_id BIGINT PRIMARY KEY,parent_order_id BIGINT NOT NULL,parent_has_product_id BIGINT NOT NULL,has_product_id BIGINT NOT NULL,store_id BIGINT NOT NULL,counter_id BIGINT NOT NULL,product_id BIGINT NOT NULL,quantity BIGINT NOT NULL,contract_version VARCHAR(40) NOT NULL,confirmed_at DATETIME NOT NULL) ENGINE=InnoDB`,
		`INSERT INTO orders VALUES(9001,0,77,14,100,4,3),(9002,9001,77,3,0,0,0)`,
		`INSERT INTO has_products VALUES(9101,9001,10,2,'EXCHANGE_INITIATED'),(9102,9002,11,2,'INCOMPLETE')`,
		`INSERT INTO exchange_order_log VALUES(1,9001,9101,9002,9102)`,
		`INSERT INTO order_stores VALUES(1,9002,1,3)`,
		`INSERT INTO product_store VALUES(1,1,11,10,1,0)`,
		`INSERT INTO return_orders VALUES(1,9001,9101,10,1,'FIXTURE-CREDIT-NOTE')`,
	}
	for _, statement := range statements {
		if _, err = db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	return db
}
func number(t *testing.T, db *sql.DB, query string) int64 {
	t.Helper()
	var value int64
	if err := db.QueryRow(query).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
func execute(t *testing.T, db *sql.DB, query string) {
	t.Helper()
	if _, err := db.Exec(query); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentReplayCommitsOneDecrementAndOneProof(t *testing.T) {
	db := fixture(t)
	var created atomic.Int64
	var group sync.WaitGroup
	for index := 0; index < 20; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			result, err := Confirm(context.Background(), db, 9002)
			if err != nil {
				t.Error(err)
				return
			}
			if result.Created {
				created.Add(1)
			}
		}()
	}
	group.Wait()
	if created.Load() != 1 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 8 || number(t, db, `SELECT payment_status FROM orders WHERE id=9002`) != 4 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_exchange_stock_confirmations`) != 1 {
		t.Fatal("confirmation was not atomic and idempotent")
	}
}
func TestSQLFailureRollsBackStockLinePaymentAndProof(t *testing.T) {
	db := fixture(t)
	execute(t, db, `CREATE TRIGGER reject_confirmation BEFORE INSERT ON pos_rewrite_exchange_stock_confirmations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated injected SQL failure'`)
	if _, err := Confirm(context.Background(), db, 9002); err == nil {
		t.Fatal("SQL failure reported success")
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 10 || number(t, db, `SELECT payment_status FROM orders WHERE id=9002`) != 0 || number(t, db, `SELECT order_status FROM orders WHERE id=9002`) != 0 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_exchange_stock_confirmations`) != 0 {
		t.Fatal("transaction partially committed")
	}
	var status string
	if err := db.QueryRow(`SELECT status FROM has_products WHERE id=9102`).Scan(&status); err != nil || status != "INCOMPLETE" {
		t.Fatal("line placement escaped rollback")
	}
}
func TestInsufficientStockRefusesConfirmation(t *testing.T) {
	db := fixture(t)
	execute(t, db, `UPDATE product_store SET stock=1`)
	if _, err := Confirm(context.Background(), db, 9002); err == nil {
		t.Fatal("oversold")
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 1 || number(t, db, `SELECT payment_status FROM orders WHERE id=9002`) != 0 {
		t.Fatal("changed unconfirmed sale")
	}
}
func TestLegacyPaidChildWithoutStockProofRequiresReview(t *testing.T) {
	db := fixture(t)
	execute(t, db, `UPDATE orders SET payment_status=4,order_status=1 WHERE id=9002`)
	if _, err := Confirm(context.Background(), db, 9002); err == nil {
		t.Fatal("invented stock proof")
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 10 {
		t.Fatal("double decrement risk")
	}
}
func TestWrongCustomerAndDuplicateRelationRefuseConfirmation(t *testing.T) {
	for _, statement := range []string{`UPDATE orders SET user_id=78 WHERE id=9002`, `INSERT INTO exchange_order_log VALUES(2,9001,9101,9002,9102)`, `INSERT INTO has_products VALUES(9103,9002,12,1,'INCOMPLETE')`} {
		t.Run(statement, func(t *testing.T) {
			db := fixture(t)
			execute(t, db, statement)
			if _, err := Confirm(context.Background(), db, 9002); err == nil {
				t.Fatal("accepted conflicting child")
			}
			if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 10 {
				t.Fatal("changed stock")
			}
		})
	}
}
func TestConflictingProofNeverReplays(t *testing.T) {
	db := fixture(t)
	if _, err := Confirm(context.Background(), db, 9002); err != nil {
		t.Fatal(err)
	}
	execute(t, db, `UPDATE pos_rewrite_exchange_stock_confirmations SET counter_id=4`)
	if _, err := Confirm(context.Background(), db, 9002); err == nil {
		t.Fatal("accepted wrong counter proof")
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 8 {
		t.Fatal("repeated stock transition")
	}
}
func TestDeliveredProofReplayDoesNotRunStockAgain(t *testing.T) {
	db := fixture(t)
	if _, err := Confirm(context.Background(), db, 9002); err != nil {
		t.Fatal(err)
	}
	execute(t, db, `UPDATE orders SET order_status=3 WHERE id=9002`)
	result, err := Confirm(context.Background(), db, 9002)
	if err != nil || result.Created {
		t.Fatal("delivered replay was not recognized")
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 8 {
		t.Fatal("repeated stock transition")
	}
}
func TestConcurrentDifferentChildrenCannotFundTheSameReturnTwice(t *testing.T) {
	db := fixture(t)
	execute(t, db, `INSERT INTO orders VALUES(9003,9001,77,3,0,0,0)`)
	execute(t, db, `INSERT INTO has_products VALUES(9103,9003,11,2,'INCOMPLETE')`)
	execute(t, db, `INSERT INTO exchange_order_log VALUES(2,9001,9101,9003,9103)`)
	execute(t, db, `INSERT INTO order_stores VALUES(2,9003,1,3)`)
	var created atomic.Int64
	var group sync.WaitGroup
	for _, id := range []int64{9002, 9003} {
		group.Add(1)
		go func(child int64) {
			defer group.Done()
			result, err := Confirm(context.Background(), db, child)
			if err == nil && result.Created {
				created.Add(1)
			}
		}(id)
	}
	group.Wait()
	if created.Load() != 1 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 8 || number(t, db, `SELECT COUNT(*) FROM orders WHERE parent_order_id=9001 AND payment_status=4`) != 1 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_exchange_stock_confirmations`) != 1 {
		t.Fatal("two children consumed the same accepted return")
	}
}
func TestMissingReceivingStoreCreditNoteRefusesStockProof(t *testing.T) {
	db := fixture(t)
	execute(t, db, `UPDATE return_orders SET store_id=2`)
	if _, err := Confirm(context.Background(), db, 9002); err == nil {
		t.Fatal("accepted a return from another receiving store")
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 10 {
		t.Fatal("stock changed without a receiving-store return")
	}
}
