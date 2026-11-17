// Same-transaction evidence around the EXISTING source coupon deduction.
// This overlay never increments a counter or manufactures a coupon log.
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
	"regexp"
	"strconv"
	"strings"
	"time"
)

const ImportCouponConsumptionContract = "pos-csv-coupon-consumption-v1"
const importCouponStageContract = "pos-csv-automatic-coupon-v1"
const ImportCouponUserHashSQL = "LOWER(SHA2(CAST(JSON_OBJECT('id',coupons_users.id,'coupon_id',coupons_users.c_id,'customer_id',coupons_users.user_id,'allowed',coupons_users.coupon_allowed_count,'used',coupons_users.coupon_used_count,'monthly_allowed',coupons_users.coupon_month_allowed_count) AS CHAR CHARACTER SET utf8mb4),256))"
const ImportCouponLogHashSQL = "LOWER(SHA2(CAST(JSON_OBJECT('id',order_coupon_log.id,'user_id',order_coupon_log.user_id,'order_id',order_coupon_log.order_id,'coupon_id',order_coupon_log.coupon_id,'status',order_coupon_log.status,'created_at',DATE_FORMAT(order_coupon_log.created_at,'%Y-%m-%d %H:%i:%s'),'updated_at',DATE_FORMAT(order_coupon_log.updated_at,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))"
const importCouponControlHashSQL = "LOWER(SHA2(CAST(JSON_OBJECT('id',coupons.id,'voucher_type',coupons.voucher_type,'disc_apply_items',coupons.disc_apply_items,'min_order_amt',coupons.min_order_amt,'voucher_code',coupons.voucher_code,'voucher_val',coupons.voucher_val,'voucher_valid_for',coupons.voucher_valid_for,'platform',coupons.platform,'voucher_percentage_max_val',coupons.voucher_percentage_max_val,'for_new_user',coupons.for_new_user,'user_specific',coupons.user_specific,'buyable_quantity',coupons.buyable_quantity,'free_quantity',coupons.free_quantity,'is_applicable_on_discounted_products',coupons.is_applicable_on_discounted_products,'voucher_mxn_type',coupons.voucher_mxn_type,'no_times_allowed',coupons.no_times_allowed,'coupon_lot_no',coupons.coupon_lot_no,'unique_no_times_allowed',coupons.unique_no_times_allowed,'message',coupons.message,'user_type',coupons.user_type,'default_country_id',coupons.default_country_id,'is_deleted',coupons.is_deleted,'start_date',DATE_FORMAT(coupons.start_date,'%Y-%m-%d %H:%i:%s'),'end_date',DATE_FORMAT(coupons.end_date,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))"
const importCouponRefundHashSQL = "LOWER(SHA2(CAST(JSON_OBJECT('id',has_products.id,'disc',has_products.disc,'refundable',has_products.amount_to_be_refunded) AS CHAR CHARACTER SET utf8mb4),256))"

