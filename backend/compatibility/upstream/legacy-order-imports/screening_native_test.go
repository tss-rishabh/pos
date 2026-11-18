package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func screeningMAC(kind string, value interface{}) string {
	raw, _ := json.Marshal(struct {
		Kind  string      `json:"kind"`
		Input interface{} `json:"input"`
	}{"legacy-order-imports.source." + kind + ".v1", value})
	mac := hmac.New(sha256.New, []byte(importProofKey))
	mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil))
}
func screeningFixture(t *testing.T, private bool, deferHead ...bool) (*sql.DB, context.Context, map[string]interface{}) {
	db, cap := importSourceFixture(t, true)
	t.Setenv("POS_LEGACY_IMPORT_SCREENING_CONTRACT", poscheckout.ImportScreeningContract)
	t.Setenv("POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT", poscheckout.ImportScreeningSchemaContract)
	t.Setenv("POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT", poscheckout.ImportScreeningWriterContract)
	for _, query := range []string{
		`DROP TABLE IF EXISTS spiderman_screening_orders`,
		// Verified physical metadata34b2c65: TIMESTAMP NOT NULL, not the
		// nullable DATETIME declared by the pinned Python model.
		`CREATE TABLE spiderman_screening_orders(id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,order_id BIGINT NOT NULL,has_product_id BIGINT NOT NULL,user_id BIGINT NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_user_id(user_id),INDEX idx_order_id(order_id),INDEX idx_has_product_id(has_product_id)) ENGINE=InnoDB`,
		`DROP TABLE IF EXISTS pos_rewrite_import_screening_reservations`,
		`CREATE TABLE pos_rewrite_import_screening_reservations(operation_id VARCHAR(36) PRIMARY KEY,customer_id VARCHAR(32) NOT NULL,sku VARCHAR(32) NOT NULL,order_id VARCHAR(32) NULL,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,INDEX ix_import_screening_customer(customer_id,sku),UNIQUE KEY uq_import_screening_order(order_id)) ENGINE=InnoDB`,
		`DROP TABLE IF EXISTS pos_rewrite_public_screening_orders`,
		`CREATE TABLE pos_rewrite_public_screening_orders(operation_id VARCHAR(36) PRIMARY KEY,checkout_id VARCHAR(36) NOT NULL,actor_id VARCHAR(32) NOT NULL,customer_id VARCHAR(32) NOT NULL,store_id VARCHAR(32) NOT NULL,counter_id VARCHAR(32) NOT NULL,order_id VARCHAR(32) NOT NULL UNIQUE,request_hash VARCHAR(64) NOT NULL,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL) ENGINE=InnoDB`,
		`DROP TABLE IF EXISTS pos_rewrite_public_screening_abandonments`,
		`CREATE TABLE pos_rewrite_public_screening_abandonments(operation_id VARCHAR(36) PRIMARY KEY,command_id VARCHAR(36) NOT NULL,order_id VARCHAR(32) NOT NULL UNIQUE,actor_id VARCHAR(32) NOT NULL,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL) ENGINE=InnoDB`,
		`INSERT INTO stores VALUES(2,1,'STORE')`,
		`INSERT INTO store_counters VALUES(4,2,1)`,
		`INSERT INTO users(id,email,tss_money,tss_points,cashback,status,is_block) VALUES(78,'second@example.test',100,100,10,1,NULL)`,
		`INSERT INTO products(id) VALUES(390238)`,
		`INSERT INTO product_store(id,store_id,product_id,stock,is_avail,is_del) VALUES(3,1,390238,20,1,0),(4,2,390238,20,1,0)`,
		`UPDATE has_products SET prod_id=390238,qty=1,sub_prod_id=0 WHERE order_id=5001`,
		`INSERT INTO spiderman_screening_orders(id,order_id,has_product_id,user_id) VALUES(101,5001,6001,77)`,
	} {
		execute(t, db, query)
	}
	ctx := context.Background()
	if private {
		ctx = importContext(t, cap)
		proof := map[string]interface{}{"contract": "pos-legacy-order-import-source-v1", "operationId": importOperation, "orderId": "5001", "customerId": "77", "requestHash": strings.Repeat("a", 64)}
		raw, _ := json.Marshal(proof)
		seal := screeningMAC("order", proof)
		execute(t, db, `INSERT INTO pos_rewrite_import_financial_source_receipts VALUES(?,?,'order',?,'completed',?,?,?)`, importOperation+":order", importOperation, strings.Repeat("a", 64), raw, seal, time.Now().UnixMilli())
		state := screeningStateFixture(importOperation, "5001", "77", "1", "3", "BOUND", 1, false)
		state["authorityHash"] = screeningMAC("screening-authority", cap["authority"])
		state["sourceReceiptHash"] = seal
		writeScreeningState(t, db, state)
	} else {
		execute(t, db, `DELETE FROM pos_rewrite_import_financial_order_bindings`)
		execute(t, db, `DELETE FROM pos_rewrite_import_financial_operations`)
		execute(t, db, `DELETE FROM pos_rewrite_import_financial_stages`)
		writePublicCreationFixture(t, db, 5001, false)
	}
	if len(deferHead) == 0 {
		installImportNativeHead(t, db)
	}
	return db, ctx, cap
}
func writePublicCreationFixture(t *testing.T, db *sql.DB, order int, unitMode bool) {
	t.Helper()
	operation := fmt.Sprintf("00000000-0000-4000-9000-%012d", order)
	var customer, store, counter string
	if err := db.QueryRow(`SELECT CAST(o.user_id AS CHAR),CAST(s.store_id AS CHAR),CAST(s.counter_id AS CHAR) FROM orders o JOIN order_stores s ON s.order_id=o.id WHERE o.id=?`, order).Scan(&customer, &store, &counter); err != nil {
		t.Fatal(err)
	}
	var quantity int
	if err := db.QueryRow(`SELECT SUM(qty) FROM has_products WHERE order_id=? AND prod_id=390238`, order).Scan(&quantity); err != nil {
		t.Fatal(err)
	}
	state := screeningStateFixture(operation, fmt.Sprint(order), customer, store, counter, "BOUND", quantity, unitMode)
	lines := []interface{}{}
	markers := []interface{}{}
	result, err := db.Query(`SELECT CAST(id AS CHAR),qty FROM has_products WHERE order_id=? AND prod_id=390238 ORDER BY id`, order)
	if err != nil {
		t.Fatal(err)
	}
	for result.Next() {
		var id string
		var qty int
		result.Scan(&id, &qty)
		lines = append(lines, map[string]interface{}{"id": id, "quantity": qty})
	}
	result.Close()
	result, err = db.Query(`SELECT CAST(id AS CHAR),CAST(has_product_id AS CHAR) FROM spiderman_screening_orders WHERE order_id=? ORDER BY id`, order)
	if err != nil {
		t.Fatal(err)
	}
	for result.Next() {
		var id, line string
		result.Scan(&id, &line)
		markers = append(markers, map[string]interface{}{"id": id, "lineId": line})
	}
	result.Close()
	checkout := "00000000-0000-4000-8000-000000005001"
	proof := map[string]interface{}{"contract": "pos-node-screening-creation-v1", "operationId": operation, "checkoutId": checkout, "checkoutVersion": 2,
		"actorId": "44", "customerId": customer, "storeId": store, "counterId": counter, "requestHash": state["requestHash"], "cartHash": state["catalogHash"],
		"actorVersion": strings.Repeat("a", 64), "actorEpoch": "0", "contact": map[string]interface{}{"revision": "0", "digest": strings.Repeat("b", 64)},
		"source": state["source"], "sourceControllerHash": "d8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18",
		"orderId": fmt.Sprint(order), "method": 14, "lineItemsEnabled": unitMode, "lines": lines, "markers": markers, "effectsHash": strings.Repeat("c", 64), "createdAt": time.Now().UnixMilli()}
	state["kind"] = "pos"
	state["lines"] = lines
	state["markers"] = markers
	state["planHash"] = screeningMAC("public-screening-plan", map[string]interface{}{"checkoutId": checkout, "checkoutVersion": 2, "cartHash": proof["cartHash"]})
	state["authorityHash"] = screeningMAC("public-screening-authority", map[string]interface{}{"actorId": proof["actorId"], "actorVersion": proof["actorVersion"], "actorEpoch": proof["actorEpoch"], "customerId": customer, "contact": proof["contact"], "storeId": store, "counterId": counter})
	seal := screeningMAC("public-screening-creation", proof)
	state["sourceReceiptHash"] = seal
	raw, _ := json.Marshal(proof)
	execute(t, db, `DELETE FROM pos_rewrite_import_screening_reservations WHERE operation_id=?`, operation)
	execute(t, db, `DELETE FROM pos_rewrite_public_screening_orders WHERE operation_id=?`, operation)
	execute(t, db, `INSERT INTO pos_rewrite_public_screening_orders VALUES(?,?,?,?,?,?,?,?,?,?)`, operation, checkout, "44", customer, store, counter, fmt.Sprint(order), state["requestHash"], raw, seal)
	writeScreeningState(t, db, state)
}
func screeningStateFixture(operation, order, customer, store, counter, phase string, quantity int, lineMode bool) map[string]interface{} {
	var orderID interface{}
	lines := []interface{}{}
	markers := []interface{}{}
	var receipt, completed, rejected interface{}
	if order != "" {
		orderID = order
		lines = append(lines, map[string]interface{}{"id": "6001", "quantity": quantity})
		markers = append(markers, map[string]interface{}{"id": "101", "lineId": "6001"})
	}
	if phase == "COUNTED" {
		receipt = strings.Repeat("d", 64)
		completed = strings.Repeat("e", 64)
	}
	if phase == "REJECTED" {
		rejected = strings.Repeat("f", 64)
	}
	markerRows := 1
	if lineMode {
		markerRows = quantity
	}
	return map[string]interface{}{"contract": poscheckout.ImportScreeningContract, "scope": map[string]interface{}{"actorId": "44", "operationId": operation, "storeId": store, "counterId": counter},
		"source":     map[string]interface{}{"apiCommit": "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5", "helperHash": "a3ec2d593ddfb990b6462fe4f71a8c70f5aa7b95a6704ffb4a0566b14e515e46", "controllerHash": "821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad", "modelHash": "d9ee1cd52546e9d8dce0952e901ecba0d58fe1c1b68d95149781131e1553fca5"},
		"customerId": customer, "sku": "390238", "kind": "offline", "planHash": strings.Repeat("b", 64), "requestHash": strings.Repeat("a", 64), "authorityHash": strings.Repeat("c", 64), "catalogHash": strings.Repeat("d", 64),
		"quantity": quantity, "lineItemsEnabled": lineMode, "markerRows": markerRows, "sourceCountBefore": "0", "pendingBefore": 0, "phase": phase, "orderId": orderID, "lines": lines, "markers": markers,
		"sourceReceiptHash": receipt, "completionHash": completed, "rejectionHash": rejected, "version": 1, "createdAt": time.Now().UnixMilli(), "updatedAt": time.Now().UnixMilli()}
}
func writeScreeningState(t *testing.T, db *sql.DB, state map[string]interface{}) {
	t.Helper()
	scope := state["scope"].(map[string]interface{})
	raw, _ := json.Marshal(state)
	execute(t, db, `INSERT INTO pos_rewrite_import_screening_reservations VALUES(?,?,'390238',?,?,?)`, scope["operationId"], state["customerId"], state["orderId"], raw, screeningMAC("screening-state", state))
}
func waitNativeQuery(t *testing.T, db *sql.DB, table string, early ...<-chan error) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		for _, result := range early {
			select {
			case err := <-result:
				t.Fatalf("confirmation returned before expected lock wait: %v", err)
			default:
			}
		}
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks d ON d.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND d.ENGINE=w.ENGINE WHERE d.OBJECT_SCHEMA=DATABASE() AND d.OBJECT_NAME=?`, table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("native fixture did not reach the expected lock wait")
}
func finishWithin(t *testing.T, result <-chan error) {
	t.Helper()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("native writer did not finish without a retry")
	}
}

func TestScreeningActualSourceConfirmationAndBoundReservation(t *testing.T) {
	for _, private := range []bool{false, true} {
		t.Run(fmt.Sprint(private), func(t *testing.T) {
			db, ctx, _ := screeningFixture(t, private)
			before := number(t, db, `SELECT COUNT(*) FROM spiderman_screening_orders`)
			var stateBefore string
			if private {
				if err := db.QueryRow(`SELECT proof_hash FROM pos_rewrite_import_screening_reservations`).Scan(&stateBefore); err != nil {
					t.Fatal(err)
				}
			}
			result, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, 5001, false) })
			if err != nil || !result.Created || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 19 || number(t, db, strings.Replace(poscheckout.ScreeningCountSQL, "?", "77", 1)) != 1 {
				t.Fatalf("screening source confirmation failed: %v", err)
			}
			if number(t, db, `SELECT COUNT(*) FROM spiderman_screening_orders`) != before {
				t.Fatal("confirmation created or removed screening markers")
			}
			if private {
				var phase, seal string
				if err = db.QueryRow(`SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.phase')),proof_hash FROM pos_rewrite_import_screening_reservations`).Scan(&phase, &seal); err != nil {
					t.Fatal(err)
				}
				if phase != "BOUND" || seal != stateBefore {
					t.Fatal("Go released or fabricated final quota completion")
				}
			}
			result, err = importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(*sql.Tx) error { t.Fatal("proof replay reached source"); return nil })
			if err != nil || result.Created || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 19 {
				t.Fatalf("screening immutable replay failed: %v", err)
			}
		})
	}
}

