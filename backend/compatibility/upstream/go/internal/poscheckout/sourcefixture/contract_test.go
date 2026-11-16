package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/go-sql-driver/mysql"
	"github.com/jinzhu/gorm"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

//go:embed customer_consent_migration.sql
var customerConsentMigration string

//go:embed membership_migration.sql
var membershipMigration string

//go:embed membership_fence.sql
var membershipFence string

const consentFixtureKey = "fixture-customer-consent-key-0123456789"

func execute(t *testing.T, db *sql.DB, query string, args ...interface{}) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
func number(t *testing.T, db *sql.DB, query string) float64 {
	t.Helper()
	var value float64
	if err := db.QueryRow(query).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
func fixture(t *testing.T) *sql.DB {
	t.Helper()
	if os.Getenv("POS_MEMBERSHIP_PRODUCT_IDS") == "" {
		t.Setenv("POS_MEMBERSHIP_PRODUCT_IDS", "[]")
	}
	t.Setenv("POS_MEMBERSHIP_PROOF_KEY", "fixture-independent-membership-key-0123456789")
	t.Setenv("POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT", poscheckout.MembershipFenceContract)
	raw := os.Getenv("POS_CHECKOUT_MYSQL_DSN")
	if raw == "" {
		t.Skip("ordinary/run-isolated-tests.sh supplies isolated MySQL")
	}
	options, err := mysql.ParseDSN(raw)
	if err != nil || options.Net != "tcp" || options.Addr != "mysql:3306" || options.DBName != "pos_checkout_contract_test" {
		t.Fatal("refusing non-isolated checkout database")
	}
	db, err := sql.Open("mysql", raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	orm, err := gorm.Open("mysql", db)
	if err != nil {
		t.Fatal(err)
	}
	orm.LogMode(false)
	for _, model := range []interface{}{&Order{}, &OrderStore{}, &User{}, &RewardPointHistory{}, &TssMoneyHistory{}, &OrderTssMoney{}, &TssPointHistory{}, &OrderTssPoint{}, &GiftVoucher{}, &GiftVoucherHistory{}, &OrderCouponLog{}, &HasProduct{}, &Product{}, &ProductStore{}, &UserEAV{}, &Comment{}} {
		scope := orm.NewScope(model)
		table := scope.TableName()
		if _, ok := model.(*ProductStore); ok {
			table = "product_store"
		}
		execute(t, db, "DROP TABLE IF EXISTS `"+table+"`")
		var columns, primary []string
		for _, field := range scope.GetModelStruct().StructFields {
			if !field.IsNormal {
				continue
			}
			name := field.DBName
			kind := field.Struct.Type.Kind()
			sqlType := "BIGINT"
			switch kind {
			case reflect.String:
				sqlType = "VARCHAR(255)"
			case reflect.Float32, reflect.Float64:
				sqlType = "DOUBLE"
			case reflect.Struct:
				if field.Struct.Type == reflect.TypeOf(time.Time{}) {
					sqlType = "DATETIME"
				} else {
					t.Fatal("unsupported source fixture field")
				}
			}
			if table == "orders" && (name == "cashback_used" || name == "tss_money_used" || name == "tss_points_used") {
				sqlType = "FLOAT"
			}
			definition := "`" + name + "` " + sqlType + " NULL"
			if field.IsPrimaryKey {
				primary = append(primary, "`"+name+"`")
				definition = "`" + name + "` " + sqlType + " NOT NULL"
				if kind >= reflect.Int && kind <= reflect.Uint64 {
					definition += " AUTO_INCREMENT"
				}
			}
			columns = append(columns, definition)
		}
		if len(primary) > 0 {
			columns = append(columns, "PRIMARY KEY ("+strings.Join(primary, ",")+")")
		}
		execute(t, db, "CREATE TABLE `"+table+"` ("+strings.Join(columns, ",")+") ENGINE=InnoDB")
	}
	for _, statement := range []string{
		`ALTER TABLE users ADD status INT NOT NULL,ADD is_block TINYINT NULL,ADD is_disabled TINYINT NULL,MODIFY email VARCHAR(96) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,ADD INDEX fixture_user_email(email)`,
		`ALTER TABLE user_eav MODIFY is_active INT NULL,MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,MODIFY updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`,
		`DROP TABLE IF EXISTS pos_rewrite_cancellation_membership_provenance`, `DROP TABLE IF EXISTS pos_rewrite_membership_versions`,
		`DROP TABLE IF EXISTS coupons`, `CREATE TABLE coupons(id BIGINT PRIMARY KEY,is_employee_coupon INT NOT NULL DEFAULT 0) ENGINE=InnoDB`, `INSERT INTO coupons VALUES(7,0),(8,1)`,
		`DROP TABLE IF EXISTS pos_rewrite_customer_contact_revisions`, `CREATE TABLE pos_rewrite_customer_contact_revisions(customer_id VARCHAR(32) PRIMARY KEY,revision BIGINT UNSIGNED NOT NULL DEFAULT 0) ENGINE=InnoDB`,
		`DROP TABLE IF EXISTS pos_rewrite_checkout_customer_consents`,
		`ALTER TABLE gift_vouchers ADD collection_no BIGINT NOT NULL DEFAULT 0,ADD gift_card_srno BIGINT NOT NULL DEFAULT 0,ADD start_date DATETIME NOT NULL DEFAULT '2026-11-16 00:00:00',ADD end_date DATETIME NOT NULL DEFAULT '2027-02-14 00:00:00',MODIFY from_id BIGINT NOT NULL DEFAULT 77`,
		`DROP TABLE IF EXISTS gift_card_collection`, `CREATE TABLE gift_card_collection(id BIGINT PRIMARY KEY,size INT NOT NULL,is_completed TINYINT NOT NULL,is_block TINYINT NOT NULL,is_printed TINYINT NOT NULL) ENGINE=InnoDB`,
		`DROP TABLE IF EXISTS pos_rewrite_gift_card_issuances`, `CREATE TABLE pos_rewrite_gift_card_issuances(voucher_id BIGINT PRIMARY KEY,order_id BIGINT NOT NULL,collection_id BIGINT NOT NULL,serial BIGINT NOT NULL,input_hash CHAR(64) NOT NULL,contract_version VARCHAR(40) NOT NULL,activated_at DATETIME NOT NULL,INDEX(order_id,voucher_id)) ENGINE=InnoDB`,
		`ALTER TABLE order_stores ADD counter_id BIGINT NOT NULL DEFAULT 3,ADD INDEX(order_id)`,
		`CREATE INDEX fixture_hp_order ON has_products(order_id)`,
		`CREATE INDEX fixture_stock_store_product ON product_store(store_id,product_id)`,
		`DROP TABLE IF EXISTS coupons_users`, `CREATE TABLE coupons_users(c_id BIGINT,user_id BIGINT,coupon_used_count BIGINT) ENGINE=InnoDB`,
		`DROP TABLE IF EXISTS referral_log`, `CREATE TABLE referral_log(referred_to BIGINT,order_count BIGINT,order_id BIGINT) ENGINE=InnoDB`,
		`DROP TABLE IF EXISTS pos_rewrite_checkout_projection_lines`, `DROP TABLE IF EXISTS pos_rewrite_checkout_projections`,
		`DROP TABLE IF EXISTS pos_rewrite_checkout_projection_effects`,
		`CREATE TABLE pos_rewrite_checkout_projection_effects(id VARCHAR(96) PRIMARY KEY,order_id BIGINT NOT NULL,user_id BIGINT NOT NULL,operator_id BIGINT NULL,resource VARCHAR(48) NOT NULL,payload JSON NOT NULL,status VARCHAR(16) NOT NULL,request_id VARCHAR(128),created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL,INDEX(status,created_at,id)) ENGINE=InnoDB`,
		`CREATE TABLE pos_rewrite_checkout_projections(order_id BIGINT PRIMARY KEY,store_id BIGINT NOT NULL,counter_id BIGINT NOT NULL,user_id BIGINT NOT NULL,input_hash CHAR(64) NOT NULL,line_count INT NOT NULL,contract_version VARCHAR(40) NOT NULL,confirmed_at DATETIME NOT NULL) ENGINE=InnoDB`,
		`CREATE TABLE pos_rewrite_checkout_projection_lines(order_id BIGINT NOT NULL,has_product_id BIGINT NOT NULL,product_id BIGINT NOT NULL,quantity BIGINT NOT NULL,input_hash CHAR(64) NOT NULL,PRIMARY KEY(order_id,has_product_id)) ENGINE=InnoDB`,
		`INSERT INTO users(id,email,tss_money,tss_points,cashback,status,is_block) VALUES(77,'fixture@example.test',100,100,10,1,NULL)`,
		`INSERT INTO products(id) VALUES(10),(11)`,
		`INSERT INTO product_store(id,store_id,product_id,stock,is_avail,is_del) VALUES(1,1,10,20,1,0),(2,1,11,20,1,0)`,
		`INSERT INTO referral_log VALUES(77,0,0)`,
	} {
		execute(t, db, statement)
	}
	for _, statement := range strings.Split(customerConsentMigration, ";") {
		if strings.TrimSpace(statement) != "" {
			execute(t, db, statement)
		}
	}
	for _, statement := range strings.Split(membershipMigration, ";") {
		if strings.TrimSpace(statement) != "" {
			execute(t, db, statement)
		}
	}
	for _, statement := range strings.Split(strings.ReplaceAll(strings.ReplaceAll(membershipFence, "DELIMITER $$", ""), "DELIMITER ;", ""), "$$") {
		if strings.TrimSpace(statement) != "" {
			execute(t, db, statement)
		}
	}
	return db
}
func seedOrder(t *testing.T, db *sql.DB, id, method int, money, points float32) {
	t.Helper()
	payable := 100
	if method == 3 {
		payable = 0
	}
	execute(t, db, `INSERT INTO orders(id,user_id,payment_method,payment_status,order_status,cashback_used,tss_money_used,tss_points_used,voucher_used,voucher_amt_used,coupon_used,coupon_amt_used,parent_order_id,original_order_id,hl_parent_order_id,location_id,pay_amt) VALUES(?,77,?,0,0,0,?,?,0,0,0,0,0,0,0,0,?)`, id, method, money, points, payable)
	execute(t, db, `INSERT INTO order_stores(order_id,store_id,counter_id) VALUES(?,1,3)`, id)
	execute(t, db, `INSERT INTO has_products(id,order_id,prod_id,qty,price,status) VALUES(?,?,10,2,12.34,'INCOMPLETE')`, id+1000, id)
}
func confirm(db *sql.DB, id int) (poscheckout.Confirmation, error) {
	ctx, err := consentContext(db, id)
	if err != nil {
		return poscheckout.Confirmation{}, err
	}
	return poscheckout.Confirm(ctx, db, int64(id), poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, id, false) })
}
func consentValue(db *sql.DB, id int) (poscheckout.CustomerConsent, error) {
	var order, user, store, counter, digest, revision string
	err := db.QueryRow(`SELECT CAST(orders.id AS CHAR),CAST(orders.user_id AS CHAR),CAST(order_stores.store_id AS CHAR),CAST(order_stores.counter_id AS CHAR),`+poscheckout.CustomerContactDigestSQL+` FROM orders JOIN users ON users.id=orders.user_id JOIN order_stores ON order_stores.order_id=orders.id WHERE orders.id=?`, id).Scan(&order, &user, &store, &counter, &digest)
	if err != nil {
		return poscheckout.CustomerConsent{}, err
	}
	err = db.QueryRow(`SELECT CAST(revision AS CHAR) FROM pos_rewrite_customer_contact_revisions WHERE customer_id=?`, user).Scan(&revision)
	if err == sql.ErrNoRows {
		revision = "0"
		err = nil
	}
	return poscheckout.CustomerConsent{V: 1, Contract: poscheckout.CustomerConsentContract, OrderID: order, CustomerID: user, OperatorID: "44", StoreID: store, CounterID: counter, Contact: poscheckout.ContactBinding{Revision: revision, Digest: digest}, ExpiresAt: time.Now().Add(8 * time.Minute).UnixMilli()}, err
}
func signedConsent(value poscheckout.CustomerConsent, key string) string {
	body, _ := json.Marshal(value)
	encoded := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(poscheckout.CustomerConsentContract + "\n" + encoded))
	return encoded + "." + hex.EncodeToString(mac.Sum(nil))
}
func consentContext(db *sql.DB, id int) (context.Context, error) {
	value, err := consentValue(db, id)
	if err != nil {
		return nil, err
	}
	return poscheckout.WithCustomerConsent(context.Background(), signedConsent(value, consentFixtureKey), consentFixtureKey, "44", time.Now())
}
func seedWalletCredit(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, table := range []string{"tss_money_history", "tss_point_history"} {
		execute(t, db, "INSERT INTO "+table+"(user_id,added_amt,used_amt,is_expired,platform,created_at) VALUES(77,100,0,0,'GENERAL','2026-01-01')")
	}
}

