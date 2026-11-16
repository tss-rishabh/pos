package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func fixtureMemberRows(t *testing.T, tx *sql.Tx) []map[string]interface{} {
	t.Helper()
	rows, err := tx.Query(`SELECT attribute,value,is_active,DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(created_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s'),DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(updated_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s'),` + poscheckout.MembershipStateHashSQL + ` FROM user_eav WHERE entity='fixture@example.test' AND attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') ORDER BY attribute FOR UPDATE`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := make([]map[string]interface{}, 0)
	for rows.Next() {
		var attribute, value, created, updated, hash string
		var active int
		if err = rows.Scan(&attribute, &value, &active, &created, &updated, &hash); err != nil {
			t.Fatal(err)
		}
		result = append(result, map[string]interface{}{"attribute": attribute, "value": value, "active": active, "createdAt": created, "updatedAt": updated, "hash": hash})
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}
func fixtureMemberHash(kind string, value interface{}) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
	input := bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
	encodedKind, _ := json.Marshal(kind)
	body := append([]byte(`{"kind":`), encodedKind...)
	body = append(body, []byte(`,"input":`)...)
	body = append(body, input...)
	body = append(body, '}')
	mac := hmac.New(sha256.New, []byte(os.Getenv("POS_MEMBERSHIP_PROOF_KEY")))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// This fixture owns the original empty state before the actual stage insert.
// It is consumer evidence, not a production provenance backfill. The separate
// cross-language runner executes the literal patched API-v2 producer itself.
func seedMembershipStage(t *testing.T, db *sql.DB, orderID int) {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var user int
	var header string
	if err = tx.QueryRow(`SELECT user_id,`+poscheckout.HeaderHashSQL+` FROM orders WHERE id=? FOR UPDATE`, orderID).Scan(&user, &header); err != nil {
		t.Fatal(err)
	}
	var entity string
	if err = tx.QueryRow(`SELECT email FROM users WHERE id=? FOR UPDATE`, user).Scan(&entity); err != nil {
		t.Fatal(err)
	}
	before := fixtureMemberRows(t, tx)
	if len(before) != 0 {
		t.Fatal("fixture cannot manufacture a historical state")
	}
	if _, err = tx.Exec(`INSERT INTO user_eav(entity,attribute,is_active,value,created_at,updated_at) VALUES('fixture@example.test','EXCLUSIVE_MEMBER',0,'1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),('fixture@example.test','EXCLUSIVE_EXPIRY',0,'2027-01-01T00:00:00',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	confirmed := fixtureMemberRows(t, tx)
	if _, err = tx.Exec(`UPDATE pos_rewrite_membership_versions SET revision=revision+1 WHERE customer_id=?`, user); err != nil {
		t.Fatal(err)
	}
	var revision string
	if err = tx.QueryRow(`SELECT CAST(revision AS CHAR) FROM pos_rewrite_membership_versions WHERE customer_id=? FOR UPDATE`, user).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	created := "2026-11-17 12:00:00"
	operation := "11111111-1111-4111-8111-111111111111"
	digest := fixtureMemberHash("pending-cancellation.membership-entity.v1", entity)
	record := map[string]interface{}{"orderId": fmt.Sprint(orderID), "customerId": fmt.Sprint(user), "revision": revision, "headerHash": header, "before": before, "confirmed": confirmed, "contract": poscheckout.MembershipStagedContract, "operationId": operation, "createdAt": created, "entityDigest": digest}
	proof := fixtureMemberHash("pending-cancellation.membership-provenance.v2", record)
	beforeRaw, _ := json.Marshal(before)
	confirmedRaw, _ := json.Marshal(confirmed)
	if _, err = tx.Exec(`INSERT INTO pos_rewrite_cancellation_membership_provenance(order_id,customer_id,revision,header_hash,before_state,confirmed_state,contract_version,operation_id,created_at,proof_hash,entity_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, orderID, user, revision, header, string(beforeRaw), string(confirmedRaw), poscheckout.MembershipStagedContract, operation, created, proof, digest); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