var importBenefitAmount = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})\.[0-9]{2}$`)
var importBenefitCount = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)

type importBenefitScope struct {
	OperationID   string `json:"operationId"`
	RequestHash   string `json:"requestHash"`
	PlanHash      string `json:"planHash"`
	ActorID       string `json:"actorId"`
	AuthorityHash string `json:"authorityHash"`
	Namespace     string `json:"namespace"`
	OrderID       string `json:"orderId"`
	CustomerID    string `json:"customerId"`
	StoreID       string `json:"storeId"`
	CounterID     string `json:"counterId"`
	Method        int64  `json:"method"`
	SourceCommit  string `json:"sourceCommit"`
	HeaderHash    string `json:"headerHash"`
	LineHash      string `json:"lineHash"`
	AsOf          string `json:"asOf"`
}
type importCouponUser struct {
	ID             string `json:"id"`
	Allowed        string `json:"allowed"`
	Used           string `json:"used"`
	MonthlyAllowed string `json:"monthlyAllowed"`
	InputHash      string `json:"inputHash"`
}
type importCouponAllocation struct {
	ID              string `json:"id"`
	ProductID       string `json:"productId"`
	Quantity        int64  `json:"quantity"`
	InputHash       string `json:"inputHash"`
	Discount        string `json:"discount"`
	Refundable      string `json:"refundable"`
	RefundInputHash string `json:"refundInputHash"`
}
type importCouponStaged struct {
	Contract          string             `json:"contract"`
	Scope             importBenefitScope `json:"scope"`
	Trigger           string             `json:"trigger"`
	CouponID          string             `json:"couponId"`
	ConfigurationHash string             `json:"configurationHash"`
	CouponInputHash   string             `json:"couponInputHash"`
	History           struct {
		GenerationID string `json:"generationId"`
		DocumentHash string `json:"documentHash"`
		ScopeHash    string `json:"scopeHash"`
	} `json:"history"`
	BirthdayClaim struct {
		ID          string `json:"id"`
		KeyHash     string `json:"keyHash"`
		ReceiptHash string `json:"receiptHash"`
		ExpiresAt   int64  `json:"expiresAt"`
	} `json:"birthdayClaim"`
	CartCouponDiscount       string                   `json:"cartCouponDiscount"`
	HeaderCouponID           *string                  `json:"headerCouponId"`
	HeaderCouponAmount       *string                  `json:"headerCouponAmount"`
	Consumption              string                   `json:"consumption"`
	CouponUsersBefore        []importCouponUser       `json:"couponUsersBefore"`
	Allocations              []importCouponAllocation `json:"allocations"`
	RefundAllocationContract string                   `json:"refundAllocationContract"`
	RefundSourcePatchHash    string                   `json:"refundSourcePatchHash"`
}
type importCouponChange struct {
	ID        string `json:"id"`
	Before    string `json:"before"`
	After     string `json:"after"`
	InputHash string `json:"inputHash"`
}
type importCouponLog struct {
	ID        string `json:"id"`
	InputHash string `json:"inputHash"`
	Status    int64  `json:"status"`
}
type importCouponConsumption struct {
	Contract               string               `json:"contract"`
	Scope                  importBenefitScope   `json:"scope"`
	StagedReceiptHash      string               `json:"stagedReceiptHash"`
	CouponID               string               `json:"couponId"`
	SourceConfirmationHash string               `json:"sourceConfirmationHash"`
	Changes                []importCouponChange `json:"changes"`
	Log                    importCouponLog      `json:"log"`
}
type importCouponCapture struct {
	stage importCouponStaged
	seal  string
}

// Marshal through a map so nested object keys use the exact Python/Node
// code-point ordering. Struct field declaration order is not a hash protocol.
func importBenefitMAC(key, purpose string, value interface{}) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > 500000 {
		return "", ErrReview
	}
	var original interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&original) != nil {
		return "", ErrReview
	}
	return importMAC(key, "legacy-order-imports.source.benefit."+purpose+".v1", original)
}

func importBenefitDecode(raw []byte, destination interface{}) error {
	if len(raw) == 0 || len(raw) > 500000 {
		return ErrReview
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(destination) != nil {
		return ErrReview
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF {
		return ErrReview
	}
	return nil
}

func importCouponStage(ctx context.Context, tx *sql.Tx, c *importCapability, orderID int64) (*importCouponCapture, error) {
	if c == nil {
		return nil, nil
	}
	var coupon int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(coupon_used,0) FROM orders WHERE id=?`, orderID).Scan(&coupon); err != nil {
		return nil, err
	}
	var status, request, seal string
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT status,request_hash,CASE WHEN OCTET_LENGTH(proof)<=500000 THEN proof ELSE NULL END,proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='coupon-benefit' FOR SHARE`, c.OperationID).Scan(&status, &request, &raw, &seal)
	if err == sql.ErrNoRows && coupon == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	key := os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY")
	if os.Getenv("POS_LEGACY_IMPORT_COUPON_CONSUMPTION_CONTRACT") != ImportCouponConsumptionContract || !ProjectionKeyValid(key, key) || status != "completed" || request != c.RequestHash {
		return nil, ErrReview
	}
	var stage importCouponStaged
	if importBenefitDecode(raw, &stage) != nil {
		return nil, ErrReview
	}
	var original map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&original) != nil || len(original) != 16 {
		return nil, ErrReview
	}
	expected, err := importBenefitMAC(key, "coupon", original)
	if err != nil || !hmac.Equal([]byte(expected), []byte(seal)) {
		return nil, ErrReview
	}
	if stage.Contract != importCouponStageContract || stage.Trigger != "automatic-birthday" ||
		!consentIdentifier(stage.CouponID) || stage.CouponID != strconv.FormatInt(coupon, 10) || coupon > 2147483647 ||
		stage.Consumption != "offline-go-confirmation" || stage.HeaderCouponID == nil || *stage.HeaderCouponID != stage.CouponID ||
		stage.HeaderCouponAmount == nil || *stage.HeaderCouponAmount != stage.CartCouponDiscount || !importBenefitAmount.MatchString(stage.CartCouponDiscount) ||
		!consentDigest.MatchString(stage.ConfigurationHash) || !consentDigest.MatchString(stage.CouponInputHash) ||
		!consentDigest.MatchString(stage.History.GenerationID) || !consentDigest.MatchString(stage.History.DocumentHash) || !consentDigest.MatchString(stage.History.ScopeHash) ||
		!importUUID.MatchString(stage.BirthdayClaim.ID) || !consentDigest.MatchString(stage.BirthdayClaim.KeyHash) || !consentDigest.MatchString(stage.BirthdayClaim.ReceiptHash) || stage.BirthdayClaim.ExpiresAt <= 0 || stage.BirthdayClaim.ExpiresAt > 9007199254740991 ||
		stage.CouponUsersBefore == nil || len(stage.CouponUsersBefore) > 1000 || len(stage.Allocations) < 1 || len(stage.Allocations) > 1000 ||
		stage.RefundAllocationContract != "pos-refund-per-hp-v1" || stage.RefundSourcePatchHash != "e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11" {
		return nil, ErrReview
	}
	s := stage.Scope
	authorityHash, err := importBenefitMAC(key, "authority", c.raw["authority"])
	point, dateErr := time.Parse("2006-01-02 15:04:05", s.AsOf)
	if err != nil || dateErr != nil || point.Format("2006-01-02 15:04:05") != s.AsOf ||
		s.OperationID != c.OperationID || s.RequestHash != c.RequestHash || s.PlanHash != c.PlanHash || s.ActorID != c.Scope.ActorID || s.AuthorityHash != authorityHash ||
		s.Namespace != c.Namespace || s.OrderID != c.OrderID || s.CustomerID != c.Authority.CustomerID || s.StoreID != c.Scope.StoreID || s.CounterID != c.Scope.CounterID ||
		s.Method != 14 || s.SourceCommit != "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5" || !consentDigest.MatchString(s.HeaderHash) || !consentDigest.MatchString(s.LineHash) {
		return nil, ErrReview
	}
	ids := map[string]bool{}
	for _, row := range stage.CouponUsersBefore {
		if !validImportCouponUser(row) || ids[row.ID] {
			return nil, ErrReview
		}
		ids[row.ID] = true
	}
	return &importCouponCapture{stage: stage, seal: seal}, nil
}

func validImportCouponUser(row importCouponUser) bool {
	return consentIdentifier(row.ID) && importBenefitCount.MatchString(row.Allowed) && importBenefitCount.MatchString(row.Used) && importBenefitCount.MatchString(row.MonthlyAllowed) && consentDigest.MatchString(row.InputHash)
}
func readImportCouponUsers(ctx context.Context, tx *sql.Tx, capture *importCouponCapture) ([]importCouponUser, error) {
	values, err := tx.QueryContext(ctx, `SELECT CAST(id AS CHAR),CAST(coupon_allowed_count AS CHAR),CAST(coupon_used_count AS CHAR),CAST(coupon_month_allowed_count AS CHAR),`+ImportCouponUserHashSQL+` FROM coupons_users WHERE user_id=? AND c_id=? ORDER BY id LIMIT 1001 FOR UPDATE`, capture.stage.Scope.CustomerID, capture.stage.CouponID)
	if err != nil {
		return nil, err
	}
	defer values.Close()
	result := []importCouponUser{}
	for values.Next() {
		var row importCouponUser
		if values.Scan(&row.ID, &row.Allowed, &row.Used, &row.MonthlyAllowed, &row.InputHash) != nil || !validImportCouponUser(row) || len(result) >= 1000 {
			return nil, ErrReview
		}
		result = append(result, row)
	}
	return result, values.Err()
}

func lockLegacyImportCoupon(ctx context.Context, tx *sql.Tx, c *importCapability, orderID int64) (*importCouponCapture, error) {
	if c == nil {
		return nil, nil
	}
	capture, err := importCouponStage(ctx, tx, c, orderID)
	if err != nil || capture == nil {
		return nil, err
	}
	if err = verifyImportCouponFrozen(ctx, tx, capture); err != nil {
		return nil, err
	}
	current, err := readImportCouponUsers(ctx, tx, capture)
	if err != nil {
		return nil, err
	}
	if len(current) != len(capture.stage.CouponUsersBefore) {
		return nil, ErrReview
	}
	before := map[string]importCouponUser{}
	for _, row := range capture.stage.CouponUsersBefore {
		before[row.ID] = row
	}
	for _, row := range current {
		if before[row.ID] != row {
			return nil, ErrReview
		}
	}
	logs, err := tx.QueryContext(ctx, `SELECT id FROM order_coupon_log WHERE order_id=? LIMIT 1 FOR UPDATE`, orderID)
	if err != nil {
		return nil, err
	}
	hasLog := logs.Next()
	readErr := logs.Err()
	logs.Close()
	if readErr != nil {
		return nil, readErr
	}
	if hasLog {
		return nil, ErrReview
	}
	if err = verifyImportCouponLines(ctx, tx, capture); err != nil {
		return nil, err
	}
	return capture, nil
}

func verifyImportCouponFrozen(ctx context.Context, tx *sql.Tx, capture *importCouponCapture) error {
	var hash, amount string
	if err := tx.QueryRowContext(ctx, `SELECT `+LegacyImportHeaderSQL+`,CAST(CAST(coupon_amt_used AS DECIMAL(12,2)) AS CHAR) FROM orders WHERE id=?`, capture.stage.Scope.OrderID).Scan(&hash, &amount); err != nil {
		return err
	}
	if hash != capture.stage.Scope.HeaderHash || amount != *capture.stage.HeaderCouponAmount {
		return ErrReview
	}
	// consentBeforeMutation already holds this coupon FOR SHARE. Keep that
	// strength: two customers must never perform a shared→exclusive upgrade.
	if err := tx.QueryRowContext(ctx, `SELECT `+importCouponControlHashSQL+` FROM coupons WHERE id=? FOR SHARE`, capture.stage.CouponID).Scan(&hash); err != nil {
		return err
	}
	if hash != capture.stage.CouponInputHash {
		return ErrReview
	}
	return nil
}

func verifyImportCouponLines(ctx context.Context, tx *sql.Tx, capture *importCouponCapture) error {
	values, err := tx.QueryContext(ctx, `SELECT CAST(id AS CHAR),CAST(prod_id AS CHAR),qty,`+LegacyImportLineSQL+`,CAST(CAST(disc AS DECIMAL(12,2)) AS CHAR),CAST(CAST(amount_to_be_refunded AS DECIMAL(12,2)) AS CHAR),`+importCouponRefundHashSQL+` FROM has_products WHERE order_id=? ORDER BY id LIMIT 1001 FOR SHARE`, capture.stage.Scope.OrderID)
	if err != nil {
		return err
	}
	defer values.Close()
	owned := map[string]importCouponAllocation{}
	for _, row := range capture.stage.Allocations {
		if !consentIdentifier(row.ID) || !consentIdentifier(row.ProductID) || row.Quantity < 1 || row.Quantity > 999 || !consentDigest.MatchString(row.InputHash) || !consentDigest.MatchString(row.RefundInputHash) || !importBenefitAmount.MatchString(row.Discount) || !importBenefitAmount.MatchString(row.Refundable) {
			return ErrReview
		}
		if _, found := owned[row.ID]; found {
			return ErrReview
		}
		owned[row.ID] = row
	}
	lines := []string{}
	for values.Next() {
		var row importCouponAllocation
		if values.Scan(&row.ID, &row.ProductID, &row.Quantity, &row.InputHash, &row.Discount, &row.Refundable, &row.RefundInputHash) != nil || len(lines) >= 1000 || owned[row.ID] != row {
			return ErrReview
		}
		lines = append(lines, row.ID+":"+row.ProductID+":"+strconv.FormatInt(row.Quantity, 10)+":"+row.InputHash)
	}
	if err = values.Err(); err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	if len(lines) != len(owned) || hex.EncodeToString(digest[:]) != capture.stage.Scope.LineHash {
		return ErrReview
	}
	return nil
}

func recordLegacyImportCoupon(ctx context.Context, tx *sql.Tx, c *importCapability, capture *importCouponCapture, confirmationHash string) error {
	if c == nil || capture == nil {
		return nil
	}
	if err := verifyImportCouponFrozen(ctx, tx, capture); err != nil {
		return err
	}
	after, err := readImportCouponUsers(ctx, tx, capture)
	if err != nil {
		return err
	}
	if len(after) != len(capture.stage.CouponUsersBefore) {
		return ErrReview
	}
	old := map[string]importCouponUser{}
	for _, row := range capture.stage.CouponUsersBefore {
		old[row.ID] = row
	}
	changes := []importCouponChange{}
	for _, row := range after {
		before, found := old[row.ID]
		used, parseErr := strconv.ParseUint(before.Used, 10, 64)
		if !found || parseErr != nil || row.Used != strconv.FormatUint(used+1, 10) || row.Allowed != before.Allowed || row.MonthlyAllowed != before.MonthlyAllowed {
			return ErrReview
		}
		changes = append(changes, importCouponChange{row.ID, before.Used, row.Used, row.InputHash})
	}
	log, err := readImportCouponLog(ctx, tx, capture)
	if err != nil {
		return err
	}
	if err = verifyImportCouponLines(ctx, tx, capture); err != nil {
		return err
	}
	proof := importCouponConsumption{ImportCouponConsumptionContract, capture.stage.Scope, capture.seal, capture.stage.CouponID, confirmationHash, changes, log}
	key := os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY")
	seal, err := importBenefitMAC(key, "coupon-consumption", proof)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(proof)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO pos_rewrite_import_financial_source_receipts(id,operation_id,kind,request_hash,status,proof,proof_hash,created_at_ms) VALUES(?,?,'coupon-consume',?,'completed',?,?,?)`, c.OperationID+":coupon-consume", c.OperationID, c.RequestHash, raw, seal, time.Now().UnixMilli())
	return err
}