func TestScreeningPublicAbandonmentFencesDelayedConfirmation(t *testing.T) {
	db, ctx, _ := screeningFixture(t, false)
	blocker, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	for _, query := range []string{`SELECT id FROM stores WHERE id=1 FOR UPDATE`, `SELECT id FROM users WHERE id=77 FOR UPDATE`, `SELECT id FROM orders WHERE id=5001 FOR UPDATE`} {
		if _, err = blocker.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	called := false
	result := make(chan error, 1)
	go func() {
		_, e := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
		result <- e
	}()
	waitNativeQuery(t, db, "stores", result)
	operation := "00000000-0000-4000-9000-000000005001"
	if _, err = blocker.Exec(`INSERT INTO pos_rewrite_public_screening_abandonments VALUES(?,?,'5001','44','{}',?)`, operation, "00000000-0000-4000-8000-000000005099", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if err = blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
	case <-time.After(4 * time.Second):
		t.Fatal("delayed confirmation did not finish")
	}
	if !errors.Is(err, poscheckout.ErrReview) || called || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 20 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 {
		t.Fatal("abandoned original nonce reached stock/wallet source")
	}
}

func TestScreeningPublicMissingAndChangedCreationProofRefuse(t *testing.T) {
	for _, change := range []string{"missing", "hash", "scope"} {
		t.Run(change, func(t *testing.T) {
			db, ctx, _ := screeningFixture(t, false)
			switch change {
			case "missing":
				execute(t, db, `DELETE FROM pos_rewrite_public_screening_orders`)
			case "hash":
				execute(t, db, `UPDATE pos_rewrite_public_screening_orders SET proof_hash=?`, strings.Repeat("f", 64))
			case "scope":
				execute(t, db, `UPDATE pos_rewrite_public_screening_orders SET customer_id='78'`)
			}
			called := false
			_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
			if !errors.Is(err, poscheckout.ErrReview) || called || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 20 {
				t.Fatal("unproved public origin reached source")
			}
		})
	}
}

func TestScreeningCountPreservesLiteralSourcePredicates(t *testing.T) {
	// Literal raw-source oracle deliberately includes invalid parent/ownership rows;
	// it runs before installing the operational counter and is not a writer proof.
	db, _, _ := screeningFixture(t, false, true)
	for i, status := range []interface{}{1, 4, 6, 0, 17, nil, 1, 1} {
		order := 7001 + i
		line := 8001 + i
		execute(t, db, `INSERT INTO orders(id,user_id,order_status) VALUES(?,?,?)`, order, 78, status)
		execute(t, db, `INSERT INTO has_products(id,order_id,prod_id,qty) VALUES(?,?,390238,99)`, line, 99999)
		execute(t, db, `INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(?,?,77)`, order, line)
	}
	execute(t, db, `INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(7001,8001,77),(7999,8001,77),(7001,8999,77),(7001,8001,78)`)
	var count int
	if err := db.QueryRow(poscheckout.ScreeningCountSQL, 77).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 6 {
		t.Fatalf("literal source duplicate/status/ownership COUNT changed: %d", count)
	}
}

func TestScreeningTwoUnitRowsAndLiteralQuantityMode(t *testing.T) {
	for _, unitMode := range []bool{false, true} {
		t.Run(fmt.Sprint(unitMode), func(t *testing.T) {
			db, ctx, _ := screeningFixture(t, false, true)
			if unitMode {
				execute(t, db, `INSERT INTO has_products(id,order_id,prod_id,sub_prod_id,qty,price,status) VALUES(6002,5001,390238,0,1,12.34,'INCOMPLETE')`)
				execute(t, db, `INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(5001,6002,77)`)
			} else {
				execute(t, db, `UPDATE has_products SET qty=2 WHERE order_id=5001`)
			}
			writePublicCreationFixture(t, db, 5001, unitMode)
			if !unitMode {
				seedOrder(t, db, 5002, 14, 0, 0)
				execute(t, db, `UPDATE order_stores SET store_id=2,counter_id=4 WHERE order_id=5002`)
				execute(t, db, `UPDATE has_products SET prod_id=390238,sub_prod_id=0,qty=1 WHERE order_id=5002`)
				execute(t, db, `INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(5002,6002,77)`)
				writePublicCreationFixture(t, db, 5002, false)
			}
			installImportNativeHead(t, db)
			_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, 5001, false) })
			if err != nil || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 18 {
				t.Fatalf("literal HP mode source failed: %v", err)
			}
			expected := 1.
			if unitMode {
				expected = 2
			}
			if number(t, db, strings.Replace(poscheckout.ScreeningCountSQL, "?", "77", 1)) != expected {
				t.Fatal("COUNT was replaced by SUM(quantity)")
			}
			if !unitMode {
				_, err = importFixtureConfirm(ctx, db, 5002, poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, 5002, false) })
				if err != nil || number(t, db, strings.Replace(poscheckout.ScreeningCountSQL, "?", "77", 1)) != 2 {
					t.Fatalf("literal later one-row purchase changed: %v", err)
				}
			}
		})
	}
}

