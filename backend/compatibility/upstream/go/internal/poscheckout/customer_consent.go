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
	"regexp"
	"strconv"
	"strings"
	"time"
)

const CustomerConsentContract = "pos-customer-contact-consent-v1"
const CustomerContactDigestSQL = "LOWER(SHA2(CAST(JSON_OBJECT('customer_id',users.id,'email',users.email,'telephone',users.telephone) AS CHAR CHARACTER SET utf8mb4),256))"

type ContactBinding struct {
	Revision string `json:"revision"`
	Digest   string `json:"digest"`
}
type CustomerConsent struct {
	V          int            `json:"v"`
	Contract   string         `json:"contract"`
	OrderID    string         `json:"orderId"`
	CustomerID string         `json:"customerId"`
	OperatorID string         `json:"operatorId"`
	StoreID    string         `json:"storeId"`
	CounterID  string         `json:"counterId"`
	Contact    ContactBinding `json:"contact"`
	ExpiresAt  int64          `json:"expiresAt"`
}
type consentKey struct{}
type consentState struct {
	value   *CustomerConsent
	invalid bool
}

var consentID = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
var consentRevision = regexp.MustCompile(`^(0|[1-9][0-9]{0,19})$`)
var consentDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func consentIdentifier(value string) bool {
	if !consentID.MatchString(value) {
		return false
	}
	number, err := strconv.ParseInt(value, 10, 64)
	return err == nil && number > 0
}
func validContact(value ContactBinding) bool {
	if !consentRevision.MatchString(value.Revision) || !consentDigest.MatchString(value.Digest) {
		return false
	}
	_, err := strconv.ParseUint(value.Revision, 10, 64)
	return err == nil
}

