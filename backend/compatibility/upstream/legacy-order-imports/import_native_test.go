package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const importAuthKey = "fixture-independent-private-import-key-0123456789"
const importProofKey = "fixture-independent-private-import-proof-0123456789"
const importOperation = "5a5d1efb-727e-45ea-b214-9136be787031"
const importNonce = "62123802-cf5f-49f1-976c-35cf1282e82b"

func importSourceFixture(t *testing.T, deferHead ...bool) (*sql.DB, map[string]interface{}) {
	db := fixture(t)
	t.Setenv("POS_LEGACY_IMPORT_KEY", importAuthKey)
	t.Setenv("POS_LEGACY_IMPORT_PROOF_KEY", importProofKey)
	t.Setenv("POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT", poscheckout.LegacyImportContract)
	for _, query := range []string{
		`DROP TABLE IF EXISTS pos_rewrite_import_financial_source_receipts`,
		`DROP TABLE IF EXISTS pos_rewrite_import_financial_operations`,
		`DROP TABLE IF EXISTS pos_rewrite_import_financial_stages`,
		`DROP TABLE IF EXISTS pos_rewrite_import_financial_order_bindings`,
		`DROP TABLE IF EXISTS pos_rewrite_import_financial_proofs`,
		`CREATE TABLE pos_rewrite_import_financial_source_receipts(id VARCHAR(80) PRIMARY KEY,operation_id VARCHAR(36),kind VARCHAR(16),request_hash VARCHAR(64),status VARCHAR(16),proof JSON,proof_hash VARCHAR(64),created_at_ms BIGINT,UNIQUE(operation_id,kind)) ENGINE=InnoDB`,
		`CREATE TABLE pos_rewrite_import_financial_operations(id VARCHAR(36) PRIMARY KEY,actor_id VARCHAR(32),store_id VARCHAR(32),counter_id VARCHAR(32),request_hash VARCHAR(64),plan_hash VARCHAR(64),namespace VARCHAR(80),state JSON) ENGINE=InnoDB`,
		`CREATE TABLE pos_rewrite_import_financial_stages(operation_id VARCHAR(36),kind VARCHAR(16),nonce VARCHAR(36),status VARCHAR(16),PRIMARY KEY(operation_id,kind)) ENGINE=InnoDB`,
		`CREATE TABLE pos_rewrite_import_financial_order_bindings(order_id VARCHAR(32) PRIMARY KEY,operation_id VARCHAR(36),request_hash VARCHAR(64),status VARCHAR(16)) ENGINE=InnoDB`,
		`CREATE TABLE pos_rewrite_import_financial_proofs(operation_id VARCHAR(36) PRIMARY KEY,order_id VARCHAR(32),request_hash VARCHAR(64),data JSON,proof_hash VARCHAR(64)) ENGINE=InnoDB`,
		`DROP TABLE IF EXISTS pos_user`,
		`CREATE TABLE pos_user(id BIGINT PRIMARY KEY,username VARCHAR(150),password VARCHAR(128),email VARCHAR(254),is_mfa TINYINT,mfa_hash VARCHAR(255),phone VARCHAR(10),contact_email VARCHAR(254),otp_method INT,role INT,user_type INT,is_staff TINYINT,is_superuser TINYINT,is_active TINYINT) ENGINE=InnoDB`,
		`INSERT INTO pos_user VALUES(44,'fixture-import','fixture-password',NULL,0,NULL,NULL,NULL,0,1,1,1,0,1)`,
		`DROP TABLE IF EXISTS pos_rewrite_operator_auth_epochs`,
		`CREATE TABLE pos_rewrite_operator_auth_epochs(operator_id VARCHAR(32) PRIMARY KEY,epoch BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB`,
		`DROP TABLE IF EXISTS stores`, `CREATE TABLE stores(id BIGINT PRIMARY KEY,is_active TINYINT,type VARCHAR(32)) ENGINE=InnoDB`,
		`INSERT INTO stores VALUES(1,1,'STORE')`,
		`DROP TABLE IF EXISTS store_counters`, `CREATE TABLE store_counters(id BIGINT PRIMARY KEY,store_id BIGINT,is_active TINYINT) ENGINE=InnoDB`,
		`INSERT INTO store_counters VALUES(3,1,1)`,
		`DROP TABLE IF EXISTS user_stores`, `CREATE TABLE user_stores(id BIGINT PRIMARY KEY,django_user_id BIGINT,store_id BIGINT) ENGINE=InnoDB`,
		`ALTER TABLE orders ADD currency VARCHAR(55) NULL,ADD currency_conv_rate VARCHAR(45) NULL,ADD fraction_value FLOAT NULL`,
	} {
		execute(t, db, query)
	}
	installImportAuthorityMigration(t, db)
	seedOrder(t, db, 5001, 14, 0, 0)
	execute(t, db, `UPDATE orders SET created_at='2026-06-15 12:00:00',currency='INR',currency_conv_rate='0',fraction_value=0 WHERE id=5001`)
	raw, _ := json.Marshal([]interface{}{"fixture-import", nil, "fixture-password", false, nil, nil, nil, 0, 1, 1, true, false})
	base := sha256.Sum256(raw)
	version := sha256.Sum256([]byte(hex.EncodeToString(base[:]) + ":0"))
	var contact string
	if err := db.QueryRow(`SELECT ` + poscheckout.CustomerContactDigestSQL + ` FROM users WHERE id=77`).Scan(&contact); err != nil {
		t.Fatal(err)
	}
	authority := map[string]interface{}{"customerId": "77", "actorVersion": hex.EncodeToString(version[:]), "actorEpoch": "0",
		"approvalId": nil, "close": nil, "contact": map[string]interface{}{"revision": "0", "digest": contact}}
	scope := map[string]interface{}{"actorId": "44", "operationId": importOperation, "storeId": "1", "counterId": "3"}
	body, _ := json.Marshal(map[string]interface{}{"scope": scope, "authority": authority, "status": "running"})
	execute(t, db, `INSERT INTO pos_rewrite_import_financial_operations VALUES(?,'44','1','3',?,?,?,?)`, importOperation, strings.Repeat("a", 64), strings.Repeat("b", 64), "pos-import-v1:"+importOperation, body)
	execute(t, db, `INSERT INTO pos_rewrite_import_financial_stages VALUES(?,'confirmation',?,'dispatched')`, importOperation, importNonce)
	execute(t, db, `INSERT INTO pos_rewrite_import_financial_order_bindings VALUES('5001',?,?,'held')`, importOperation, strings.Repeat("a", 64))
	if len(deferHead) == 0 {
		installImportNativeHead(t, db)
	}
	now := time.Now().UnixMilli()
	return db, map[string]interface{}{"contract": "pos-legacy-order-import-source-v1", "phase": "confirmation",
		"operationId": importOperation, "requestHash": strings.Repeat("a", 64), "planHash": strings.Repeat("b", 64),
		"namespace": "pos-import-v1:" + importOperation, "planDigest": strings.Repeat("c", 64), "scope": scope,
		"authority": authority, "orderId": "5001", "nonce": importNonce, "issuedAt": now, "expiresAt": now + 60000}
}
func signedImport(value map[string]interface{}) string {
	raw, _ := json.Marshal(struct {
		Kind  string      `json:"kind"`
		Input interface{} `json:"input"`
	}{"legacy-order-imports.source.capability.v1", value})
	mac := hmac.New(sha256.New, []byte(importAuthKey))
	mac.Write(raw)
	copy := map[string]interface{}{}
	for key, item := range value {
		copy[key] = item
	}
	copy["signature"] = hex.EncodeToString(mac.Sum(nil))
	encoded, _ := json.Marshal(copy)
	return base64.RawURLEncoding.EncodeToString(encoded)
}
func importContext(t *testing.T, value map[string]interface{}) context.Context {
	t.Helper()
	ctx, err := poscheckout.WithLegacyImport(context.Background(), signedImport(value), importAuthKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return ctx
}
func TestImportActualSourceConfirmationAndNativeReceipt(t *testing.T) {
	db, value := importSourceFixture(t)
	ctx := importContext(t, value)
	result, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, 5001, false) })
	if err != nil || !result.Created {
		t.Fatalf("native import source confirmation rejected: %v", err)
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 18 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts WHERE kind='confirmation'`) != 1 {
		t.Fatal("missing native atomic import receipt")
	}
	result, err = importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { t.Fatal("source replay mutated"); return nil })
	if err != nil || result.Created || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 18 {
		t.Fatal("source replay did not preserve original effect")
	}
}
func TestImportScopeAndFreshAuthorityFencesBeforeSource(t *testing.T) {
	for _, change := range []string{"no-capability", "nonce", "plan", "namespace", "scope", "operator", "actor-epoch", "actor-role", "franchise", "inactive", "counter", "contact", "revision"} {
		t.Run(change, func(t *testing.T) {
			db, value := importSourceFixture(t)
			ctx := importContext(t, value)
			switch change {
			case "no-capability":
				ctx = context.Background()
			case "nonce":
				value["nonce"] = "e89b3bdd-9311-4939-982e-e0befbd88adf"
				ctx = importContext(t, value)
			case "plan":
				execute(t, db, `UPDATE pos_rewrite_import_financial_operations SET plan_hash=?`, strings.Repeat("d", 64))
			case "namespace":
				execute(t, db, `UPDATE pos_rewrite_import_financial_operations SET namespace='different'`)
			case "scope":
				execute(t, db, `UPDATE pos_rewrite_import_financial_operations SET state=JSON_SET(state,'$.scope.counterId','4')`)
			case "operator":
				execute(t, db, `UPDATE pos_user SET password='changed' WHERE id=44`)
			case "actor-epoch":
				execute(t, db, `INSERT INTO pos_rewrite_operator_auth_epochs VALUES('44',1)`)
			case "actor-role":
				execute(t, db, `UPDATE pos_user SET role=5 WHERE id=44`)
			case "franchise":
				execute(t, db, `UPDATE pos_user SET user_type=2 WHERE id=44`)
			case "inactive":
				execute(t, db, `UPDATE pos_user SET is_active=0 WHERE id=44`)
			case "counter":
				execute(t, db, `UPDATE store_counters SET is_active=0 WHERE id=3`)
			case "contact":
				execute(t, db, `UPDATE users SET email='changed@example.test' WHERE id=77`)
			case "revision":
				execute(t, db, `INSERT INTO pos_rewrite_customer_contact_revisions VALUES('77',9007199254740993)`)
			}
			called := false
			_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
			if err == nil || called || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 {
				t.Fatal("stale import authority reached financial source")
			}
		})
	}
}
func TestImportProofInsertFailureRollsBackOriginalSource(t *testing.T) {
	db, value := importSourceFixture(t)
	execute(t, db, `CREATE TRIGGER import_receipt_failure BEFORE INSERT ON pos_rewrite_import_financial_source_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated late proof failure'`)
	_, err := importFixtureConfirm(importContext(t, value), db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, 5001, false) })
	if err == nil || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 || number(t, db, `SELECT order_status FROM orders WHERE id=5001`) != 0 {
		t.Fatal("late import proof failed outside original source transaction")
	}
}