func TestScreeningCrossStoreCustomerWaitSeesNewSourceCount(t *testing.T) {
	db, ctx, _ := screeningFixture(t, false)
	writer, releaseWriter := screeningFixtureWriter(t, db, []int64{77}, []int64{7001}, []int64{8001, 8002})
	var err error
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	for _, query := range []string{`SELECT id FROM stores WHERE id=2 FOR UPDATE`, `SELECT id FROM users WHERE id=77 FOR UPDATE`,
		`INSERT INTO orders(id,user_id,order_status) VALUES(7001,77,1)`, `INSERT INTO has_products(id,order_id,prod_id,qty,sub_prod_id) VALUES(8001,7001,390238,1,0),(8002,7001,390238,1,0)`,
		`INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(7001,8001,77),(7001,8002,77)`} {
		if _, err = writer.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	result := make(chan error, 1)
	called := false
	go func() {
		_, e := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
		result <- e
	}()
	waitNativeQuery(t, db, "users", result)
	probe, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	if _, e = probe.Exec(`SELECT id FROM orders WHERE id=5001 FOR UPDATE NOWAIT`); e != nil {
		probe.Rollback()
		t.Fatal("screening acquired Order before global customer", e)
	}
	probe.Rollback()
	if err = releaseWriter(); err != nil {
		t.Fatal(err)
	}
	if err = writer.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
	case <-time.After(4 * time.Second):
		t.Fatal("customer waiter did not finish")
	}
	if err == nil || called || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 20 {
		t.Fatal("stale pre-customer hint hid newly committed source tickets")
	}
}

