// Narrow immutable public-benefit ABI. Source/native membership, gift,
// consent and funding verification remain independent confirmation gates.
package poscheckout

import (
	"bytes"
	"context"
	"crypto/hmac"
	"database/sql"
	"encoding/json"
	"io"
	"regexp"
)

type publicBenefitState struct {
	Attribute string  `json:"attribute"`
	Value     *string `json:"value"`
	Active    int     `json:"active"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
	Hash      string  `json:"hash"`
}
type publicBenefitProvenance struct {
	OrderID      string               `json:"orderId"`
	CustomerID   string               `json:"customerId"`
	Revision     string               `json:"revision"`
	HeaderHash   string               `json:"headerHash"`
	Before       []publicBenefitState `json:"before"`
	Confirmed    []publicBenefitState `json:"confirmed"`
	Contract     string               `json:"contract"`
	OperationID  string               `json:"operationId"`
	CreatedAt    string               `json:"createdAt"`
	EntityDigest string               `json:"entityDigest"`
	ProofHash    string               `json:"proofHash"`
}
type publicBenefitMembership struct {
	Kind               string                  `json:"kind"`
	ProductID          string                  `json:"productId"`
	LineID             string                  `json:"lineId"`
	Eligibility        string                  `json:"eligibility"`
	Provenance         publicBenefitProvenance `json:"provenance"`
	CacheInvalidations int                     `json:"cacheInvalidations"`
	HistoryEvidence    *struct {
		GenerationID string `json:"generationId"`
		FetchedAt    int64  `json:"fetchedAt"`
		Signature    string `json:"signature"`
		AsOf         string `json:"asOf"`
		Cutoff       string `json:"cutoff"`
	} `json:"historyEvidence"`
	Replacement *struct {
		SourceAction         string `json:"sourceAction"`
		OriginalProductID    string `json:"originalProductId"`
		ReplacementProductID string `json:"replacementProductId"`
	} `json:"replacement,omitempty"`
}
type publicBenefitGift struct {
	ProductID     string `json:"productId"`
	Serial        string `json:"serial"`
	CollectionID  string `json:"collectionId"`
	InitialAmount string `json:"initialAmount"`
	VoucherID     string `json:"voucherId"`
	LineID        string `json:"lineId"`
	InputHash     string `json:"inputHash"`
}
type publicBenefitDescriptor struct {
	Contract    string                   `json:"contract"`
	OperationID string                   `json:"operationId"`
	CheckoutID  string                   `json:"checkoutId"`
	ActorID     string                   `json:"actorId"`
	CustomerID  string                   `json:"customerId"`
	StoreID     string                   `json:"storeId"`
	CounterID   string                   `json:"counterId"`
	RequestHash string                   `json:"requestHash"`
	CartHash    string                   `json:"cartHash"`
	OrderID     string                   `json:"orderId"`
	Membership  *publicBenefitMembership `json:"membership"`
	Gifts       []publicBenefitGift      `json:"gifts"`
	CreatedAt   int64                    `json:"createdAt"`
}
type publicBenefitIntent struct {
	V                     int            `json:"v"`
	Contract              string         `json:"contract"`
	OperationID           string         `json:"operationId"`
	CheckoutID            string         `json:"checkoutId"`
	CheckoutVersion       int64          `json:"checkoutVersion"`
	ActorID               string         `json:"actorId"`
	ActorVersion          string         `json:"actorVersion"`
	ActorEpoch            string         `json:"actorEpoch"`
	CustomerID            string         `json:"customerId"`
	Contact               ContactBinding `json:"contact"`
	StoreID               string         `json:"storeId"`
	CounterID             string         `json:"counterId"`
	CartHash              string         `json:"cartHash"`
	RequestHash           string         `json:"requestHash"`
	IssuedAt              int64          `json:"issuedAt"`
	ExpiresAt             int64          `json:"expiresAt"`
	BenefitsContract      *string        `json:"benefitsContract,omitempty"`
	MembershipHistoryHash *string        `json:"membershipHistoryHash,omitempty"`
}

func publicBenefitDocument(raw []byte, limit int, kind, key, seal string, target interface{}) (map[string]interface{}, error) {
	if len(raw) < 2 || len(raw) > limit {
		return nil, ErrReview
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return nil, ErrReview
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF {
		return nil, ErrReview
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value map[string]interface{}
	if decoder.Decode(&value) != nil {
		return nil, ErrReview
	}
	signed, err := importMAC(key, "legacy-order-imports.source."+kind+".v1", value)
	if err != nil || !hmac.Equal([]byte(signed), []byte(seal)) {
		return nil, ErrReview
	}
	return value, nil
}
func publicBenefitKeys(value interface{}, required []string, optional ...string) bool {
	object, ok := value.(map[string]interface{})
	if !ok {
		return false
	}
	allowed := map[string]bool{}
	for _, name := range required {
		allowed[name] = true
		if _, present := object[name]; !present {
			return false
		}
	}
	for _, name := range optional {
		allowed[name] = true
	}
	for name := range object {
		if !allowed[name] {
			return false
		}
	}
	return true
}
func publicBenefitShape(value map[string]interface{}) bool {
	if !publicBenefitKeys(value, []string{"contract", "operationId", "checkoutId", "actorId", "customerId", "storeId", "counterId", "requestHash", "cartHash", "orderId", "membership", "gifts", "createdAt"}) {
		return false
	}
	if value["membership"] != nil {
		if !publicBenefitKeys(value["membership"], []string{"kind", "productId", "lineId", "eligibility", "provenance", "cacheInvalidations", "historyEvidence"}, "replacement") {
			return false
		}
		member := value["membership"].(map[string]interface{})
		if !publicBenefitKeys(member["provenance"], []string{"orderId", "customerId", "revision", "headerHash", "before", "confirmed", "contract", "operationId", "createdAt", "entityDigest", "proofHash"}) {
			return false
		}
		proof := member["provenance"].(map[string]interface{})
		for _, name := range []string{"before", "confirmed"} {
			states, ok := proof[name].([]interface{})
			if !ok || len(states) > 2 || name == "confirmed" && len(states) != 2 || name == "before" && len(states) != 0 && len(states) != 2 {
				return false
			}
			for _, state := range states {
				if !publicBenefitKeys(state, []string{"attribute", "value", "active", "createdAt", "updatedAt", "hash"}) {
					return false
				}
			}
		}
		if member["historyEvidence"] != nil && !publicBenefitKeys(member["historyEvidence"], []string{"generationId", "fetchedAt", "signature", "asOf", "cutoff"}) {
			return false
		}
		if replacement, present := member["replacement"]; present && (replacement == nil || !publicBenefitKeys(replacement, []string{"sourceAction", "originalProductId", "replacementProductId"})) {
			return false
		}
	}
	gifts, ok := value["gifts"].([]interface{})
	if !ok || len(gifts) > 100 {
		return false
	}
	for _, gift := range gifts {
		if !publicBenefitKeys(gift, []string{"productId", "serial", "collectionId", "initialAmount", "voucherId", "lineId", "inputHash"}) {
			return false
		}
	}
	return true
}
func verifyPublicBenefitBinding(ctx context.Context, tx *sql.Tx, creation publicScreeningCreation, key string) error {
	if creation.BenefitsHash == nil {
		return nil
	}
	var raw []byte
	var order, seal string
	if err := tx.QueryRowContext(ctx, `SELECT order_id,CASE WHEN OCTET_LENGTH(data)<=64000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_public_screening_benefits WHERE operation_id=? FOR SHARE`, creation.OperationID).Scan(&order, &raw, &seal); err != nil {
		return err
	}
	if order != creation.OrderID || seal != *creation.BenefitsHash {
		return ErrReview
	}
	var descriptor publicBenefitDescriptor
	value, err := publicBenefitDocument(raw, 64000, "public-screening-benefits", key, seal, &descriptor)
	if err != nil || !publicBenefitShape(value) {
		return ErrReview
	}
	if descriptor.Contract != "pos-node-screening-benefits-v1" || descriptor.OperationID != creation.OperationID || descriptor.CheckoutID != creation.CheckoutID || descriptor.ActorID != creation.ActorID || descriptor.CustomerID != creation.CustomerID || descriptor.StoreID != creation.StoreID || descriptor.CounterID != creation.CounterID || descriptor.RequestHash != creation.RequestHash || descriptor.CartHash != creation.CartHash || descriptor.OrderID != creation.OrderID || descriptor.CreatedAt < 1 || descriptor.CreatedAt > 9007199254740991 || descriptor.Gifts == nil || len(descriptor.Gifts) > 100 {
		return ErrReview
	}
	for _, gift := range descriptor.Gifts {
		if !consentIdentifier(gift.ProductID) || !consentIdentifier(gift.Serial) || !consentIdentifier(gift.CollectionID) || !consentIdentifier(gift.VoucherID) || !consentIdentifier(gift.LineID) || !consentDigest.MatchString(gift.InputHash) || !regexp.MustCompile(`^(0|[1-9][0-9]{0,9})\.[0-9]{2}$`).MatchString(gift.InitialAmount) {
			return ErrReview
		}
	}
	if member := descriptor.Membership; member != nil {
		if (member.Kind != "new" && member.Kind != "upgrade" && member.Kind != "auto-free") || !consentIdentifier(member.ProductID) || !consentIdentifier(member.LineID) || member.CacheInvalidations < 0 || member.CacheInvalidations > 100 || member.Provenance.OrderID != creation.OrderID || member.Provenance.CustomerID != creation.CustomerID || member.Provenance.OperationID != creation.OperationID {
			return ErrReview
		}
		if member.Eligibility != "not-added" && member.Eligibility != "source-cart-over-2000" && member.Eligibility != "source-qualified-history" && member.Eligibility != "no-ordinary-items" {
			return ErrReview
		}
		if member.Replacement != nil && (member.Replacement.SourceAction != "AddFreeMembership.remove_exclusive_membership" || !consentIdentifier(member.Replacement.OriginalProductID) || member.Replacement.ReplacementProductID != member.ProductID) {
			return ErrReview
		}
	}
	if err = tx.QueryRowContext(ctx, `SELECT CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_public_screening_work WHERE operation_id=? FOR SHARE`, creation.OperationID).Scan(&raw, &seal); err != nil {
		return err
	}
	var intent publicBenefitIntent
	saved, err := publicBenefitDocument(raw, 16000, "public-screening-intent", key, seal, &intent)
	if err != nil {
		return err
	}
	_, contractPresent := saved["benefitsContract"]
	_, historyPresent := saved["membershipHistoryHash"]
	if len(saved) != 16+boolCount(contractPresent)+boolCount(historyPresent) || !contractPresent || intent.BenefitsContract == nil || *intent.BenefitsContract != "pos-node-screening-benefits-v1" || historyPresent != (intent.MembershipHistoryHash != nil) || intent.MembershipHistoryHash != nil && !consentDigest.MatchString(*intent.MembershipHistoryHash) {
		return ErrReview
	}
	if intent.V != 1 || intent.Contract != "pos-node-screening-writer-v1" || intent.OperationID != creation.OperationID || intent.CheckoutID != creation.CheckoutID || intent.CheckoutVersion != creation.CheckoutVersion || intent.ActorID != creation.ActorID || intent.ActorVersion != creation.ActorVersion || intent.ActorEpoch != creation.ActorEpoch || intent.CustomerID != creation.CustomerID || intent.Contact != creation.Contact || intent.StoreID != creation.StoreID || intent.CounterID != creation.CounterID || intent.CartHash != creation.CartHash || intent.RequestHash != creation.RequestHash || intent.IssuedAt < 1 || intent.ExpiresAt <= intent.IssuedAt || intent.ExpiresAt-intent.IssuedAt > 60000 {
		return ErrReview
	}
	// No current contact, flags or entitlement/history query: retained intent and
	// descriptor are immutable ABI bindings, never a renewed grant or payment.
	return nil
}
