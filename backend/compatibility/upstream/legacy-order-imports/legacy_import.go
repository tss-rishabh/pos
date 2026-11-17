// Overlay for the reviewed ordinary poscheckout package, not the protected repo.
package poscheckout

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const LegacyImportContract = "pos-legacy-order-import-confirmation-v1"

type importContextKey struct{}
type importCapability struct {
	Contract    string `json:"contract"`
	Phase       string `json:"phase"`
	OperationID string `json:"operationId"`
	RequestHash string `json:"requestHash"`
	PlanHash    string `json:"planHash"`
	Namespace   string `json:"namespace"`
	PlanDigest  string `json:"planDigest"`
	OrderID     string `json:"orderId"`
	Nonce       string `json:"nonce"`
	Scope       struct {
		ActorID     string `json:"actorId"`
		OperationID string `json:"operationId"`
		StoreID     string `json:"storeId"`
		CounterID   string `json:"counterId"`
	} `json:"scope"`
	Authority struct {
		CustomerID   string         `json:"customerId"`
		ActorVersion string         `json:"actorVersion"`
		ActorEpoch   string         `json:"actorEpoch"`
		Contact      ContactBinding `json:"contact"`
	} `json:"authority"`
	IssuedAt  int64 `json:"issuedAt"`
	ExpiresAt int64 `json:"expiresAt"`
	raw       map[string]interface{}
}
type importContext struct {
	value   *importCapability
	invalid bool
}

var importUUID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

// Match the existing Node credential fingerprint's JSON.stringify encoding.
// These values are only strings, booleans, integers or NULL; never log them.
func importActorJSON(values []interface{}) ([]byte, error) {
	var output bytes.Buffer
	output.WriteByte('[')
	for index, value := range values {
		if index > 0 {
			output.WriteByte(',')
		}
		if text, ok := value.(string); ok {
			output.WriteByte('"')
			for _, r := range text {
				switch r {
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
					if r < 32 {
						hexValue := strconv.FormatInt(int64(r), 16)
						output.WriteString(`\u` + strings.Repeat("0", 4-len(hexValue)) + hexValue)
					} else {
						output.WriteRune(r)
					}
				}
			}
			output.WriteByte('"')
		} else {
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, ErrReview
			}
			output.Write(encoded)
		}
	}
	output.WriteByte(']')
	return output.Bytes(), nil
}

func importMAC(key, kind string, value interface{}) (string, error) {
	// All capability/receipt fields are ASCII IDs, hashes, integers and booleans.
	// json.Marshal sorts map keys; numbers are retained by Decoder.UseNumber.
	raw, err := json.Marshal(struct {
		Kind  string      `json:"kind"`
		Input interface{} `json:"input"`
	}{kind, value})
	if err != nil {
		return "", ErrReview
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil)), nil
}
func WithLegacyImport(ctx context.Context, raw, key string, now time.Time) (context.Context, error) {
	bad := func() (context.Context, error) {
		return context.WithValue(ctx, importContextKey{}, importContext{invalid: true}), ErrReview
	}
	if len(raw) < 1 || len(raw) > 16000 || !ProjectionKeyValid(key, key) {
		return bad()
	}
	bytesValue, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return bad()
	}
	var input map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(bytesValue))
	decoder.UseNumber()
	if decoder.Decode(&input) != nil || len(input) != 14 {
		return bad()
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF {
		return bad()
	}
	signature, ok := input["signature"].(string)
	if !ok || len(signature) != 64 {
		return bad()
	}
	delete(input, "signature")
	expected, err := importMAC(key, "legacy-order-imports.source.capability.v1", input)
	if err != nil || !hmac.Equal([]byte(expected), []byte(signature)) {
		return bad()
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return bad()
	}
	var capability importCapability
	if json.Unmarshal(encoded, &capability) != nil {
		return bad()
	}
	capability.raw = input
	if capability.Contract != "pos-legacy-order-import-source-v1" || capability.Phase != "confirmation" ||
		!consentIdentifier(capability.OrderID) || !consentIdentifier(capability.Scope.ActorID) ||
		!consentIdentifier(capability.Scope.StoreID) || !consentIdentifier(capability.Scope.CounterID) ||
		!consentIdentifier(capability.Authority.CustomerID) || !validContact(capability.Authority.Contact) ||
		capability.Scope.OperationID != capability.OperationID || !importUUID.MatchString(capability.OperationID) || !importUUID.MatchString(capability.Nonce) ||
		capability.Namespace != "pos-import-v1:"+capability.OperationID || !consentDigest.MatchString(capability.PlanHash) || !consentDigest.MatchString(capability.PlanDigest) ||
		!consentDigest.MatchString(capability.RequestHash) || !consentDigest.MatchString(capability.Authority.ActorVersion) ||
		capability.IssuedAt > now.UnixMilli() || capability.ExpiresAt <= now.UnixMilli() || capability.ExpiresAt > capability.IssuedAt+60000 {
		return bad()
	}
	return context.WithValue(ctx, importContextKey{}, importContext{value: &capability}), nil
}