func TestScreeningTicketAddedAfterUnlockedHintFailsBeforeSource(t *testing.T) {
	db, ctx, _ := screeningFixture(t, false)
	screeningFixtureMutation(t, db, []int64{77}, []int64{5001}, []int64{6001}, `UPDATE has_products SET prod_id=10 WHERE order_id=5001`)
	blocker, releaseBlocker := screeningFixtureWriter(t, db, []int64{77}, []int64{5001}, []int64{6001})
	var err error
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	if _, err = blocker.Exec(`SELECT id FROM orders WHERE id=5001 FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	called := false
	result := make(chan error, 1)
	go func() {
		_, e := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
		result <- e
	}()
	waitNativeQuery(t, db, "orders", result)
	if _, err = blocker.Exec(`UPDATE has_products SET prod_id=390238 WHERE order_id=5001`); err != nil {
		t.Fatal(err)
	}
	if err = releaseBlocker(); err != nil {
		t.Fatal(err)
	}
	if err = blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
	case <-time.After(4 * time.Second):
		t.Fatal("changed-hint waiter did not finish")
	}
	if err == nil || called || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 20 {
		t.Fatal("a late ticket bypassed the required early customer scope")
	}
}

func TestScreeningQuantityModeUsesOneMarkerAndPendingCredits(t *testing.T) {
	for _, pending := range []int{1, 2} {
		t.Run(fmt.Sprint(pending), func(t *testing.T) {
			db, ctx, _ := screeningFixture(t, false)
			execute(t, db, `UPDATE has_products SET qty=2 WHERE order_id=5001`)
			writePublicCreationFixture(t, db, 5001, false)
			for i := 0; i < pending; i++ {
				operation := fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
				writeScreeningState(t, db, screeningStateFixture(operation, "", "77", "2", "4", "RESERVED", 1, false))
			}
			called := false
			_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
			if pending == 1 {
				if err != nil || !called || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 18 {
					t.Fatalf("source quantity mode lost one-marker semantics: %v", err)
				}
			} else if err == nil || called || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 20 {
				t.Fatal("unresolved reservation credit was reused")
			}
		})
	}
}

func TestScreeningStoreCustomerPreludeAndChangedHints(t *testing.T) {
	for _, change := range []string{"none", "customer", "store", "removed-ticket"} {
		t.Run(change, func(t *testing.T) {
			db, ctx, _ := screeningFixture(t, true)
			blocker, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback()
			if _, err = blocker.Exec(`SELECT id FROM stores WHERE id=1 FOR UPDATE`); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			called := false
			go func() {
				_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
				result <- err
			}()
			waitNativeQuery(t, db, "stores", result)
			probe, e := db.Begin()
			if e != nil {
				t.Fatal(e)
			}
			for _, query := range []string{`SELECT id FROM pos_rewrite_import_financial_operations WHERE id='` + importOperation + `' FOR UPDATE NOWAIT`, `SELECT id FROM orders WHERE id=5001 FOR UPDATE NOWAIT`} {
				if _, e = probe.Exec(query); e != nil {
					probe.Rollback()
					t.Fatal("operation/Order acquired before Store", e)
				}
			}
			probe.Rollback()
			switch change {
			case "customer":
				execute(t, db, `UPDATE orders SET user_id=78 WHERE id=5001`)
			case "store":
				execute(t, db, `UPDATE order_stores SET store_id=2,counter_id=4 WHERE order_id=5001`)
			case "removed-ticket":
				screeningFixtureMutation(t, db, []int64{77}, []int64{5001}, []int64{6001}, `UPDATE has_products SET prod_id=10 WHERE order_id=5001`)
			}
			if err = blocker.Commit(); err != nil {
				t.Fatal(err)
			}
			err = <-result
			if change == "none" {
				if err != nil || !called {
					t.Fatalf("correct prelude failed: %v", err)
				}
			} else if err == nil || called || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 20 {
				t.Fatal("stale unlocked hint authorized source effects")
			}
		})
	}
}

func TestScreeningNonTicketWalletCancellationCannotInvertCountLocks(t *testing.T) {
	db, ctx, _ := screeningFixture(t, false)
	seedOrder(t, db, 7001, 14, 1, 0)
	entered, proceed := make(chan struct{}), make(chan struct{})
	result := make(chan error, 1)
	go func() {
		_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { close(entered); <-proceed; return sourceApply(tx, 5001, false) })
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(4 * time.Second):
		t.Fatal("screening did not reach original source")
	}
	cancel, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel.Rollback()
	if _, err = cancel.Exec(`SELECT id FROM orders WHERE id=7001 FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	cancelled := make(chan error, 1)
	go func() {
		if _, e := cancel.Exec(`SELECT id FROM users WHERE id=77 FOR UPDATE`); e != nil {
			cancelled <- e
			return
		}
		if _, e := cancel.Exec(`UPDATE users SET tss_money=tss_money+1 WHERE id=77`); e != nil {
			cancelled <- e
			return
		}
		if _, e := cancel.Exec(`UPDATE orders SET order_status=4 WHERE id=7001`); e != nil {
			cancelled <- e
			return
		}
		cancelled <- cancel.Commit()
	}()
	waitNativeQuery(t, db, "users")
	close(proceed)
	finishWithin(t, result)
	finishWithin(t, cancelled)
	if number(t, db, `SELECT order_status FROM orders WHERE id=7001`) != 4 {
		t.Fatal("non-ticket cancellation was dropped")
	}
}

func TestScreeningDifferentCustomerSourceInsertHasNoRangeGap(t *testing.T) {
	db, ctx, _ := screeningFixture(t, false)
	seedOrder(t, db, 5002, 14, 0, 0)
	execute(t, db, `UPDATE orders SET user_id=78 WHERE id=5002`)
	execute(t, db, `UPDATE order_stores SET store_id=2,counter_id=4 WHERE order_id=5002`)
	execute(t, db, `UPDATE has_products SET prod_id=390238,qty=1,sub_prod_id=0 WHERE order_id=5002`)
	_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error {
		other, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		raw, _ := importFixtureApplications.Load(db)
		writer, releaseWriter, closeWriter, e := poscheckout.ImportNativeFixtureBegin(other, raw.(*sql.DB), []int64{78}, []int64{5002}, []int64{6002})
		if e != nil {
			return e
		}
		defer closeWriter()
		defer writer.Rollback()
		defer releaseWriter()
		for _, query := range []string{`SELECT id FROM stores WHERE id=2 FOR UPDATE`, `SELECT id FROM users WHERE id=78 FOR UPDATE`, `SELECT id FROM orders WHERE id=5002 FOR UPDATE`, `INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(5002,6002,78)`} {
			if _, e = writer.ExecContext(other, query); e != nil {
				return e
			}
		}
		if e = releaseWriter(); e != nil {
			return e
		}
		if e = writer.Commit(); e != nil {
			return e
		}
		return sourceApply(tx, 5001, false)
	})
	if err != nil || number(t, db, `SELECT COUNT(*) FROM spiderman_screening_orders WHERE user_id=78`) != 1 {
		t.Fatalf("different customer source insert hit a screening gap lock: %v", err)
	}
}

