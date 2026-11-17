// Private import and screening confirmation lock boundary. Not installed in a
// source repository. Selection requires the reviewed all-writer capability.
package poscheckout

import (
	"bytes"
	"context"
	"crypto/hmac"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strconv"
	"time"
)

const ImportScreeningContract = "pos-csv-screening-2960-v1"
const ImportScreeningSchemaContract = "pos-screening-schema-v1"
const ImportScreeningWriterContract = "pos-screening-all-writers-v1"
const screeningSKU int64 = 390238

// Literal source predicates, with the verified user-prefix access path forced.
// No joined Order/marker range locks: they invert against a non-ticket wallet
// cancellation and create cross-customer insertion gap locks on empty ranges.
const ScreeningCountSQL = `SELECT STRAIGHT_JOIN COUNT(*) FROM spiderman_screening_orders s FORCE INDEX (idx_user_id) JOIN orders o FORCE INDEX (PRIMARY) ON o.id=s.order_id JOIN has_products hp FORCE INDEX (PRIMARY) ON hp.id=s.has_product_id WHERE s.user_id=? AND hp.prod_id=390238 AND o.order_status NOT IN (0,17)`

type importConfirmationPrelude struct {
	user, store, counter      int64
	operation, binding, actor string
	ticket, customerLocked    bool
	projection                *screeningProjection
}

// The only consistent hint is outside the owned transaction. It grants no
// authority. Current native scope is checked again after the required locks.
func importConfirmationHint(ctx context.Context, db *sql.DB, orderID int64) (*importConfirmationPrelude, error) {
	rows, err := db.QueryContext(ctx, `SELECT o.user_id,os.store_id,os.counter_id,EXISTS(SELECT 1 FROM has_products hp WHERE hp.order_id=o.id AND hp.prod_id=390238),ib.operation_id,ib.status,fo.actor_id FROM orders o JOIN order_stores os ON os.order_id=o.id LEFT JOIN pos_rewrite_import_financial_order_bindings ib ON ib.order_id=CAST(o.id AS CHAR CHARACTER SET ascii) LEFT JOIN pos_rewrite_import_financial_operations fo ON fo.id=ib.operation_id WHERE o.id=? LIMIT 2`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	p := &importConfirmationPrelude{}
	var operation, status, actor sql.NullString
	if !rows.Next() {
		if err = rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrReview
	}
	if err = rows.Scan(&p.user, &p.store, &p.counter, &p.ticket, &operation, &status, &actor); err != nil {
		return nil, err
	}
	if rows.Next() || rows.Err() != nil || p.user < 1 || p.store < 1 || p.counter < 1 {
		return nil, ErrReview
	}
	if operation.Valid {
		if !importUUID.MatchString(operation.String) || !actor.Valid || !consentIdentifier(actor.String) || (status.String != "held" && status.String != "completed") {
			return nil, ErrReview
		}
		p.operation, p.binding, p.actor = operation.String, status.String, actor.String
	}
	return p, nil
}

func screeningSelected() bool {
	return os.Getenv("POS_LEGACY_IMPORT_SCREENING_CONTRACT") == ImportScreeningContract &&
		os.Getenv("POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT") == ImportScreeningSchemaContract &&
		os.Getenv("POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT") == ImportScreeningWriterContract &&
		ProjectionKeyValid(os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY"), os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY"))
}