// The raw proof is removed by PrivateHTTP before downstream middleware. No
// customer/session JWT key is accepted and no proof or contact digest is logged.
func WithCustomerConsent(ctx context.Context, raw, key, operatorID string, now time.Time) (context.Context, error) {
	bad := func() (context.Context, error) {
		return context.WithValue(ctx, consentKey{}, consentState{invalid: true}), ErrReview
	}
	if len(raw) < 1 || len(raw) > 4096 || len(key) < 32 || len(key) > 4096 {
		return bad()
	}
	for _, b := range []byte(key) {
		if b < 33 || b > 126 {
			return bad()
		}
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 || len(parts[1]) != 64 {
		return bad()
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(body) > 2048 || base64.RawURLEncoding.EncodeToString(body) != parts[0] {
		return bad()
	}
	signature, err := hex.DecodeString(parts[1])
	if err != nil || hex.EncodeToString(signature) != parts[1] {
		return bad()
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(CustomerConsentContract + "\n" + parts[0]))
	if !hmac.Equal(mac.Sum(nil), signature) {
		return bad()
	}
	var value CustomerConsent
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil {
		return bad()
	}
	canonical, err := json.Marshal(value)
	if err != nil || !bytes.Equal(canonical, body) {
		return bad()
	}
	if value.V != 1 || value.Contract != CustomerConsentContract || !validContact(value.Contact) ||
		!consentIdentifier(value.OrderID) || !consentIdentifier(value.CustomerID) ||
		!consentIdentifier(value.OperatorID) || !consentIdentifier(value.StoreID) ||
		!consentIdentifier(value.CounterID) || value.OperatorID != operatorID ||
		now.UnixMilli() < 1 || value.ExpiresAt <= now.UnixMilli() || value.ExpiresAt > now.UnixMilli()+900000 || value.ExpiresAt > 9007199254740991 {
		return bad()
	}
	return context.WithValue(ctx, consentKey{}, consentState{value: &value}), nil
}

type consentAttestation struct {
	required   bool
	operatorID *int64
	contact    *ContactBinding
	expiresAt  *int64
}

func consentBeforeMutation(ctx context.Context, tx *sql.Tx, orderID, userID, storeID, counterID, couponID int64, money, points float32, voucherAmount float64) (consentAttestation, error) {
	value, _ := ctx.Value(consentKey{}).(consentState)
	if value.invalid {
		return consentAttestation{}, ErrReview
	}
	required := money > 0 || points > 0 || voucherAmount > 0
	if couponID > 0 {
		var employee int
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(is_employee_coupon,0) FROM coupons WHERE id=? FOR SHARE`, couponID).Scan(&employee); err != nil {
			return consentAttestation{}, err
		}
		if employee != 0 && employee != 1 {
			return consentAttestation{}, ErrReview
		}
		required = required || employee == 1
	}
	result := consentAttestation{required: required}
	if raw := OperatorID(ctx); raw != nil {
		parsed, err := strconv.ParseInt(*raw, 10, 64)
		if err != nil || parsed < 1 {
			return result, ErrReview
		}
		result.operatorID = &parsed
	}
	if !required {
		return result, nil
	}
	claim := value.value
	if claim == nil || claim.OrderID != strconv.FormatInt(orderID, 10) || claim.CustomerID != strconv.FormatInt(userID, 10) ||
		claim.StoreID != strconv.FormatInt(storeID, 10) || claim.CounterID != strconv.FormatInt(counterID, 10) || claim.ExpiresAt <= time.Now().UnixMilli() {
		return result, ErrReview
	}
	var currentDigest, currentRevision string
	if err := tx.QueryRowContext(ctx, `SELECT `+CustomerContactDigestSQL+` FROM users WHERE id=?`, userID).Scan(&currentDigest); err != nil {
		return result, err
	}
	err := tx.QueryRowContext(ctx, `SELECT CAST(revision AS CHAR) FROM pos_rewrite_customer_contact_revisions WHERE customer_id=? FOR SHARE`, strconv.FormatInt(userID, 10)).Scan(&currentRevision)
	if err == sql.ErrNoRows {
		currentRevision = "0"
	} else if err != nil {
		return result, err
	}
	if currentDigest != claim.Contact.Digest || currentRevision != claim.Contact.Revision {
		return result, ErrReview
	}
	actor, err := strconv.ParseInt(claim.OperatorID, 10, 64)
	if err != nil || actor < 1 || (result.operatorID != nil && *result.operatorID != actor) {
		return result, ErrReview
	}
	result.operatorID = &actor
	result.contact = &claim.Contact
	result.expiresAt = &claim.ExpiresAt
	return result, nil
}

func recordCustomerConsent(ctx context.Context, tx *sql.Tx, orderID, userID, storeID, counterID int64, inputHash string, value consentAttestation) error {
	acceptedAt := time.Now().UnixMilli()
	var revision, digest, expiry interface{}
	if value.required {
		if value.contact == nil || value.expiresAt == nil || value.operatorID == nil || acceptedAt >= *value.expiresAt || *value.expiresAt > acceptedAt+900000 {
			return ErrReview
		}
		revision = value.contact.Revision
		digest = value.contact.Digest
		expiry = *value.expiresAt
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO pos_rewrite_checkout_customer_consents(order_id,store_id,counter_id,user_id,operator_id,input_hash,required,contact_revision,contact_digest,verified_until_ms,accepted_at_ms,contract_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, orderID, storeID, counterID, userID, value.operatorID, inputHash, value.required, revision, digest, expiry, acceptedAt, CustomerConsentContract)
	return err
}

func verifyCustomerConsentProof(ctx context.Context, tx *sql.Tx, orderID, userID, storeID, counterID int64, inputHash string, money, points float32, voucherAmount float64) error {
	var actualOrder, actualUser, actualStore, actualCounter, accepted int64
	var actor, expiry sql.NullInt64
	var required int
	var hash, contract string
	var revision, digest sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT order_id,user_id,store_id,counter_id,operator_id,input_hash,required,CAST(contact_revision AS CHAR),contact_digest,verified_until_ms,accepted_at_ms,contract_version FROM pos_rewrite_checkout_customer_consents WHERE order_id=?`, orderID).Scan(&actualOrder, &actualUser, &actualStore, &actualCounter, &actor, &hash, &required, &revision, &digest, &expiry, &accepted, &contract)
	if err != nil {
		return err
	}
	if actualOrder != orderID || actualUser != userID || actualStore != storeID || actualCounter != counterID || hash != inputHash || contract != CustomerConsentContract || accepted < 1 || accepted > 9007199254740991 || (actor.Valid && actor.Int64 < 1) {
		return ErrReview
	}
	if required == 0 {
		if money > 0 || points > 0 || voucherAmount > 0 || revision.Valid || digest.Valid || expiry.Valid {
			return ErrReview
		}
		return nil
	}
	if required != 1 || !actor.Valid || !revision.Valid || !digest.Valid || !expiry.Valid ||
		!validContact(ContactBinding{Revision: revision.String, Digest: digest.String}) || expiry.Int64 <= accepted || expiry.Int64 > accepted+900000 {
		return ErrReview
	}
	// Current contacts, expiry, roles and paying operator are intentionally not
	// reinterpreted: this is immutable evidence of an already committed spend.
	return nil
}