func TestScreeningTwoCustomersReachOriginalSourceBeforeEmptyProofInsertion(t *testing.T) {
	db, ctx, _ := screeningFixture(t, false, true)
	seedOrder(t, db, 5002, 14, 0, 0)
	execute(t, db, `UPDATE orders SET user_id=78 WHERE id=5002`)
	execute(t, db, `UPDATE order_stores SET store_id=2,counter_id=4 WHERE order_id=5002`)
	execute(t, db, `UPDATE has_products SET prod_id=390238,qty=1,sub_prod_id=0 WHERE order_id=5002`)
	execute(t, db, `INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(5002,6002,78)`)
	writePublicCreationFixture(t, db, 5002, false)
	installImportNativeHead(t, db)
	arrived := make(chan struct{}, 2)
	proceed := make(chan struct{})
	results := make(chan error, 2)
	for _, id := range []int{5001, 5002} {
		go func(id int) {
			_, e := importFixtureConfirm(ctx, db, int64(id), poscheckout.DefaultHashes, func(tx *sql.Tx) error { arrived <- struct{}{}; <-proceed; return sourceApply(tx, id, false) })
			results <- e
		}(id)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-arrived:
		case e := <-results:
			t.Fatalf("writer failed before both original bodies: %v", e)
		case <-time.After(4 * time.Second):
			t.Fatal("different customers blocked on empty control proof gaps")
		}
	}
	close(proceed)
	finishWithin(t, results)
	finishWithin(t, results)
	if number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 2 || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 19 || number(t, db, `SELECT stock FROM product_store WHERE id=4`) != 19 {
		t.Fatal("two independent native confirmations did not conserve stock/proofs")
	}
}