type querier interface {
	Query(string, ...interface{}) (*sql.Rows, error)
}

func snapshot(t *testing.T, db querier, tables []string) map[string][]string {
	t.Helper()
	result := map[string][]string{}
	for _, table := range tables {
		rows, err := db.Query("SELECT * FROM `" + table + "`")
		if err != nil {
			t.Fatal(err)
		}
		names, _ := rows.Columns()
		for rows.Next() {
			values := make([]interface{}, len(names))
			pointers := make([]interface{}, len(names))
			for index := range values {
				pointers[index] = &values[index]
			}
			if err = rows.Scan(pointers...); err != nil {
				t.Fatal(err)
			}
			var pieces []string
			for index, name := range names {
				if name == "id" || strings.HasSuffix(name, "_at") || name == "expiry" {
					continue
				}
				pieces = append(pieces, name+"="+fmt.Sprint(values[index]))
			}
			result[table] = append(result[table], strings.Join(pieces, "|"))
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		sort.Strings(result[table])
	}
	return result
}
func TestSourceWalletFIFOAndRoundingParity(t *testing.T) {
	for _, value := range []float32{0, 0.01, 2.675, 12.335, 17.555, 75.50} {
		t.Run(fmt.Sprint(value), func(t *testing.T) {
			db := fixture(t)
			seedOrder(t, db, 5001, 14, value, value)
			orm, _ := gorm.Open("mysql", db)
			orm.LogMode(false)
			moneyTable := orm.NewScope(&TssMoneyHistory{}).TableName()
			pointsTable := orm.NewScope(&TssPointHistory{}).TableName()
			for _, table := range []string{moneyTable, pointsTable} {
				execute(t, db, "INSERT INTO `"+table+"`(id,user_id,added_amt,used_amt,is_expired,platform,created_at) VALUES(1,77,10,0,0,'FIRST_ORDER_RETURN_BONUS','2026-01-01'),(2,77,100,20,0,'GENERAL','2026-01-02')")
			}
			tables := []string{"users", moneyTable, pointsTable, orm.NewScope(&OrderTssMoney{}).TableName(), orm.NewScope(&OrderTssPoint{}).TableName(), "product_store"}
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			if err = sourceApply(tx, 5001, true); err != nil {
				t.Fatal(err)
			}
			before := snapshot(t, tx, tables)
			tx.Rollback()
			result, err := confirm(db, 5001)
			if err != nil {
				t.Fatal(err)
			}
			if !result.Created {
				t.Fatal("expected fresh projection")
			}
			if after := snapshot(t, db, tables); !reflect.DeepEqual(before, after) {
				t.Fatalf("source allocation changed: source=%v patched=%v", before, after)
			}
		})
	}
}
func TestConcurrentSameOrderAndProofReplay(t *testing.T) {
	db := fixture(t)
	seedOrder(t, db, 5001, 14, 0, 0)
	var created atomic.Int32
	var group sync.WaitGroup
	failures := make(chan error, 20)
	for index := 0; index < 20; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			value, err := confirm(db, 5001)
			if err != nil {
				failures <- err
				return
			}
			if value.Created {
				created.Add(1)
			}
		}()
	}
	group.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if created.Load() != 1 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 18 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 1 {
		t.Fatal("replay repeated stock or proof")
	}
}
func TestRollbackAfterWalletAndStockSQLFailure(t *testing.T) {
	db := fixture(t)
	seedWalletCredit(t, db)
	seedOrder(t, db, 5001, 14, 10, 0)
	execute(t, db, `CREATE TRIGGER fixture_reject_stock BEFORE UPDATE ON product_store FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture stock rejection'`)
	if _, err := confirm(db, 5001); err == nil || !strings.Contains(err.Error(), "fixture stock rejection") {
		t.Fatalf("expected injected stock-stage failure: %v", err)
	}
	if number(t, db, `SELECT tss_money FROM users WHERE id=77`) != 100 || number(t, db, `SELECT order_status FROM orders WHERE id=5001`) != 0 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 {
		t.Fatal("failed projection committed partial work")
	}
}
func TestShortageAndCashbackRejectBeforeAnyMutation(t *testing.T) {
	for _, changed := range []string{`UPDATE product_store SET stock=1 WHERE id=1`, `UPDATE users SET tss_money=1 WHERE id=77`, `UPDATE orders SET cashback_used=1 WHERE id=5001`} {
		t.Run(changed, func(t *testing.T) {
			db := fixture(t)
			seedOrder(t, db, 5001, 14, 10, 0)
			execute(t, db, changed)
			var called bool
			_, err := poscheckout.Confirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
			if err == nil || called {
				t.Fatal("invalid input reached source mutations")
			}
			if number(t, db, `SELECT order_status FROM orders WHERE id=5001`) != 0 {
				t.Fatal("rejection changed order")
			}
		})
	}
}
func TestFreshCustomerEligibilityBeforeMutationAndProofReplay(t *testing.T) {
	for _, changed := range []string{`UPDATE users SET status=0 WHERE id=77`, `UPDATE users SET is_block=1 WHERE id=77`, `UPDATE users SET is_block=2 WHERE id=77`, `UPDATE users SET is_disabled=1 WHERE id=77`, `UPDATE users SET is_disabled=2 WHERE id=77`} {
		t.Run(changed, func(t *testing.T) {
			db := fixture(t)
			seedWalletCredit(t, db)
			seedOrder(t, db, 5001, 14, 10, 0)
			execute(t, db, changed)
			called := false
			_, err := poscheckout.Confirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
			if err == nil || called || number(t, db, `SELECT tss_money FROM users WHERE id=77`) != 100 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 {
				t.Fatal("ineligible customer reached a financial mutation")
			}
		})
	}
	db := fixture(t)
	seedWalletCredit(t, db)
	seedOrder(t, db, 5001, 14, 10, 0)
	// The fixture's actual nullable is_block=NULL is a clear flag, not a scan failure.
	if _, err := confirm(db, 5001); err != nil {
		t.Fatal(err)
	}
	execute(t, db, `UPDATE users SET is_block=1 WHERE id=77`)
	if _, err := confirm(db, 5001); err == nil {
		t.Fatal("blocked customer replay accepted cached authorization")
	}
	if number(t, db, `SELECT tss_money FROM users WHERE id=77`) != 90 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 1 {
		t.Fatal("blocked replay changed original money or proof")
	}
	execute(t, db, `UPDATE users SET is_block=0 WHERE id=77`)
	if result, err := confirm(db, 5001); err != nil || result.Created {
		t.Fatal("clear customer did not recover original proof")
	}
}
func TestLegacyPaidAndMutatedProofRequireReview(t *testing.T) {
	db := fixture(t)
	seedOrder(t, db, 5001, 14, 0, 0)
	execute(t, db, `UPDATE orders SET payment_status=4,order_status=3 WHERE id=5001`)
	if _, err := confirm(db, 5001); err == nil {
		t.Fatal("legacy paid status synthesized proof")
	}
	execute(t, db, `UPDATE orders SET payment_status=0,order_status=0 WHERE id=5001`)
	if _, err := confirm(db, 5001); err != nil {
		t.Fatal(err)
	}
	execute(t, db, `UPDATE has_products SET price=99 WHERE order_id=5001`)
	if _, err := confirm(db, 5001); err == nil {
		t.Fatal("mutated line accepted old proof")
	}
}
func TestProofInsertionFailureRollsBackCompletedSourceProjection(t *testing.T) {
	db := fixture(t)
	seedWalletCredit(t, db)
	seedOrder(t, db, 5001, 14, 10, 0)
	execute(t, db, `CREATE TRIGGER fixture_reject_proof BEFORE INSERT ON pos_rewrite_checkout_projections FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture proof rejection'`)
	ctx, err := consentContext(db, 5001)
	if err != nil {
		t.Fatal(err)
	}
	_, err = poscheckout.Confirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error {
		if err := sourceApply(tx, 5001, false); err != nil {
			return err
		}
		return poscheckout.EnqueueEffect(context.Background(), tx, poscheckout.Effect{OrderID: 5001, UserID: 77, Resource: "order-engagement", RequestID: "fixture-request"})
	})
	if err == nil || !strings.Contains(err.Error(), "fixture proof rejection") {
		t.Fatalf("expected proof-stage SQL failure: %v", err)
	}
	for query, want := range map[string]float64{`SELECT stock FROM product_store WHERE id=1`: 20, `SELECT tss_money FROM users WHERE id=77`: 100, `SELECT order_status FROM orders WHERE id=5001`: 0, `SELECT COUNT(*) FROM pos_rewrite_checkout_projection_lines`: 0, `SELECT COUNT(*) FROM pos_rewrite_checkout_projection_effects`: 0} {
		if got := number(t, db, query); got != want {
			t.Fatalf("proof failure leaked mutation: got %v want %v", got, want)
		}
	}
}
func TestConcurrentDifferentOrdersCannotOverspendWalletOrStock(t *testing.T) {
	for _, scarcity := range []string{`UPDATE users SET tss_money=15 WHERE id=77`, `UPDATE product_store SET stock=3 WHERE id=1`} {
		t.Run(scarcity, func(t *testing.T) {
			db := fixture(t)
			seedWalletCredit(t, db)
			seedOrder(t, db, 5001, 14, 10, 0)
			seedOrder(t, db, 5002, 14, 10, 0)
			execute(t, db, scarcity)
			var group sync.WaitGroup
			var wins atomic.Int32
			for _, id := range []int{5001, 5002} {
				group.Add(1)
				go func(id int) {
					defer group.Done()
					if _, err := confirm(db, id); err == nil {
						wins.Add(1)
					}
				}(id)
			}
			group.Wait()
			if wins.Load() != 1 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 1 {
				t.Fatal("competing scarce allocation was committed more than once")
			}
			if number(t, db, `SELECT tss_money FROM users WHERE id=77`) < 0 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) < 0 {
				t.Fatal("negative balance committed")
			}
		})
	}
}
func TestPostcommitEffectsAreClaimedOnceAndUnknownDeliveryIsFrozen(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{5001, 5002} {
		effect := poscheckout.Effect{OrderID: id, UserID: 77, Resource: "order-engagement", RequestID: "fixture-request"}
		if err = poscheckout.EnqueueEffect(ctx, tx, effect); err != nil {
			t.Fatal(err)
		}
		if err = poscheckout.EnqueueEffect(ctx, tx, effect); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var calls sync.Map
	handlers := map[string]poscheckout.Handler{"order-engagement": func(_ context.Context, effect poscheckout.Effect) error {
		if _, loaded := calls.LoadOrStore(effect.ID, true); loaded {
			t.Error("duplicate external delivery")
		}
		if effect.OrderID == 5002 {
			return fmt.Errorf("private socket details must never be logged")
		}
		return nil
	}}
	var group sync.WaitGroup
	for index := 0; index < 2; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := poscheckout.Dispatch(ctx, db, handlers, 100, nil); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	if err = poscheckout.Dispatch(ctx, db, handlers, 100, nil); err != nil {
		t.Fatal(err)
	}
	if number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projection_effects WHERE status='delivered'`) != 1 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projection_effects WHERE status='uncertain'`) != 1 {
		t.Fatal("delivery states were not retained")
	}
}
func TestIncompleteLegacyWalletHistoryDoesNotReceiveProjectionProof(t *testing.T) {
	db := fixture(t)
	seedOrder(t, db, 5001, 14, 10, 0)
	// The source arithmetic succeeds but cannot trace the debit to an earning.
	// The oracle has only the approved nullable-expiry representation shim.
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = sourceApply(tx, 5001, true); err != nil {
		t.Fatal(err)
	}
	var balance float64
	var allocated int
	if err = tx.QueryRow(`SELECT tss_money FROM users WHERE id=77`).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if err = tx.QueryRow(`SELECT COUNT(*) FROM order_tss_money WHERE order_id=5001`).Scan(&allocated); err != nil {
		t.Fatal(err)
	}
	if balance != 90 || allocated != 0 {
		t.Fatal("source missing-history evidence changed")
	}
	tx.Rollback()
	if _, err = confirm(db, 5001); err == nil {
		t.Fatal("incomplete history was certified")
	}
	for query, want := range map[string]float64{`SELECT tss_money FROM users WHERE id=77`: 100, `SELECT stock FROM product_store WHERE id=1`: 20, `SELECT order_status FROM orders WHERE id=5001`: 0, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`: 0, `SELECT COUNT(*) FROM tss_money_history WHERE added_amt<0`: 0} {
		if number(t, db, query) != want {
			t.Fatal("incomplete wallet projection was partially committed")
		}
	}
}
func TestPrepaidPaymentStockAndPurchasedGiftActivationCommitWithProof(t *testing.T) {
	db := fixture(t)
	seedOrder(t, db, 5001, 3, 0, 0)
	seedPhysicalCard(t, db, 5001)
	result, err := confirm(db, 5001)
	if err != nil || !result.Created {
		t.Fatal(err)
	}
	for query, want := range map[string]float64{`SELECT payment_status FROM orders WHERE id=5001`: 4, `SELECT order_status FROM orders WHERE id=5001`: 3, `SELECT status FROM gift_vouchers WHERE id=9001`: 1, `SELECT stock FROM product_store WHERE id=1`: 18, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`: 1} {
		if number(t, db, query) != want {
			t.Fatal("prepaid projection was not committed atomically")
		}
	}
}
func TestPendingCOCPurchasedGiftRemainsDisabled(t *testing.T) {
	db := fixture(t)
	seedOrder(t, db, 5001, 14, 0, 0)
	seedPhysicalCard(t, db, 5001)
	if _, err := confirm(db, 5001); err != nil {
		t.Fatal(err)
	}
	if number(t, db, `SELECT status FROM gift_vouchers WHERE id=9001`) != 0 || number(t, db, `SELECT payment_status FROM orders WHERE id=5001`) != 1 {
		t.Fatal("unpaid purchased card was activated")
	}
}
func TestActualHTTPAdapterKeyProofReplayAndQueuedActorContext(t *testing.T) {
	db := fixture(t)
	seedWalletCredit(t, db)
	seedOrder(t, db, 5001, 14, 10, 0)
	orm, err := gorm.Open("mysql", db)
	if err != nil {
		t.Fatal(err)
	}
	orm.LogMode(false)
	fixtureAdapterDB = orm
	t.Cleanup(func() { fixtureAdapterDB = nil })
	key := strings.Repeat("fixture-private-pos-key", 2)
	t.Setenv("POS_CHECKOUT_PROJECTION_KEY", key)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(poscheckout.PrivateHTTP(os.Getenv, nil))
	router.POST("/confirm", func(ctx *gin.Context) { tryConfirmPOSCheckout(ctx, &Order{ID: 5001, User: 77, PaymentMethod: 14}) })
	value, err := consentValue(db, 5001)
	if err != nil {
		t.Fatal(err)
	}
	proof := signedConsent(value, key)
	send := func(secret, consent string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "/confirm", nil)
		request.Header.Set("X-POS-Projection-Key", secret)
		request.Header.Set("X-Request-ID", "http-fixture-request")
		request.Header.Set("X-POS-Operator-ID", "44")
		request.Header.Set("X-POS-Customer-Consent", consent)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	if response := send("wrong", proof); response.Code != 401 {
		t.Fatal("missing app authorization was accepted")
	}
	if response := send(key, "invalid-consent"); response.Code != 503 {
		t.Fatal("invalid customer consent was accepted")
	}
	if number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 {
		t.Fatal("unauthorized request mutated source state")
	}
	for index := 0; index < 2; index++ {
		response := send(key, proof)
		if response.Code != 201 || !strings.Contains(response.Body.String(), `"message":"/thank-you"`) {
			t.Fatalf("source success response changed: %d %s", response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), key) {
			t.Fatal("private app key exposed")
		}
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 18 {
		t.Fatal("HTTP replay deducted stock again")
	}
	if number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projection_effects WHERE operator_id=44 AND request_id='http-fixture-request'`) != 6 {
		t.Fatal("source postcommit jobs lost their initiating context or replayed")
	}
}

func TestSourceCallbackEntryUsesProofForConcurrentStaleOrders(t *testing.T) {
	db := fixture(t)
	seedOrder(t, db, 5001, 14, 0, 0)
	orm, err := gorm.Open("mysql", db)
	if err != nil {
		t.Fatal(err)
	}
	orm.LogMode(false)
	var failed atomic.Int32
	var group sync.WaitGroup
	for index := 0; index < 20; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			stale := &Order{ID: 5001, User: 77, PaymentMethod: 14}
			if handled, confirmed := tryConfirmPOSCheckoutInternal(stale, orm); !handled || !confirmed {
				failed.Add(1)
			}
		}()
	}
	group.Wait()
	if failed.Load() != 0 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 18 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projection_effects`) != 6 {
		t.Fatal("source callback replay bypassed the serialized projection")
	}
	seedOrder(t, db, 5002, 14, 0, 0)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tx.Rollback() })
	nested, err := gorm.Open("mysql", tx)
	if err != nil {
		t.Fatal(err)
	}
	nested.LogMode(false)
	if handled, confirmed := tryConfirmPOSCheckoutInternal(&Order{ID: 5002, User: 77, PaymentMethod: 14}, nested); !handled || confirmed {
		t.Fatal("source callback committed a transaction it did not own")
	}
}