func readImportCouponLog(ctx context.Context, tx *sql.Tx, capture *importCouponCapture) (importCouponLog, error) {
	values, err := tx.QueryContext(ctx, `SELECT CAST(id AS CHAR),CAST(user_id AS CHAR),CAST(coupon_id AS CHAR),status,`+ImportCouponLogHashSQL+` FROM order_coupon_log WHERE order_id=? ORDER BY id LIMIT 2 FOR SHARE`, capture.stage.Scope.OrderID)
	if err != nil {
		return importCouponLog{}, err
	}
	defer values.Close()
	var log importCouponLog
	var customer, coupon string
	if !values.Next() || values.Scan(&log.ID, &customer, &coupon, &log.Status, &log.InputHash) != nil || values.Next() || values.Err() != nil || !consentIdentifier(log.ID) || !consentDigest.MatchString(log.InputHash) || log.Status != 1 || customer != capture.stage.Scope.CustomerID || coupon != capture.stage.CouponID {
		return importCouponLog{}, ErrReview
	}
	return log, nil
}

func verifyLegacyImportCouponReplay(ctx context.Context, tx *sql.Tx, c *importCapability, orderID int64) error {
	capture, err := importCouponStage(ctx, tx, c, orderID)
	if err != nil || capture == nil {
		return err
	}
	var raw []byte
	var seal, request, status, confirmationHash string
	err = tx.QueryRowContext(ctx, `SELECT CASE WHEN OCTET_LENGTH(proof)<=500000 THEN proof ELSE NULL END,proof_hash,request_hash,status FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='coupon-consume' FOR SHARE`, c.OperationID).Scan(&raw, &seal, &request, &status)
	if err != nil {
		return err
	}
	var proof importCouponConsumption
	if importBenefitDecode(raw, &proof) != nil {
		return ErrReview
	}
	key := os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY")
	expected, err := importBenefitMAC(key, "coupon-consumption", proof)
	if err != nil || !hmac.Equal([]byte(expected), []byte(seal)) || request != c.RequestHash || status != "completed" || proof.Contract != ImportCouponConsumptionContract || proof.Scope != capture.stage.Scope || proof.StagedReceiptHash != capture.seal || proof.CouponID != capture.stage.CouponID || !consentDigest.MatchString(proof.SourceConfirmationHash) || proof.Changes == nil || len(proof.Changes) != len(capture.stage.CouponUsersBefore) {
		return ErrReview
	}
	var confirmationRaw []byte
	if err = tx.QueryRowContext(ctx, `SELECT CASE WHEN OCTET_LENGTH(proof)<=16000 THEN proof ELSE NULL END,proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='confirmation' AND request_hash=? AND status='completed' FOR SHARE`, c.OperationID, c.RequestHash).Scan(&confirmationRaw, &confirmationHash); err != nil {
		return err
	}
	if confirmationHash != proof.SourceConfirmationHash {
		return ErrReview
	}
	var confirmation map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(confirmationRaw))
	decoder.UseNumber()
	if decoder.Decode(&confirmation) != nil || len(confirmation) != 10 {
		return ErrReview
	}
	actual, err := importMAC(key, "legacy-order-imports.source.confirmation.v1", confirmation)
	if err != nil || !hmac.Equal([]byte(actual), []byte(confirmationHash)) ||
		confirmation["contract"] != LegacyImportContract || confirmation["operationId"] != c.OperationID || confirmation["orderId"] != c.OrderID ||
		confirmation["requestHash"] != c.RequestHash || confirmation["nonce"] != c.Nonce || confirmation["customerId"] != c.Authority.CustomerID ||
		confirmation["storeId"] != c.Scope.StoreID || confirmation["counterId"] != c.Scope.CounterID || confirmation["headerHash"] != capture.stage.Scope.HeaderHash {
		return ErrReview
	}
	stamp, ok := confirmation["confirmedAt"].(json.Number)
	if !ok {
		return ErrReview
	}
	confirmedAt, parseErr := stamp.Int64()
	if parseErr != nil || confirmedAt < 1 || confirmedAt > 9007199254740991 {
		return ErrReview
	}
	before := map[string]importCouponUser{}
	for _, row := range capture.stage.CouponUsersBefore {
		before[row.ID] = row
	}
	seen := map[string]bool{}
	for _, row := range proof.Changes {
		old, found := before[row.ID]
		used, parseErr := strconv.ParseUint(old.Used, 10, 64)
		if !found || parseErr != nil || seen[row.ID] || row.Before != old.Used || row.After != strconv.FormatUint(used+1, 10) || !consentDigest.MatchString(row.InputHash) {
			return ErrReview
		}
		seen[row.ID] = true
	}
	log, err := readImportCouponLog(ctx, tx, capture)
	if err != nil {
		return err
	}
	if proof.Log != log {
		return ErrReview
	}
	// Later independent coupon uses legitimately advance the same counters.
	// Replay authenticates the original immutable delta; it never deducts again.
	return nil
}