func TestScreeningLateMutationRollsBackSourceAndProof(t *testing.T) {
	for _, change := range []string{"reservation", "marker"} {
		t.Run(change, func(t *testing.T) {
			db, ctx, _ := screeningFixture(t, true)
			_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error {
				if e := sourceApply(tx, 5001, false); e != nil {
					return e
				}
				query := `UPDATE pos_rewrite_import_screening_reservations SET data=JSON_SET(data,'$.quantity',2)`
				if change == "marker" {
					query = `UPDATE spiderman_screening_orders SET user_id=78 WHERE order_id=5001`
				}
				_, e := tx.Exec(query)
				return e
			})
			if err == nil || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 20 || number(t, db, `SELECT order_status FROM orders WHERE id=5001`) != 0 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 || number(t, db, `SELECT COUNT(*) FROM spiderman_screening_orders WHERE user_id=77`) != 1 {
				t.Fatal("late screening mismatch escaped native rollback")
			}
		})
	}
}

func TestScreeningConcurrentOriginalReplayAppliesOnce(t *testing.T) {
	db, ctx, _ := screeningFixture(t, true)
	var calls atomic.Int32
	var wait sync.WaitGroup
	errorsChannel := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, e := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { calls.Add(1); return sourceApply(tx, 5001, false) })
			errorsChannel <- e
		}()
	}
	wait.Wait()
	close(errorsChannel)
	for e := range errorsChannel {
		if e != nil {
			t.Fatal(e)
		}
	}
	if calls.Load() != 1 || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 19 || number(t, db, `SELECT COUNT(*) FROM spiderman_screening_orders`) != 1 {
		t.Fatal("screening replay repeated source money/stock/markers")
	}
}