func beginImportConfirmation(ctx context.Context, db *sql.DB, orderID int64) (*sql.Tx, *importConfirmationPrelude, error) {
	p, err := importConfirmationHint(ctx, db, orderID)
	if err != nil {
		return nil, nil, err
	}
	state, _ := ctx.Value(importContextKey{}).(importContext)
	if state.invalid {
		return nil, nil, ErrReview
	}
	if p.ticket && !screeningSelected() {
		return nil, nil, ErrReview
	}
	if p.operation != "" && p.binding == "held" {
		c := state.value
		if c == nil || c.OperationID != p.operation || c.OrderID != strconv.FormatInt(orderID, 10) ||
			c.Scope.ActorID != p.actor || c.Scope.StoreID != strconv.FormatInt(p.store, 10) ||
			c.Scope.CounterID != strconv.FormatInt(p.counter, 10) || c.Authority.CustomerID != strconv.FormatInt(p.user, 10) {
			return nil, nil, ErrReview
		}
	}
	isolation := sql.LevelRepeatableRead
	if p.ticket || p.operation != "" {
		isolation = sql.LevelReadCommitted
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: isolation})
	if err != nil {
		return nil, nil, err
	}
	fail := func(err error) (*sql.Tx, *importConfirmationPrelude, error) { tx.Rollback(); return nil, nil, err }
	if !p.ticket && p.operation == "" {
		return tx, p, nil
	}
	// Every SELECT before the customer is a current locking read. Owned RC also
	// prevents absent control-proof next-key gaps between different customers.
	if p.actor != "" {
		for _, query := range []string{`SELECT id FROM pos_user WHERE id=? FOR SHARE`, `SELECT epoch FROM pos_rewrite_operator_auth_epochs WHERE operator_id=? FOR SHARE`} {
			var ignored string
			if err = tx.QueryRowContext(ctx, query, p.actor).Scan(&ignored); err != nil && err != sql.ErrNoRows {
				return fail(err)
			}
		}
	}
	var found int64
	if err = tx.QueryRowContext(ctx, `SELECT id FROM stores WHERE id=? FOR UPDATE`, p.store).Scan(&found); err != nil {
		return fail(err)
	}
	if p.operation != "" {
		var actor, store, counter string
		if err = tx.QueryRowContext(ctx, `SELECT actor_id,store_id,counter_id FROM pos_rewrite_import_financial_operations WHERE id=? FOR UPDATE`, p.operation).Scan(&actor, &store, &counter); err != nil {
			return fail(err)
		}
		if actor != p.actor || store != strconv.FormatInt(p.store, 10) || counter != strconv.FormatInt(p.counter, 10) {
			return fail(ErrReview)
		}
	}
	if err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE id=? FOR UPDATE`, p.user).Scan(&found); err != nil {
		return fail(err)
	}
	p.customerLocked = true
	return tx, p, nil
}

func validateImportConfirmation(ctx context.Context, tx *sql.Tx, p *importConfirmationPrelude, order, user, store, counter int64) error {
	if p == nil || p.user != user || p.store != store || p.counter != counter {
		return ErrReview
	}
	var ticket bool
	// The Order lock prevents a cooperating structural writer changing its HPs.
	// For selected ticket/import paths this first view is after the customer.
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM has_products WHERE order_id=? AND prod_id=390238)`, order).Scan(&ticket); err != nil {
		return err
	}
	if ticket != p.ticket || ticket && !p.customerLocked {
		return ErrReview
	}
	var operation, status string
	err := tx.QueryRowContext(ctx, `SELECT operation_id,status FROM pos_rewrite_import_financial_order_bindings WHERE order_id=? FOR SHARE`, strconv.FormatInt(order, 10)).Scan(&operation, &status)
	if err == sql.ErrNoRows {
		if p.operation != "" {
			return ErrReview
		}
		return nil
	}
	if err != nil {
		return err
	}
	if operation != p.operation || status != p.binding || !p.customerLocked {
		return ErrReview
	}
	return nil
}

// This runs after all stock/wallet/provenance waits, immediately before source
// Apply. Original immutable proof replay does not create a new financial act.
func beforeImportMutation(ctx context.Context, tx *sql.Tx, p *importConfirmationPrelude, c *importCapability) error {
	if c != nil && (c.IssuedAt > time.Now().UnixMilli() || c.ExpiresAt <= time.Now().UnixMilli()) {
		return ErrReview
	}
	if p == nil || !p.ticket {
		return nil
	}
	if !p.customerLocked || !screeningSelected() {
		return ErrReview
	}
	var found int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM stores WHERE id=? AND is_active=1 AND type IN ('STORE','CORE_WAREHOUSE') FOR SHARE`, p.store).Scan(&found); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM store_counters WHERE id=? AND store_id=? AND is_active=1 FOR SHARE`, p.counter, p.store).Scan(&found); err != nil {
		return err
	}
	return nil
}