func lockLegacyImport(ctx context.Context, tx *sql.Tx, orderID, userID, storeID, counterID int64) (*importCapability, error) {
	var operationID, requestHash, status string
	err := tx.QueryRowContext(ctx, `SELECT operation_id,request_hash,status FROM pos_rewrite_import_financial_order_bindings WHERE order_id=? FOR SHARE`, strconv.FormatInt(orderID, 10)).Scan(&operationID, &requestHash, &status)
	state, _ := ctx.Value(importContextKey{}).(importContext)
	if err == sql.ErrNoRows {
		if state.invalid || state.value != nil {
			return nil, ErrReview
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if status == "completed" {
		if state.invalid || state.value != nil {
			return nil, ErrReview
		}
		if err = verifyCompletedLegacyImport(ctx, tx, operationID, requestHash, orderID, userID, storeID, counterID); err != nil {
			return nil, err
		}
		return nil, nil
	}
	c := state.value
	if status != "held" || state.invalid || c == nil || os.Getenv("POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT") != LegacyImportContract ||
		c.OperationID != operationID || c.RequestHash != requestHash || c.OrderID != strconv.FormatInt(orderID, 10) ||
		c.Authority.CustomerID != strconv.FormatInt(userID, 10) || c.Scope.StoreID != strconv.FormatInt(storeID, 10) || c.Scope.CounterID != strconv.FormatInt(counterID, 10) {
		return nil, ErrReview
	}
	var actor, store, counter, nativeRequest, planHash, namespace, nonce, stageStatus string
	var body []byte
	if err = tx.QueryRowContext(ctx, `SELECT actor_id,store_id,counter_id,request_hash,plan_hash,namespace,state FROM pos_rewrite_import_financial_operations WHERE id=? AND OCTET_LENGTH(state)<=16000 FOR UPDATE`, operationID).Scan(&actor, &store, &counter, &nativeRequest, &planHash, &namespace, &body); err != nil {
		return nil, err
	}
	var original map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if decoder.Decode(&original) != nil {
		return nil, ErrReview
	}
	first, _ := json.Marshal(original["authority"])
	second, _ := json.Marshal(c.raw["authority"])
	nativeScope, _ := json.Marshal(original["scope"])
	capScope, _ := json.Marshal(c.raw["scope"])
	if actor != c.Scope.ActorID || store != c.Scope.StoreID || counter != c.Scope.CounterID || nativeRequest != c.RequestHash ||
		planHash != c.PlanHash || namespace != c.Namespace || !bytes.Equal(nativeScope, capScope) ||
		(original["status"] != "running" && original["status"] != "unknown") || !bytes.Equal(first, second) {
		return nil, ErrReview
	}
	if err = tx.QueryRowContext(ctx, `SELECT nonce,status FROM pos_rewrite_import_financial_stages WHERE operation_id=? AND kind='confirmation' FOR UPDATE`, operationID).Scan(&nonce, &stageStatus); err != nil {
		return nil, err
	}
	if nonce != c.Nonce || stageStatus != "dispatched" {
		return nil, ErrReview
	}
	if c.IssuedAt > time.Now().UnixMilli() || c.ExpiresAt <= time.Now().UnixMilli() {
		return nil, ErrReview
	}
	if err = freshLegacyImportActor(ctx, tx, c); err != nil {
		return nil, err
	}
	var digest string
	var revision uint64
	if err = tx.QueryRowContext(ctx, `SELECT `+CustomerContactDigestSQL+` FROM users WHERE id=? AND status=1 AND (is_block IS NULL OR is_block=0) AND (is_disabled IS NULL OR is_disabled=0) FOR UPDATE`, userID).Scan(&digest); err != nil {
		return nil, err
	}
	err = tx.QueryRowContext(ctx, `SELECT revision FROM pos_rewrite_customer_contact_revisions WHERE customer_id=? FOR SHARE`, c.Authority.CustomerID).Scan(&revision)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if digest != c.Authority.Contact.Digest || strconv.FormatUint(revision, 10) != c.Authority.Contact.Revision {
		return nil, ErrReview
	}
	if c.ExpiresAt <= time.Now().UnixMilli() {
		return nil, ErrReview
	}
	return c, nil
}

func freshLegacyImportActor(ctx context.Context, tx *sql.Tx, c *importCapability) error {
	var username, password string
	var email, mfaHash, phone, contact sql.NullString
	var active, staff, superuser bool
	var mfa sql.NullBool
	var role, userType, otp int
	var epoch uint64
	err := tx.QueryRowContext(ctx, `SELECT username,password,email,is_mfa,mfa_hash,phone,contact_email,otp_method,role,user_type,is_staff,is_superuser,is_active FROM pos_user WHERE id=? FOR SHARE`, c.Scope.ActorID).Scan(&username, &password, &email, &mfa, &mfaHash, &phone, &contact, &otp, &role, &userType, &staff, &superuser, &active)
	if err != nil {
		return err
	}
	if !active || userType != 1 || (role != 1 && role != 2 && role != 3) {
		return ErrReview
	}
	err = tx.QueryRowContext(ctx, `SELECT epoch FROM pos_rewrite_operator_auth_epochs WHERE operator_id=? FOR SHARE`, c.Scope.ActorID).Scan(&epoch)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	nullable := func(value sql.NullString) interface{} {
		if value.Valid {
			return value.String
		}
		return nil
	}
	raw, encodeErr := importActorJSON([]interface{}{username, nullable(email), password, mfa.Valid && mfa.Bool, nullable(mfaHash), nullable(phone), nullable(contact), otp, role, userType, staff, superuser})
	if encodeErr != nil {
		return encodeErr
	}
	credential := sha256.Sum256(raw)
	version := sha256.Sum256([]byte(hex.EncodeToString(credential[:]) + ":" + strconv.FormatUint(epoch, 10)))
	if hex.EncodeToString(version[:]) != c.Authority.ActorVersion || strconv.FormatUint(epoch, 10) != c.Authority.ActorEpoch {
		return ErrReview
	}
	var found int
	if err = tx.QueryRowContext(ctx, `SELECT 1 FROM stores WHERE id=? AND is_active=1 AND type IN ('STORE','CORE_WAREHOUSE') FOR UPDATE`, c.Scope.StoreID).Scan(&found); err != nil {
		return err
	}
	if err = tx.QueryRowContext(ctx, `SELECT 1 FROM store_counters WHERE id=? AND store_id=? AND is_active=1 FOR SHARE`, c.Scope.CounterID, c.Scope.StoreID).Scan(&found); err != nil {
		return err
	}
	if role != 1 {
		if err = tx.QueryRowContext(ctx, `SELECT 1 FROM user_stores WHERE django_user_id=? AND store_id=? LIMIT 1 FOR SHARE`, c.Scope.ActorID, c.Scope.StoreID).Scan(&found); err != nil {
			return err
		}
	}
	return nil
}

func recordLegacyImportConfirmation(ctx context.Context, tx *sql.Tx, c *importCapability, orderID int64) error {
	if c == nil {
		return nil
	}
	key := os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY")
	if !ProjectionKeyValid(key, key) {
		return ErrReview
	}
	var header string
	if err := tx.QueryRowContext(ctx, `SELECT `+LegacyImportHeaderSQL+` FROM orders WHERE id=?`, orderID).Scan(&header); err != nil {
		return err
	}
	proof := map[string]interface{}{"contract": LegacyImportContract, "operationId": c.OperationID, "orderId": c.OrderID,
		"requestHash": c.RequestHash, "nonce": c.Nonce, "customerId": c.Authority.CustomerID, "storeId": c.Scope.StoreID,
		"counterId": c.Scope.CounterID, "headerHash": header, "confirmedAt": time.Now().UnixMilli()}
	encoded, err := json.Marshal(proof)
	if err != nil {
		return err
	}
	seal, err := importMAC(key, "legacy-order-imports.source.confirmation.v1", proof)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO pos_rewrite_import_financial_source_receipts(id,operation_id,kind,request_hash,status,proof,proof_hash,created_at_ms) VALUES(?,?,'confirmation',?,'completed',?,?,?)`, c.OperationID+":confirmation", c.OperationID, c.RequestHash, encoded, seal, time.Now().UnixMilli())
	return err
}

func verifyCompletedLegacyImport(ctx context.Context, tx *sql.Tx, op, request string, order, user, store, counter int64) error {
	key := os.Getenv("POS_LEGACY_IMPORT_FINANCIAL_PROOF_KEY")
	if !ProjectionKeyValid(key, key) {
		return ErrReview
	}
	var raw []byte
	var seal string
	if err := tx.QueryRowContext(ctx, `SELECT data,proof_hash FROM pos_rewrite_import_financial_proofs WHERE operation_id=? AND order_id=? AND request_hash=? AND OCTET_LENGTH(data)<=1000000 FOR SHARE`, op, strconv.FormatInt(order, 10), request).Scan(&raw, &seal); err != nil {
		return err
	}
	var value map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return ErrReview
	}
	expected, err := importMAC(key, "legacy-order-imports.financial.completed.v1", value)
	if err != nil || !hmac.Equal([]byte(expected), []byte(seal)) {
		return ErrReview
	}
	scope, ok := value["scope"].(map[string]interface{})
	if !ok {
		return ErrReview
	}
	source, ok := value["order"].(map[string]interface{})
	if !ok {
		return ErrReview
	}
	if scope["operationId"] != op || scope["storeId"] != strconv.FormatInt(store, 10) || scope["counterId"] != strconv.FormatInt(counter, 10) ||
		source["orderId"] != strconv.FormatInt(order, 10) || source["customerId"] != strconv.FormatInt(user, 10) || value["requestHash"] != request {
		return ErrReview
	}
	return nil
}

// Workers do not trust a mutable completed label. Hold the binding and verify
// its original completion seal before claiming any ordinary deferred effect.
func verifyLegacyImportEffect(ctx context.Context, tx *sql.Tx, effect Effect) error {
	var op, request, status string
	err := tx.QueryRowContext(ctx, `SELECT operation_id,request_hash,status FROM pos_rewrite_import_financial_order_bindings WHERE order_id=? FOR SHARE`, strconv.FormatInt(effect.OrderID, 10)).Scan(&op, &request, &status)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if status != "completed" {
		return ErrReview
	}
	rows, err := tx.QueryContext(ctx, `SELECT store_id,counter_id FROM order_stores WHERE order_id=? FOR SHARE`, effect.OrderID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var store, counter int64
	if !rows.Next() {
		return ErrReview
	}
	if rows.Scan(&store, &counter) != nil {
		return ErrReview
	}
	if rows.Next() || rows.Err() != nil {
		return ErrReview
	}
	return verifyCompletedLegacyImport(ctx, tx, op, request, effect.OrderID, effect.UserID, store, counter)
}