func TestSourceGiftCouponMembershipAndDonationAllocationParity(t *testing.T) {
	for _, method := range []int{14, 3} {
		t.Run(fmt.Sprint(method), func(t *testing.T) {
			db := fixture(t)
			seedOrder(t, db, 5001, method, 0, 0)
			t.Setenv("EXCLUSIVE_PRODUCT_ID", "10")
			t.Setenv("POS_MEMBERSHIP_PRODUCT_IDS", `["10"]`)
			t.Setenv("SAVE_THE_SOUL_PRODUCT_ID", "11")
			execute(t, db, `INSERT INTO has_products(id,order_id,prod_id,qty,price,status) VALUES(6002,5001,11,3,12.345,'INCOMPLETE')`)
			execute(t, db, `INSERT INTO gift_vouchers(id,order_id,status,gv_type,voucher_value) VALUES(99,'4000',1,'GIFT_CARD',100)`)
			execute(t, db, `UPDATE orders SET voucher_used=99,voucher_amt_used=12.335,coupon_used=7,coupon_amt_used=10 WHERE id=5001`)
			execute(t, db, `INSERT INTO coupons_users VALUES(7,77,1)`)
			seedMembershipStage(t, db, 5001)
			tables := []string{"users", "gift_vouchers", "gift_voucher_history", "coupons_users", "order_coupon_log", "user_eav", "tss_point_history", "product_store", "has_products", "orders"}
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			if err = sourceApply(tx, 5001, true); err != nil {
				t.Fatal(err)
			}
			before := snapshot(t, tx, tables)
			tx.Rollback()
			if _, err = confirm(db, 5001); err != nil {
				t.Fatal(err)
			}
			if after := snapshot(t, db, tables); !reflect.DeepEqual(before, after) {
				t.Fatalf("source benefit allocation changed: source=%v patched=%v", before, after)
			}
			if number(t, db, `SELECT tss_points FROM users WHERE id=77`) > 113 {
				t.Fatal("source donation price was incorrectly multiplied by quantity")
			}
		})
	}
}

func TestMutationAndPanicInsideSourceCallbackRollBack(t *testing.T) {
	for _, change := range []string{"price", "panic"} {
		t.Run(change, func(t *testing.T) {
			db := fixture(t)
			seedOrder(t, db, 5001, 14, 0, 0)
			_, err := poscheckout.Confirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error {
				if err := sourceApply(tx, 5001, false); err != nil {
					return err
				}
				if change == "panic" {
					panic("fixture source failure")
				}
				_, err := tx.Exec(`UPDATE has_products SET price=99 WHERE order_id=5001`)
				return err
			})
			if err == nil || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 || number(t, db, `SELECT order_status FROM orders WHERE id=5001`) != 0 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 {
				t.Fatal("invalid source callback committed a partial projection")
			}
		})
	}
}