func TestImportCapabilityExpiryAfterNativeLockWait(t *testing.T) {
	db, value := importSourceFixture(t)
	value["expiresAt"] = time.Now().Add(150 * time.Millisecond).UnixMilli()
	ctx := importContext(t, value)
	blocked, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = blocked.Exec(`SELECT id FROM orders WHERE id=5001 FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	called := false
	go func() {
		_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
		result <- err
	}()
	time.Sleep(250 * time.Millisecond)
	if err = blocked.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = <-result; err == nil || called || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 {
		t.Fatal("expired queued capability reached source allocation")
	}
}

func TestImportEffectsRequireSealedCompletionBeforeDispatch(t *testing.T) {
	db, _ := importSourceFixture(t)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = poscheckout.EnqueueEffect(context.Background(), tx, poscheckout.Effect{OrderID: 5001, UserID: 77, Resource: "inventory-sync"}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	called := false
	handlers := map[string]poscheckout.Handler{"inventory-sync": func(context.Context, poscheckout.Effect) error { called = true; return nil }}
	if err = poscheckout.Dispatch(context.Background(), db, handlers, 1, nil); err != nil {
		t.Fatalf("held import effect query failed: %v", err)
	}
	if called {
		t.Fatal("held import effect dispatched")
	}
	execute(t, db, `UPDATE pos_rewrite_import_financial_order_bindings SET status='completed'`)
	if err = poscheckout.Dispatch(context.Background(), db, handlers, 1, nil); err == nil || called {
		t.Fatal("unsealed completed label authorized an effect")
	}
	if number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projection_effects WHERE status='pending'`) != 1 {
		t.Fatal("refusal destroyed the original effect")
	}
}
