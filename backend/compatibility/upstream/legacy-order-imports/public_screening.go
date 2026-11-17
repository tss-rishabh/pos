// Ordinary Node POS origin proof. This is not a CSV financial operation.
package poscheckout

import (
	"bytes"
	"context"
	"crypto/hmac"
	"database/sql"
	"encoding/json"
	"io"
	"strconv"
)

type publicScreeningCreation struct {
	Contract             string            `json:"contract"`
	OperationID          string            `json:"operationId"`
	CheckoutID           string            `json:"checkoutId"`
	CheckoutVersion      int64             `json:"checkoutVersion"`
	ActorID              string            `json:"actorId"`
	CustomerID           string            `json:"customerId"`
	StoreID              string            `json:"storeId"`
	CounterID            string            `json:"counterId"`
	RequestHash          string            `json:"requestHash"`
	CartHash             string            `json:"cartHash"`
	ActorVersion         string            `json:"actorVersion"`
	ActorEpoch           string            `json:"actorEpoch"`
	Contact              ContactBinding    `json:"contact"`
	Source               map[string]string `json:"source"`
	SourceControllerHash string            `json:"sourceControllerHash"`
	OrderID              string            `json:"orderId"`
	Method               int64             `json:"method"`
	LineItemsEnabled     bool              `json:"lineItemsEnabled"`
	Lines                []screeningLine   `json:"lines"`
	Markers              []screeningMarker `json:"markers"`
	EffectsHash          string            `json:"effectsHash"`
	CreatedAt            int64             `json:"createdAt"`
	BenefitsHash         *string           `json:"benefitsHash,omitempty"`
}

func verifyPublicScreeningCreation(ctx context.Context, tx *sql.Tx, state screeningState, key string) error {
	if state.Kind != "pos" || state.SourceReceiptHash == nil || state.OrderID == nil || (state.Phase != "BOUND" && state.Phase != "COUNTED") {
		return ErrReview
	}
	var raw []byte
	var actor, customer, store, counter, order, request, seal, checkout string
	if err := tx.QueryRowContext(ctx, `SELECT checkout_id,actor_id,customer_id,store_id,counter_id,order_id,request_hash,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_public_screening_orders WHERE operation_id=? FOR SHARE`, state.Scope.OperationID).Scan(&checkout, &actor, &customer, &store, &counter, &order, &request, &raw, &seal); err != nil {
		return err
	}
	var value publicScreeningCreation
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil {
		return ErrReview
	}
	var trailing interface{}
	if decoder.Decode(&trailing) != io.EOF {
		return ErrReview
	}
	var original map[string]interface{}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&original) != nil || len(original) != 22 && len(original) != 23 {
		return ErrReview
	}
	_, hasBenefits := original["benefitsHash"]
	if hasBenefits != (value.BenefitsHash != nil) || len(original) != 22+boolCount(hasBenefits) || hasBenefits && !consentDigest.MatchString(*value.BenefitsHash) {
		return ErrReview
	}
	expected, err := importMAC(key, "legacy-order-imports.source.public-screening-creation.v1", original)
	if err != nil || !hmac.Equal([]byte(expected), []byte(seal)) || seal != *state.SourceReceiptHash ||
		value.Contract != "pos-node-screening-creation-v1" || value.OperationID != state.Scope.OperationID ||
		!importUUID.MatchString(value.CheckoutID) || value.CheckoutID != checkout || value.CheckoutVersion < 0 || value.CheckoutVersion > 9007199254740991 ||
		actor != state.Scope.ActorID || actor != value.ActorID || customer != state.CustomerID || customer != value.CustomerID ||
		store != state.Scope.StoreID || store != value.StoreID || counter != state.Scope.CounterID || counter != value.CounterID ||
		order != *state.OrderID || order != value.OrderID || request != state.RequestHash || request != value.RequestHash ||
		value.CartHash != state.CatalogHash || !consentDigest.MatchString(value.ActorVersion) || !consentDigest.MatchString(value.EffectsHash) ||
		!validPublicRevision(value.Contact.Revision) || !validPublicRevision(value.ActorEpoch) || !validContact(value.Contact) ||
		value.SourceControllerHash != "d8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18" ||
		(value.Method != 3 && value.Method != 14) || value.CreatedAt < 1 || value.CreatedAt > 9007199254740991 ||
		value.LineItemsEnabled != state.LineItemsEnabled || len(value.Source) != len(state.Source) || len(value.Lines) != len(state.Lines) || len(value.Markers) != len(state.Markers) {
		return ErrReview
	}
	for name, field := range state.Source {
		if value.Source[name] != field {
			return ErrReview
		}
	}
	for i, line := range state.Lines {
		if value.Lines[i] != line {
			return ErrReview
		}
	}
	for i, marker := range state.Markers {
		if value.Markers[i] != marker {
			return ErrReview
		}
	}
	plan, err := importMAC(key, "legacy-order-imports.source.public-screening-plan.v1", map[string]interface{}{"checkoutId": value.CheckoutID, "checkoutVersion": value.CheckoutVersion, "cartHash": value.CartHash})
	if err != nil || plan != state.PlanHash {
		return ErrReview
	}
	authority, err := importMAC(key, "legacy-order-imports.source.public-screening-authority.v1", map[string]interface{}{
		"actorId": value.ActorID, "actorVersion": value.ActorVersion, "actorEpoch": value.ActorEpoch, "customerId": value.CustomerID,
		"contact": map[string]interface{}{"revision": value.Contact.Revision, "digest": value.Contact.Digest}, "storeId": value.StoreID, "counterId": value.CounterID})
	if err != nil || authority != state.AuthorityHash {
		return ErrReview
	}
	// A release is a separately sealed native tombstone; it never rewrites the
	// original order/markers or claims a provider was refunded.
	var abandoned int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM pos_rewrite_public_screening_abandonments WHERE operation_id=?`, state.Scope.OperationID).Scan(&abandoned); err != nil {
		return err
	}
	if abandoned != 0 {
		return ErrReview
	}
	if value.BenefitsHash != nil {
		if err = verifyPublicBenefitBinding(ctx, tx, value, key); err != nil {
			return err
		}
	}
	return nil
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}

func validPublicRevision(value string) bool {
	if !consentRevision.MatchString(value) {
		return false
	}
	_, err := strconv.ParseUint(value, 10, 64)
	return err == nil
}