type screeningScope struct {
	ActorID     string `json:"actorId"`
	OperationID string `json:"operationId"`
	StoreID     string `json:"storeId"`
	CounterID   string `json:"counterId"`
}
type screeningLine struct {
	ID       string `json:"id"`
	Quantity int64  `json:"quantity"`
}
type screeningMarker struct {
	ID     string `json:"id"`
	LineID string `json:"lineId"`
}
type screeningState struct {
	Contract          string            `json:"contract"`
	Scope             screeningScope    `json:"scope"`
	Source            map[string]string `json:"source"`
	CustomerID        string            `json:"customerId"`
	SKU               string            `json:"sku"`
	Kind              string            `json:"kind"`
	PlanHash          string            `json:"planHash"`
	RequestHash       string            `json:"requestHash"`
	AuthorityHash     string            `json:"authorityHash"`
	CatalogHash       string            `json:"catalogHash"`
	Quantity          int64             `json:"quantity"`
	LineItemsEnabled  bool              `json:"lineItemsEnabled"`
	MarkerRows        int64             `json:"markerRows"`
	SourceCountBefore string            `json:"sourceCountBefore"`
	PendingBefore     int64             `json:"pendingBefore"`
	Phase             string            `json:"phase"`
	OrderID           *string           `json:"orderId"`
	Lines             []screeningLine   `json:"lines"`
	Markers           []screeningMarker `json:"markers"`
	SourceReceiptHash *string           `json:"sourceReceiptHash"`
	CompletionHash    *string           `json:"completionHash"`
	RejectionHash     *string           `json:"rejectionHash"`
	Version           int64             `json:"version"`
	CreatedAt         int64             `json:"createdAt"`
	UpdatedAt         int64             `json:"updatedAt"`
}

