package poscheckout

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const MembershipStagedContract = "pos-cancellation-membership-staged-v2"
const MembershipContract = "pos-cancellation-membership-provenance-v2"
const MembershipStateHashSQL = `LOWER(SHA2(CAST(JSON_OBJECT('attribute',user_eav.attribute,'value',user_eav.value,'active',user_eav.is_active,'created_at',UNIX_TIMESTAMP(user_eav.created_at),'updated_at',UNIX_TIMESTAMP(user_eav.updated_at)) AS CHAR CHARACTER SET utf8mb4),256))`
const membershipStateSQL = `SELECT attribute,value,is_active,DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(created_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s'),DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(updated_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s'),` + MembershipStateHashSQL + ` FROM user_eav WHERE entity=? AND attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') ORDER BY attribute LIMIT 3 FOR UPDATE`

type membershipFenceDefinition struct{ Name, Event, Table, Timing, Hash string }
type membershipConfig struct {
	key      string
	products map[int64]bool
}

// Field order is canonical JS operationHash order inside each nested state.
type MembershipState struct {
	Active    int    `json:"active"`
	Attribute string `json:"attribute"`
	CreatedAt string `json:"createdAt"`
	Hash      string `json:"hash"`
	UpdatedAt string `json:"updatedAt"`
	Value     string `json:"value"`
}
type membershipProof struct {
	OrderID, CustomerID                                                   int64
	Revision                                                              uint64
	HeaderHash, Contract, OperationID, CreatedAt, ProofHash, EntityDigest string
	Before, Confirmed                                                     []MembershipState
}
type membershipActivation struct {
	proof       membershipProof
	entity, key string
}