func TestScreeningCompletedImportReadSurvivesOriginalActorArchive(t *testing.T) {
	db, ctx, cap := screeningFixture(t, true)
	if _, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { return sourceApply(tx, 5001, false) }); err != nil {
		t.Fatal(err)
	}
	completed := map[string]interface{}{"scope": cap["scope"], "requestHash": cap["requestHash"], "order": map[string]interface{}{"orderId": "5001", "customerId": "77"}}
	key := "fixture-distinct-native-financial-completion-key-0123456789"
	t.Setenv("POS_LEGACY_IMPORT_FINANCIAL_PROOF_KEY", key)
	raw, _ := json.Marshal(struct {
		Kind  string      `json:"kind"`
		Input interface{} `json:"input"`
	}{"legacy-order-imports.financial.completed.v1", completed})
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write(raw)
	data, _ := json.Marshal(completed)
	execute(t, db, `INSERT INTO pos_rewrite_import_financial_proofs VALUES(?,'5001',?,?,?)`, importOperation, cap["requestHash"], data, hex.EncodeToString(mac.Sum(nil)))
	var stateRaw []byte
	if err := db.QueryRow(`SELECT data FROM pos_rewrite_import_screening_reservations`).Scan(&stateRaw); err != nil {
		t.Fatal(err)
	}
	var state map[string]interface{}
	if json.Unmarshal(stateRaw, &state) != nil {
		t.Fatal("fixture screening state malformed")
	}
	state["phase"] = "COUNTED"
	state["completionHash"] = screeningMAC("screening-completion", completed)
	state["version"] = 2
	stateRaw, _ = json.Marshal(state)
	execute(t, db, `UPDATE pos_rewrite_import_screening_reservations SET data=?,proof_hash=?`, stateRaw, screeningMAC("screening-state", state))
	execute(t, db, `UPDATE pos_rewrite_import_financial_order_bindings SET status='completed'`)
	execute(t, db, `UPDATE pos_user SET is_active=0 WHERE id=44`)
	result, err := importFixtureConfirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(*sql.Tx) error { t.Fatal("completed archived original receipt reapplied source"); return nil })
	if err != nil || result.Created || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 19 {
		t.Fatalf("retained completed import did not survive archival: %v", err)
	}
	state["completionHash"] = strings.Repeat("f", 64)
	stateRaw, _ = json.Marshal(state)
	execute(t, db, `UPDATE pos_rewrite_import_screening_reservations SET data=?,proof_hash=?`, stateRaw, screeningMAC("screening-state", state))
	if _, err = importFixtureConfirm(context.Background(), db, 5001, poscheckout.DefaultHashes, func(*sql.Tx) error { t.Fatal("changed completion reference reached source"); return nil }); err == nil {
		t.Fatal("COUNTED did not bind the exact original financial completion")
	}
}