func checkedScreeningState(raw []byte, seal, operation, customer, sku string, order sql.NullString, key string) (screeningState, error) {
	var value screeningState
	bad := func() (screeningState, error) { return value, ErrReview }
	if len(raw) > 16000 || len(seal) != 64 {
		return bad()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil {
		return bad()
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF {
		return bad()
	}
	var original map[string]interface{}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&original) != nil || len(original) != 25 {
		return bad()
	}
	expected, err := importMAC(key, "legacy-order-imports.source.screening-state.v1", original)
	if err != nil || !hmac.Equal([]byte(expected), []byte(seal)) {
		return bad()
	}
	if value.Contract != ImportScreeningContract || value.SKU != "390238" || sku != value.SKU || value.CustomerID != customer || !consentIdentifier(customer) ||
		value.Scope.OperationID != operation || !importUUID.MatchString(operation) || !consentIdentifier(value.Scope.ActorID) || !consentIdentifier(value.Scope.StoreID) || !consentIdentifier(value.Scope.CounterID) ||
		len(value.Source) != 4 || value.Source["apiCommit"] != "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5" ||
		value.Source["helperHash"] != "a3ec2d593ddfb990b6462fe4f71a8c70f5aa7b95a6704ffb4a0566b14e515e46" ||
		value.Source["controllerHash"] != "821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad" ||
		value.Source["modelHash"] != "d9ee1cd52546e9d8dce0952e901ecba0d58fe1c1b68d95149781131e1553fca5" ||
		(value.Kind != "offline" && value.Kind != "shopify") || !consentDigest.MatchString(value.PlanHash) || !consentDigest.MatchString(value.RequestHash) ||
		!consentDigest.MatchString(value.AuthorityHash) || !consentDigest.MatchString(value.CatalogHash) || value.Quantity < 1 || value.Quantity > 2 ||
		value.PendingBefore < 0 || value.PendingBefore > 2000 || value.Version < 1 || value.Version > 9007199254740991 || value.CreatedAt < 1 || value.UpdatedAt < value.CreatedAt || value.UpdatedAt > 9007199254740991 {
		return bad()
	}
	if matched, _ := regexp.MatchString(`^(0|[1-9][0-9]{0,19})$`, value.SourceCountBefore); !matched {
		return bad()
	}
	if _, err = strconv.ParseUint(value.SourceCountBefore, 10, 64); err != nil {
		return bad()
	}
	markers := int64(1)
	if value.LineItemsEnabled {
		markers = value.Quantity
	}
	if value.MarkerRows != markers {
		return bad()
	}
	bound := value.Phase == "BOUND" || value.Phase == "COUNTED"
	if value.Phase != "RESERVED" && value.Phase != "BOUND" && value.Phase != "COUNTED" && value.Phase != "REJECTED" {
		return bad()
	}
	if bound != (value.OrderID != nil) || bound != order.Valid || bound && (*value.OrderID != order.String || !consentIdentifier(*value.OrderID)) ||
		bound && (int64(len(value.Lines)) != markers || int64(len(value.Markers)) != markers) || !bound && (len(value.Lines) != 0 || len(value.Markers) != 0 || value.SourceReceiptHash != nil) ||
		(value.Phase == "COUNTED") != (value.CompletionHash != nil) || value.Phase == "COUNTED" && value.SourceReceiptHash == nil || (value.Phase == "REJECTED") != (value.RejectionHash != nil) {
		return bad()
	}
	for _, hash := range []*string{value.SourceReceiptHash, value.CompletionHash, value.RejectionHash} {
		if hash != nil && !consentDigest.MatchString(*hash) {
			return bad()
		}
	}
	lineIDs := map[string]bool{}
	markerIDs := map[string]bool{}
	marked := map[string]bool{}
	var qty int64
	for _, line := range value.Lines {
		if !consentIdentifier(line.ID) || lineIDs[line.ID] || line.Quantity < 1 || line.Quantity > 2 {
			return bad()
		}
		lineIDs[line.ID] = true
		qty += line.Quantity
	}
	for _, marker := range value.Markers {
		if !consentIdentifier(marker.ID) || markerIDs[marker.ID] || marked[marker.LineID] || !lineIDs[marker.LineID] {
			return bad()
		}
		markerIDs[marker.ID] = true
		marked[marker.LineID] = true
	}
	if bound && qty != value.Quantity {
		return bad()
	}
	return value, nil
}

type screeningProjection struct {
	lines    []screeningLine
	markers  []screeningMarker
	included bool
}

func sameScreeningProjection(a, b *screeningProjection) bool {
	if a == nil || b == nil || len(a.lines) != len(b.lines) || len(a.markers) != len(b.markers) {
		return false
	}
	for i, v := range a.lines {
		if v != b.lines[i] {
			return false
		}
	}
	for i, v := range a.markers {
		if v != b.markers[i] {
			return false
		}
	}
	return true
}
func readScreeningProjection(ctx context.Context, tx *sql.Tx, order, customer, store, counter string) (*screeningProjection, error) {
	p := &screeningProjection{}
	var owner int64
	var status sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT user_id,order_status FROM orders WHERE id=?`, order).Scan(&owner, &status); err != nil {
		return nil, err
	}
	if strconv.FormatInt(owner, 10) != customer {
		return nil, ErrReview
	}
	p.included = status.Valid && status.Int64 != 0 && status.Int64 != 17
	rows, err := tx.QueryContext(ctx, `SELECT store_id,counter_id FROM order_stores WHERE order_id=? LIMIT 2`, order)
	if err != nil {
		return nil, err
	}
	var s, c int64
	if !rows.Next() {
		rows.Close()
		return nil, ErrReview
	}
	if err = rows.Scan(&s, &c); err != nil {
		rows.Close()
		return nil, err
	}
	duplicate := rows.Next()
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return nil, readErr
	}
	if duplicate || strconv.FormatInt(s, 10) != store || strconv.FormatInt(c, 10) != counter {
		return nil, ErrReview
	}
	rows, err = tx.QueryContext(ctx, `SELECT id,qty,sub_prod_id FROM has_products WHERE order_id=? AND prod_id=390238 ORDER BY id LIMIT 3`, order)
	if err != nil {
		return nil, err
	}
	var quantity int64
	for rows.Next() {
		var id, qty int64
		var sub sql.NullInt64
		if err = rows.Scan(&id, &qty, &sub); err != nil {
			rows.Close()
			return nil, err
		}
		if id < 1 || qty < 1 || qty > 2 || !sub.Valid || sub.Int64 != 0 {
			rows.Close()
			return nil, ErrReview
		}
		p.lines = append(p.lines, screeningLine{strconv.FormatInt(id, 10), qty})
		quantity += qty
	}
	readErr = rows.Err()
	rows.Close()
	if readErr != nil {
		return nil, readErr
	}
	if len(p.lines) < 1 || len(p.lines) > 2 || quantity > 2 {
		return nil, ErrReview
	}
	rows, err = tx.QueryContext(ctx, `SELECT id,has_product_id,user_id FROM spiderman_screening_orders FORCE INDEX (idx_order_id) WHERE order_id=? ORDER BY id LIMIT 3`, order)
	if err != nil {
		return nil, err
	}
	matched := map[string]bool{}
	for rows.Next() {
		var id, line, user int64
		if err = rows.Scan(&id, &line, &user); err != nil {
			rows.Close()
			return nil, err
		}
		lineID := strconv.FormatInt(line, 10)
		valid := false
		for _, v := range p.lines {
			if v.ID == lineID {
				valid = true
			}
		}
		if id < 1 || !valid || matched[lineID] || strconv.FormatInt(user, 10) != customer {
			rows.Close()
			return nil, ErrReview
		}
		matched[lineID] = true
		p.markers = append(p.markers, screeningMarker{strconv.FormatInt(id, 10), lineID})
	}
	readErr = rows.Err()
	rows.Close()
	if readErr != nil {
		return nil, readErr
	}
	if len(p.markers) != len(p.lines) {
		return nil, ErrReview
	}
	return p, nil
}

func checkScreeningConfirmation(ctx context.Context, tx *sql.Tx, p *importConfirmationPrelude, c *importCapability, orderID int64) error {
	if p == nil || !p.ticket {
		return nil
	}
	if !p.customerLocked || !screeningSelected() {
		return ErrReview
	}
	key := os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY")
	own, err := readScreeningProjection(ctx, tx, strconv.FormatInt(orderID, 10), strconv.FormatInt(p.user, 10), strconv.FormatInt(p.store, 10), strconv.FormatInt(p.counter, 10))
	if err != nil {
		return err
	}
	if p.projection != nil && !sameScreeningProjection(p.projection, own) {
		return ErrReview
	}
	var bought uint64
	if err = tx.QueryRowContext(ctx, ScreeningCountSQL, p.user).Scan(&bought); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT operation_id,customer_id,sku,order_id,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_import_screening_reservations FORCE INDEX (ix_import_screening_customer) WHERE customer_id=? AND sku='390238' ORDER BY operation_id LIMIT 1001`, strconv.FormatInt(p.user, 10))
	if err != nil {
		return err
	}
	var states []screeningState
	for rows.Next() {
		var operation, customer, sku, seal string
		var order sql.NullString
		var raw []byte
		if err = rows.Scan(&operation, &customer, &sku, &order, &raw, &seal); err != nil {
			rows.Close()
			return err
		}
		value, e := checkedScreeningState(raw, seal, operation, customer, sku, order, key)
		if e != nil {
			rows.Close()
			return e
		}
		states = append(states, value)
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return readErr
	}
	if len(states) > 1000 {
		return ErrReview
	}
	var pending uint64
	found := false
	for _, value := range states {
		if value.Phase == "RESERVED" {
			pending += uint64(value.MarkerRows)
			continue
		}
		if value.Phase != "BOUND" && value.Phase != "COUNTED" {
			continue
		}
		projection, e := readScreeningProjection(ctx, tx, *value.OrderID, value.CustomerID, value.Scope.StoreID, value.Scope.CounterID)
		if e != nil {
			return e
		}
		if len(projection.lines) != len(value.Lines) || len(projection.markers) != len(value.Markers) {
			return ErrReview
		}
		for i, line := range value.Lines {
			if line != projection.lines[i] {
				return ErrReview
			}
		}
		for i, marker := range value.Markers {
			if marker != projection.markers[i] {
				return ErrReview
			}
		}
		if value.Phase == "BOUND" && !projection.included {
			pending += uint64(value.MarkerRows)
		}
		if *value.OrderID == strconv.FormatInt(orderID, 10) {
			if p.binding == "completed" && c == nil {
				if value.Phase != "COUNTED" || value.Kind != "offline" || value.Scope.OperationID != p.operation || value.Scope.ActorID != p.actor || value.Scope.StoreID != strconv.FormatInt(p.store, 10) || value.Scope.CounterID != strconv.FormatInt(p.counter, 10) {
					return ErrReview
				}
				var raw []byte
				if e = tx.QueryRowContext(ctx, `SELECT data FROM pos_rewrite_import_financial_proofs WHERE operation_id=? AND order_id=? AND request_hash=? AND OCTET_LENGTH(data)<=1000000 FOR SHARE`, p.operation, *value.OrderID, value.RequestHash).Scan(&raw); e != nil {
					return e
				}
				var completed map[string]interface{}
				decoder := json.NewDecoder(bytes.NewReader(raw))
				decoder.UseNumber()
				if decoder.Decode(&completed) != nil {
					return ErrReview
				}
				expected, e := importMAC(key, "legacy-order-imports.source.screening-completion.v1", completed)
				if e != nil || value.CompletionHash == nil || !hmac.Equal([]byte(expected), []byte(*value.CompletionHash)) {
					return ErrReview
				}
				found = true
				continue
			}
			if c == nil || value.Phase != "BOUND" || value.Kind != "offline" || value.Scope.OperationID != c.OperationID || value.Scope.ActorID != c.Scope.ActorID || value.Scope.StoreID != c.Scope.StoreID || value.Scope.CounterID != c.Scope.CounterID ||
				value.RequestHash != c.RequestHash || value.PlanHash != c.PlanHash || value.SourceReceiptHash == nil {
				return ErrReview
			}
			authorityHash, e := importMAC(key, "legacy-order-imports.source.screening-authority.v1", c.raw["authority"])
			if e != nil || authorityHash != value.AuthorityHash {
				return ErrReview
			}
			var raw []byte
			var seal, status, request string
			if e = tx.QueryRowContext(ctx, `SELECT proof,proof_hash,status,request_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='order' AND OCTET_LENGTH(proof)<=1000000 FOR SHARE`, c.OperationID).Scan(&raw, &seal, &status, &request); e != nil {
				return e
			}
			var proof map[string]interface{}
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			if decoder.Decode(&proof) != nil {
				return ErrReview
			}
			expected, e := importMAC(key, "legacy-order-imports.source.order.v1", proof)
			if e != nil || !hmac.Equal([]byte(expected), []byte(seal)) || seal != *value.SourceReceiptHash || status != "completed" || request != c.RequestHash || proof["orderId"] != c.OrderID || proof["customerId"] != c.Authority.CustomerID || proof["requestHash"] != c.RequestHash {
				return ErrReview
			}
			if value.LineItemsEnabled {
				for _, line := range value.Lines {
					if line.Quantity != 1 {
						return ErrReview
					}
				}
			}
			found = true
		}
	}
	if p.operation != "" && !found {
		return ErrReview
	}
	if p.operation == "" && !own.included {
		pending += uint64(len(own.markers))
	}
	if bought > 2 || pending > 2 || bought+pending > 2 {
		return ErrReview
	}
	p.projection = own
	return nil
}