func configuredMembership() (membershipConfig, error) {
	value := membershipConfig{key: os.Getenv("POS_MEMBERSHIP_PROOF_KEY"), products: map[int64]bool{}}
	if os.Getenv("POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT") != MembershipFenceContract || len([]byte(value.key)) < 32 || len([]byte(value.key)) > 4096 {
		return value, ErrReview
	}
	var ids []string
	decoder := json.NewDecoder(strings.NewReader(os.Getenv("POS_MEMBERSHIP_PRODUCT_IDS")))
	if err := decoder.Decode(&ids); err != nil || ids == nil || len(ids) > 1000 {
		return value, ErrReview
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF {
		return value, ErrReview
	}
	for _, raw := range ids {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id < 1 || strconv.FormatInt(id, 10) != raw || value.products[id] {
			return value, ErrReview
		}
		value.products[id] = true
	}
	expected := map[int64]bool{}
	values := []string{os.Getenv("EXCLUSIVE_PRODUCT_ID"), os.Getenv("EXCLUSIVE_99_PRODUCT_ID"), os.Getenv("EXCLUSIVE_QUARTERLY_ID"), os.Getenv("EXCLUSIVE_QUARTERLY_ID_FREE")}
	values = append(values, strings.Split(os.Getenv("EXCLUSIVE_UPGRADE_IDS"), ",")...)
	for _, raw := range values {
		if raw == "" {
			continue
		}
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id < 1 || strconv.FormatInt(id, 10) != raw {
			return value, ErrReview
		}
		expected[id] = true
	}
	if len(expected) != len(value.products) {
		return value, ErrReview
	}
	for id := range expected {
		if !value.products[id] {
			return value, ErrReview
		}
	}
	return value, nil
}

func nativeMembershipFence(ctx context.Context, tx *sql.Tx, entity string) error {
	rows, err := tx.QueryContext(ctx, `SELECT entity FROM user_eav WHERE entity=? AND attribute='EXCLUSIVE_MEMBER' LIMIT 1 FOR SHARE`, entity)
	if err != nil {
		return err
	}
	rows.Close()
	rows, err = tx.QueryContext(ctx, `SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='users' AND COLUMN_NAME='email') OR (TABLE_NAME='user_eav' AND COLUMN_NAME IN ('created_at','updated_at')))`)
	if err != nil {
		return err
	}
	count := 0
	for rows.Next() {
		var table, column, kind string
		var collation sql.NullString
		if err = rows.Scan(&table, &column, &kind, &collation); err != nil {
			rows.Close()
			return err
		}
		if (table == "users" && (!collation.Valid || collation.String != "utf8mb3_general_ci")) || (table == "user_eav" && kind != "timestamp") {
			rows.Close()
			return ErrReview
		}
		count++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if count != 3 {
		return ErrReview
	}
	rows, err = tx.QueryContext(ctx, `SELECT TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','user_eav') AND IS_VISIBLE='YES' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 1001`)
	if err != nil {
		return err
	}
	groups := map[string][]string{}
	count = 0
	for rows.Next() {
		var table, name, column string
		var ordinal int
		var prefix sql.NullInt64
		if err = rows.Scan(&table, &name, &ordinal, &column, &prefix); err != nil {
			rows.Close()
			return err
		}
		key := table + ":" + name
		for len(groups[key]) < ordinal {
			groups[key] = append(groups[key], "")
		}
		if !prefix.Valid {
			groups[key][ordinal-1] = column
		}
		count++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if count > 1000 {
		return ErrReview
	}
	userIndex, eavIndex := false, false
	for key, columns := range groups {
		if strings.HasPrefix(key, "users:") && len(columns) > 0 && columns[0] == "email" {
			userIndex = true
		}
		if strings.HasPrefix(key, "user_eav:") && len(columns) > 1 && columns[0] == "entity" && columns[1] == "attribute" {
			eavIndex = true
		}
	}
	if !userIndex || !eavIndex {
		return ErrReview
	}
	rows, err = tx.QueryContext(ctx, `SELECT TRIGGER_NAME,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_TIMING,LOWER(SHA2(ACTION_STATEMENT,256)),SQL_MODE FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('pos_rewrite_mem_eav_insert','pos_rewrite_mem_eav_update','pos_rewrite_mem_eav_delete','pos_rewrite_mem_user_email')`)
	if err != nil {
		return err
	}
	actual := map[string]membershipFenceDefinition{}
	for rows.Next() {
		var item membershipFenceDefinition
		var mode string
		if err = rows.Scan(&item.Name, &item.Event, &item.Table, &item.Timing, &item.Hash, &mode); err != nil {
			rows.Close()
			return err
		}
		strict := false
		for _, part := range strings.Split(mode, ",") {
			if part == "STRICT_TRANS_TABLES" || part == "STRICT_ALL_TABLES" {
				strict = true
			}
		}
		if !strict {
			rows.Close()
			return ErrReview
		}
		actual[item.Name] = item
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(actual) != len(membershipFenceDefinitions) {
		return ErrReview
	}
	for _, expected := range membershipFenceDefinitions {
		if actual[expected.Name] != expected {
			return ErrReview
		}
	}
	return nil
}

func memberStates(ctx context.Context, tx *sql.Tx, entity string) ([]MembershipState, error) {
	rows, err := tx.QueryContext(ctx, membershipStateSQL, entity)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	states := make([]MembershipState, 0, 2)
	for rows.Next() {
		var state MembershipState
		if err = rows.Scan(&state.Attribute, &state.Value, &state.Active, &state.CreatedAt, &state.UpdatedAt, &state.Hash); err != nil {
			return nil, err
		}
		states = append(states, state)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if !coherentMemberStates(states, true) {
		return nil, ErrReview
	}
	return states, nil
}
func coherentMemberStates(states []MembershipState, allowEmpty bool) bool {
	if states == nil {
		return false
	}
	if len(states) == 0 {
		return allowEmpty
	}
	if len(states) != 2 {
		return false
	}
	seen := map[string]bool{}
	for _, state := range states {
		if seen[state.Attribute] || (state.Active != 0 && state.Active != 1) || len(state.Hash) != 64 {
			return false
		}
		seen[state.Attribute] = true
		if _, err := hex.DecodeString(state.Hash); err != nil {
			return false
		}
		for _, date := range []string{state.CreatedAt, state.UpdatedAt} {
			if _, err := time.Parse("2006-01-02 15:04:05", date); err != nil {
				return false
			}
		}
		if state.Attribute == "EXCLUSIVE_MEMBER" {
			if !strings.Contains("123456", state.Value) || len(state.Value) != 1 {
				return false
			}
		} else if state.Attribute == "EXCLUSIVE_EXPIRY" {
			if _, err := time.Parse("2006-01-02T15:04:05.999999999", strings.Replace(state.Value, " ", "T", 1)); err != nil {
				return false
			}
		} else {
			return false
		}
	}
	return seen["EXCLUSIVE_MEMBER"] && seen["EXCLUSIVE_EXPIRY"]
}
func decodeMemberStates(raw []byte) ([]MembershipState, error) {
	if len(raw) > 65536 {
		return nil, ErrReview
	}
	var value []MembershipState
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return nil, ErrReview
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF || !coherentMemberStates(value, true) {
		return nil, ErrReview
	}
	return value, nil
}
func readMembershipProof(ctx context.Context, tx *sql.Tx, orderID int64) (membershipProof, error) {
	var proof membershipProof
	var before, confirmed []byte
	err := tx.QueryRowContext(ctx, `SELECT order_id,customer_id,revision,header_hash,before_state,confirmed_state,contract_version,operation_id,CAST(created_at AS CHAR),proof_hash,entity_digest FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=? FOR UPDATE`, orderID).Scan(&proof.OrderID, &proof.CustomerID, &proof.Revision, &proof.HeaderHash, &before, &confirmed, &proof.Contract, &proof.OperationID, &proof.CreatedAt, &proof.ProofHash, &proof.EntityDigest)
	if err != nil {
		return proof, err
	}
	proof.Before, err = decodeMemberStates(before)
	if err != nil {
		return proof, err
	}
	proof.Confirmed, err = decodeMemberStates(confirmed)
	if err != nil {
		return proof, err
	}
	return proof, nil
}
func jsString(value string) string {
	var output strings.Builder
	output.WriteByte('"')
	for _, item := range value {
		switch item {
		case '"':
			output.WriteString(`\"`)
		case '\\':
			output.WriteString(`\\`)
		case '\b':
			output.WriteString(`\b`)
		case '\f':
			output.WriteString(`\f`)
		case '\n':
			output.WriteString(`\n`)
		case '\r':
			output.WriteString(`\r`)
		case '\t':
			output.WriteString(`\t`)
		default:
			if item < 32 {
				output.WriteString(`\u00`)
				const digits = "0123456789abcdef"
				output.WriteByte(digits[byte(item)>>4])
				output.WriteByte(digits[byte(item)&15])
			} else {
				output.WriteRune(item)
			}
		}
	}
	output.WriteByte('"')
	return output.String()
}
func memberHash(kind string, value interface{}, key string) (string, error) {
	var payload string
	if text, ok := value.(string); ok {
		if !utf8.ValidString(text) {
			return "", ErrReview
		}
		payload = jsString(text)
	} else {
		var encoded bytes.Buffer
		encoder := json.NewEncoder(&encoded)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(value); err != nil {
			return "", err
		}
		payload = strings.TrimSuffix(encoded.String(), "\n")
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(`{"kind":` + jsString(kind) + `,"input":` + payload + `}`))
	return hex.EncodeToString(mac.Sum(nil)), nil
}
func membershipMAC(proof membershipProof, key string) (string, error) {
	return memberHash("pending-cancellation.membership-provenance.v2", map[string]interface{}{"orderId": strconv.FormatInt(proof.OrderID, 10), "customerId": strconv.FormatInt(proof.CustomerID, 10), "revision": strconv.FormatUint(proof.Revision, 10), "headerHash": proof.HeaderHash, "before": proof.Before, "confirmed": proof.Confirmed, "contract": proof.Contract, "operationId": proof.OperationID, "createdAt": proof.CreatedAt, "entityDigest": proof.EntityDigest}, key)
}
func validMemberMAC(proof membershipProof, key string) bool {
	expected, err := membershipMAC(proof, key)
	if err != nil {
		return false
	}
	a, e1 := hex.DecodeString(expected)
	b, e2 := hex.DecodeString(proof.ProofHash)
	return e1 == nil && e2 == nil && len(b) == 32 && hmac.Equal(a, b)
}
func sameMemberStates(a, b []MembershipState) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func lockMembership(ctx context.Context, tx *sql.Tx, orderID, userID int64, header string, lines []Line, replay bool) (*membershipActivation, error) {
	config, err := configuredMembership()
	if err != nil {
		return nil, err
	}
	needed := false
	for _, line := range lines {
		if config.products[line.ProductID] {
			needed = true
		}
	}
	proof, err := readMembershipProof(ctx, tx, orderID)
	if err == sql.ErrNoRows {
		if needed {
			return nil, ErrReview
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var entity string
	if err = tx.QueryRowContext(ctx, `SELECT email FROM users WHERE id=? FOR UPDATE`, userID).Scan(&entity); err != nil {
		return nil, err
	}
	if entity == "" {
		return nil, ErrReview
	}
	if err = nativeMembershipFence(ctx, tx, entity); err != nil {
		return nil, err
	}
	if proof.OrderID != orderID || proof.CustomerID != userID || proof.HeaderHash != header || proof.Revision == 0 || !validMemberMAC(proof, config.key) {
		return nil, ErrReview
	}
	var revision uint64
	if err = tx.QueryRowContext(ctx, `SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=? FOR UPDATE`, userID).Scan(&revision); err != nil {
		return nil, err
	}
	if replay {
		if proof.Contract != MembershipContract || proof.Revision > revision {
			return nil, ErrReview
		}
		return nil, nil
	}
	digest, err := memberHash("pending-cancellation.membership-entity.v1", entity, config.key)
	if err != nil {
		return nil, err
	}
	if digest != proof.EntityDigest {
		return nil, ErrReview
	}
	owners, err := tx.QueryContext(ctx, `SELECT id FROM users WHERE email=? ORDER BY id LIMIT 2 FOR UPDATE`, entity)
	if err != nil {
		return nil, err
	}
	ownerCount := 0
	for owners.Next() {
		var id int64
		if err = owners.Scan(&id); err != nil {
			owners.Close()
			return nil, err
		}
		if id != userID {
			owners.Close()
			return nil, ErrReview
		}
		ownerCount++
	}
	err = owners.Err()
	owners.Close()
	if err != nil {
		return nil, err
	}
	if ownerCount != 1 {
		return nil, ErrReview
	}
	if !needed || proof.Contract != MembershipStagedContract || proof.Revision != revision || !coherentMemberStates(proof.Confirmed, false) {
		return nil, ErrReview
	}
	current, err := memberStates(ctx, tx, entity)
	if err != nil {
		return nil, err
	}
	if !sameMemberStates(current, proof.Confirmed) {
		return nil, ErrReview
	}
	return &membershipActivation{proof: proof, entity: entity, key: config.key}, nil
}
func finishMembership(ctx context.Context, tx *sql.Tx, activation *membershipActivation) error {
	if activation == nil {
		return nil
	}
	proof := activation.proof
	var entity string
	if err := tx.QueryRowContext(ctx, `SELECT email FROM users WHERE id=? FOR UPDATE`, proof.CustomerID).Scan(&entity); err != nil {
		return err
	}
	if entity != activation.entity {
		return ErrReview
	}
	current, err := memberStates(ctx, tx, activation.entity)
	if err != nil {
		return err
	}
	if !coherentMemberStates(current, false) {
		return ErrReview
	}
	for _, state := range current {
		if state.Active != 1 {
			return ErrReview
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE pos_rewrite_membership_versions SET revision=revision+1 WHERE customer_id=?`, proof.CustomerID); err != nil {
		return err
	}
	if err = tx.QueryRowContext(ctx, `SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=? FOR UPDATE`, proof.CustomerID).Scan(&proof.Revision); err != nil {
		return err
	}
	proof.Confirmed = current
	proof.Contract = MembershipContract
	proof.ProofHash, err = membershipMAC(proof, activation.key)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(current)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE pos_rewrite_cancellation_membership_provenance SET revision=?,confirmed_state=?,contract_version=?,proof_hash=? WHERE order_id=? AND contract_version=? AND proof_hash=?`, proof.Revision, string(raw), proof.Contract, proof.ProofHash, proof.OrderID, MembershipStagedContract, activation.proof.ProofHash)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return ErrReview
	}
	return nil
}

// Keep deterministic product iteration when the reviewed manifest is inspected.
func MembershipProductIDs() ([]int64, error) {
	value, err := configuredMembership()
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(value.products))
	for id := range value.products {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}