func TestScreeningImportCapabilityExpiresDuringStockWait(t *testing.T) {
	db, _, cap := screeningFixture(t, true)
	cap["expiresAt"] = time.Now().Add(2500 * time.Millisecond).UnixMilli()
	ctx := importContext(t, cap)
	blocker, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	if _, err = blocker.Exec(`SELECT id FROM product_store WHERE id=3 FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	called := false
	result := make(chan error, 1)
	go func() {
		_, e := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(tx *sql.Tx) error { called = true; return sourceApply(tx, 5001, false) })
		result <- e
	}()
	waitNativeQuery(t, db, "product_store", result)
	time.Sleep(time.Until(time.UnixMilli(cap["expiresAt"].(int64))) + 25*time.Millisecond)
	if err = blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
	case <-time.After(4 * time.Second):
		t.Fatal("stock waiter did not finish")
	}
	if err == nil || called || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 20 {
		t.Fatal("expired original capability reached source after stock wait")
	}
}

func TestScreeningUnselectedAndMissingProofFailBeforeSource(t *testing.T) {
	for _, change := range []string{"unselected", "missing-marker", "missing-reservation", "bad-seal", "missing-index", "inactive-store", "inactive-counter"} {
		t.Run(change, func(t *testing.T) {
			db, ctx, _ := screeningFixture(t, true)
			switch change {
			case "unselected":
				t.Setenv("POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT", "")
			case "missing-marker":
				screeningFixtureMutation(t, db, []int64{77}, []int64{5001}, []int64{6001}, `DELETE FROM spiderman_screening_orders`)
			case "missing-reservation":
				execute(t, db, `DELETE FROM pos_rewrite_import_screening_reservations`)
			case "bad-seal":
				execute(t, db, `UPDATE pos_rewrite_import_screening_reservations SET proof_hash=REPEAT('0',64)`)
			case "missing-index":
				execute(t, db, `ALTER TABLE spiderman_screening_orders DROP INDEX idx_user_id`)
			case "inactive-store":
				execute(t, db, `UPDATE stores SET is_active=0 WHERE id=1`)
			case "inactive-counter":
				execute(t, db, `UPDATE store_counters SET is_active=0 WHERE id=3`)
			}
			called := false
			_, err := importFixtureConfirm(ctx, db, 5001, poscheckout.DefaultHashes, func(*sql.Tx) error { called = true; return errors.New("source must not run") })
			if err == nil || called || number(t, db, `SELECT stock FROM product_store WHERE id=3`) != 20 {
				t.Fatal("unqualified screening reached source effects")
			}
		})
	}
}
