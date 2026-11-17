package poscheckout

import (
	"context"
	"crypto/hmac"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"
)

type OriginPaymentInput struct {
	Order         int64           `json:"order"`
	Method        int64           `json:"method"`
	PaymentMethod string          `json:"payment_method,omitempty"`
	Platform      string          `json:"platform,omitempty"`
	OS            string          `json:"os,omitempty"`
	IsValid       *bool           `json:"isValid,omitempty"`
	Name          string          `json:"name,omitempty"`
	Original      json.RawMessage `json:"-"`
}
type OriginProviderRequest struct {
	Provider       string              `json:"provider"`
	OrderID        string              `json:"orderId"`
	CustomerID     string              `json:"customerId"`
	StockMode      string              `json:"stockMode"`
	CustomerFields map[string]string   `json:"customerFields"`
	OrderFields    map[string]string   `json:"orderFields"`
	CouponPolicy   *OriginCouponPolicy `json:"couponPolicy,omitempty"`
}
type OriginProviderResponse struct {
	OrderID           string          `json:"orderId"`
	Status            string          `json:"status"`
	ProviderReference string          `json:"providerReference"`
	ClientAuthToken   string          `json:"clientAuthToken"`
	ClientResponse    json.RawMessage `json:"clientResponse"`
	AmountPaise       int64           `json:"amountPaise"`
	GatewayID         int64           `json:"gatewayId"`
	GatewayReference  string          `json:"gatewayReference"`
	EvidenceHash      string          `json:"evidenceHash"`
	ObservedAt        int64           `json:"observedAt"`
	Route             string          `json:"route"`
	LogStatus         string          `json:"logStatus"`
	ProviderMessage   string          `json:"providerMessage,omitempty"`
}
type OriginProvider interface {
	// Start is called once after a durable SENDING checkpoint, outside SQL.
	Start(context.Context, OriginProviderRequest) (OriginProviderResponse, error)
	// Recover must use the original provider order reference and GET only.
	Recover(context.Context, OriginProviderRequest) (OriginProviderResponse, error)
}
type OriginApplyContext struct {
	Command     OriginCommand
	Creation    OriginCreation
	Observation OriginProviderResponse
	RequestID   string
	StockMode   string
	Provider    string
}
type OriginApply func(context.Context, *sql.Tx, OriginApplyContext, *OriginEffectCollector) error
type OriginBuildRequest func(context.Context, *sql.Tx, OriginCommand, OriginCreation, OriginPaymentInput) (OriginProviderRequest, error)
type OriginEngine struct {
	DB                  *sql.DB
	Key                 string
	LegacyKey           string
	CSKAPIKey           string
	Selected            bool
	Apply               OriginApply
	Decline             OriginApply
	Mismatch            OriginApply
	BuildRequest        OriginBuildRequest
	Provider            OriginProvider
	MemberProducts      map[string]bool
	CouponPolicy        OriginCouponPolicyReader
	ExchangeFunding     OriginExchangeFundingReader
	Clock               func() time.Time
	WebhookWindowMillis int64
}
type OriginAttempt struct {
	Contract           string  `json:"contract"`
	CommandID          string  `json:"commandId"`
	OrderID            string  `json:"orderId"`
	CustomerID         string  `json:"customerId"`
	CreationHash       string  `json:"creationHash"`
	RequestHash        string  `json:"requestHash"`
	ReferenceHash      string  `json:"referenceHash"`
	PaymentRequestHash string  `json:"paymentRequestHash"`
	Phase              string  `json:"phase"`
	Provider           string  `json:"provider"`
	PayloadHash        string  `json:"payloadHash"`
	ResponseHash       *string `json:"responseHash"`
	ObservationHash    *string `json:"observationHash"`
	Declined           bool    `json:"declined"`
	CreatedAt          int64   `json:"createdAt"`
	UpdatedAt          int64   `json:"updatedAt"`
	Version            int64   `json:"version"`
}
type OriginPayment struct {
	Contract              string               `json:"contract"`
	CommandID             string               `json:"commandId"`
	Origin                string               `json:"origin"`
	OrderID               string               `json:"orderId"`
	CustomerID            string               `json:"customerId"`
	CreationHash          string               `json:"creationHash"`
	RequestHash           string               `json:"requestHash"`
	ReferenceHash         string               `json:"referenceHash"`
	Method                int64                `json:"method"`
	Status                string               `json:"status"`
	ObservationHash       string               `json:"observationHash"`
	Provider              string               `json:"provider"`
	Before                OriginNativeEvidence `json:"before"`
	After                 OriginNativeEvidence `json:"after"`
	EffectsHash           string               `json:"effectsHash"`
	SourceCommit          string               `json:"sourceCommit"`
	CreatedAt             int64                `json:"createdAt"`
	FundingBasis          string               `json:"fundingBasis,omitempty"`
	FundingHash           *string              `json:"fundingHash,omitempty"`
	AssetActivationHash   *string              `json:"assetActivationHash,omitempty"`
	CouponConsumptionHash *string              `json:"couponConsumptionHash,omitempty"`
}
type OriginPaymentOutcome struct {
	OriginPayment
	NoConfirmation bool `json:"noConfirmation"`
}
type OriginPaymentView struct {
	Status    string                         `json:"status"`
	CommandID string                         `json:"commandId"`
	OrderID   string                         `json:"orderId"`
	Response  *OriginProviderResponse        `json:"response,omitempty"`
	Receipt   *OriginPayment                 `json:"receipt,omitempty"`
	NoEffect  *OriginPaymentNoEffectEnvelope `json:"noEffect,omitempty"`
}
type originUnit struct {
	engine           *OriginEngine
	conn             *sql.Conn
	tx               *sql.Tx
	command          OriginCommand
	creation         OriginCreation
	counter          *OriginCounterEntry
	currentAuthority map[string]interface{}
	released         bool
}

func (e *OriginEngine) now() int64 {
	if e.Clock != nil {
		return e.Clock().UnixMilli()
	}
	return time.Now().UnixMilli()
}
func (e *OriginEngine) ready(newWork bool) error {
	if e.DB == nil || !originKey.MatchString(e.Key) || e.Key == e.LegacyKey || newWork && (!originKey.MatchString(e.LegacyKey) || !e.Selected || e.Apply == nil || e.Decline == nil || e.BuildRequest == nil || e.Provider == nil) {
		return ErrReview
	}
	return nil
}
func (e *OriginEngine) open(ctx context.Context, cap OriginPaymentAuthorization, caller OriginCaller, mutating, readOnly bool) (u *originUnit, err error) {
	if e.ready(false) != nil {
		return nil, ErrReview
	}
	conn, err := e.DB.Conn(ctx)
	if err != nil {
		return nil, err
	}
	u = &originUnit{engine: e, conn: conn}
	owned := u
	defer func() {
		if err != nil {
			owned.close()
		}
	}()
	u.tx, err = conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	// Hint authenticates identity without creating a stale repeatable-read view.
	hint, err := ReadOriginCommand(ctx, u.tx, cap.CommandID, cap.CustomerID, e.Key, false)
	if err != nil {
		return nil, err
	}
	caller.AuthorityClock = e.now
	if readOnly {
		_, err = OriginReadAuthorize(ctx, u.tx, hint, caller, e.Key, e.now())
	} else if mutating && caller.StageRecovery != "" {
		u.currentAuthority, err = OriginCurrentAuthority(ctx, u.tx, hint, caller, e.Key, e.now())
	} else {
		_, err = OriginAuthorize(ctx, u.tx, hint, caller, e.Key, e.now())
	}
	if err != nil {
		return nil, err
	}
	if cap.ExpiresAt <= e.now() {
		return nil, ErrReview
	}
	u.command, err = ReadOriginCommand(ctx, u.tx, cap.CommandID, cap.CustomerID, e.Key, true)
	if err != nil {
		return nil, err
	}
	c := u.command
	if c.Phase != "BOUND" && c.Phase != "COUNTED" || c.OrderID == nil || *c.OrderID != cap.OrderID || c.CreationHash == nil || *c.CreationHash != cap.CreationHash || c.RequestHash != cap.RequestHash || c.ReferenceHash != cap.ReferenceHash || c.AuthorityHash != cap.AuthorityHash {
		return nil, ErrReview
	}
	u.creation, err = ReadOriginCreation(ctx, u.tx, c, e.Key)
	if err != nil {
		return nil, err
	}
	if c.Origin == "external-system" {
		var seal string
		if u.tx.QueryRowContext(ctx, `SELECT proof_hash FROM pos_rewrite_screening_origin_system_authorities WHERE command_id=? FOR SHARE`, c.ID).Scan(&seal) != nil || u.creation.SystemAuthorityHash != seal {
			return nil, ErrReview
		}
	}
	if mutating {
		a, _, _, readErr := originReadAttempt(ctx, u.tx, c.ID, e.Key)
		if readErr != nil {
			return nil, readErr
		}
		if a.Phase == "CONFIRMED" || a.Phase == "CAPTURED" {
			return u, nil
		}
		if caller.StageRecovery != "" {
			if err = e.stageRecovery(ctx, u, a, cap, caller.StageRecovery, true); err != nil {
				return nil, err
			}
		}
		if !originKey.MatchString(e.LegacyKey) {
			return nil, ErrReview
		}
		u.counter, err = enterOriginCounter(ctx, u.tx, c)
		if err != nil {
			return nil, err
		}
	}
	if !readOnly {
		if err = originNative(ctx, u.tx, c, u.creation, false); err != nil {
			return nil, err
		}
	}
	return u, nil
}
func (u *originUnit) close() {
	if u == nil {
		return
	}
	if u.tx != nil && !u.released {
		if u.counter != nil && u.counter.release(context.Background(), u.tx) != nil {
			u.counter.prelude.counterPoisoned = true
		}
		u.tx.Rollback()
	}
	if u.conn != nil {
		if u.counter != nil && u.counter.prelude.counterPoisoned {
			u.conn.Raw(func(interface{}) error { return driver.ErrBadConn })
		}
		u.conn.Close()
	}
}
func (u *originUnit) commit(ctx context.Context) error {
	if u.counter != nil {
		if err := u.counter.release(ctx, u.tx); err != nil {
			return err
		}
	}
	if err := u.tx.Commit(); err != nil {
		return err
	}
	u.released = true
	return nil
}
func originReadAttempt(ctx context.Context, tx *sql.Tx, id, key string) (OriginAttempt, string, string, error) {
	var v OriginAttempt
	var raw []byte
	var seal, payload, response string
	var order, customer, phase string
	err := tx.QueryRowContext(ctx, `SELECT CAST(order_id AS CHAR),CAST(customer_id AS CHAR),phase,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash,CASE WHEN OCTET_LENGTH(payload)<=1400000 THEN payload ELSE NULL END,COALESCE(CASE WHEN OCTET_LENGTH(response)<=1400000 THEN response ELSE NULL END,'') FROM pos_rewrite_screening_origin_payment_attempts WHERE command_id=? FOR UPDATE`, id).Scan(&order, &customer, &phase, &raw, &seal, &payload, &response)
	if err != nil {
		return v, "", "", err
	}
	if originVerify(key, "payment-attempt", raw, seal, &v, 16000) != nil || v.Contract != OriginPaymentsContract || v.CommandID != id || v.OrderID != order || v.CustomerID != customer || v.Phase != phase || !originHash.MatchString(v.CreationHash) || !originHash.MatchString(v.PaymentRequestHash) || !originHash.MatchString(v.PayloadHash) || !originPoint(v.CreatedAt) || v.UpdatedAt < v.CreatedAt || v.Version < 1 {
		return v, "", "", ErrReview
	}
	switch phase {
	case "SENDING", "PENDING", "UNCERTAIN", "CONFIRMED", "FAILED", "CAPTURED":
	default:
		return v, "", "", ErrReview
	}
	return v, payload, response, nil
}
func originAttemptSave(ctx context.Context, tx *sql.Tx, v OriginAttempt, key string, response *OriginProviderResponse) error {
	v.Version++
	raw, e := originCanonical(v)
	if e != nil {
		return e
	}
	seal, e := OriginMAC(key, "payment-attempt", v)
	if e != nil {
		return e
	}
	var encrypted interface{}
	if response != nil {
		payload, hash, e := originSeal(key, "payment-response:"+v.CommandID, response)
		if e != nil || v.ResponseHash == nil || *v.ResponseHash != hash {
			return ErrReview
		}
		encrypted = payload
	}
	_, e = tx.ExecContext(ctx, `UPDATE pos_rewrite_screening_origin_payment_attempts SET phase=?,data=?,proof_hash=?,response=COALESCE(?,response) WHERE command_id=?`, v.Phase, string(raw), seal, encrypted, v.CommandID)
	return e
}
func (e *OriginEngine) Start(ctx context.Context, cap OriginPaymentAuthorization, caller OriginCaller, input OriginPaymentInput, requestID string) (OriginPaymentView, error) {
	if e.ready(false) != nil || caller.StageRecovery != "" || input.Order != originInt(cap.OrderID) {
		return OriginPaymentView{}, ErrReview
	}
	requestHash, err := OriginPaymentRequestHash(e.Key, input)
	if err != nil || requestHash != cap.PaymentRequestHash {
		return OriginPaymentView{}, ErrReview
	}
	u, err := e.open(ctx, cap, caller, false, false)
	if err != nil {
		return OriginPaymentView{}, err
	}
	defer u.close()
	if input.Method != u.creation.Method || input.IsValid != nil && (!*input.IsValid || input.Name != "placed_order") {
		return e.rejectUnsent(ctx, u, cap, "NATIVE_INPUT_CHANGED")
	}
	attempt, payload, response, err := originReadAttempt(ctx, u.tx, cap.CommandID, e.Key)
	if err == nil {
		if attempt.PaymentRequestHash != cap.PaymentRequestHash {
			return OriginPaymentView{}, ErrReview
		}
		view, err := e.view(ctx, u, attempt, payload, response)
		if err != nil {
			return view, err
		}
		return view, u.commit(ctx)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return OriginPaymentView{}, err
	}
	prior, err := originReadNoEffect(ctx, u.tx, u.command, cap, e.Key)
	if err != nil {
		return OriginPaymentView{}, err
	}
	if prior != nil {
		return OriginPaymentView{Status: "NO_EFFECT", CommandID: cap.CommandID, OrderID: cap.OrderID, NoEffect: prior}, u.commit(ctx)
	}
	if e.ready(true) != nil {
		return e.rejectUnsent(ctx, u, cap, "CONFIGURATION_UNAVAILABLE")
	}
	u.counter, err = enterOriginCounter(ctx, u.tx, u.command)
	if err != nil {
		return e.rejectUnsent(ctx, u, cap, "CONFIGURATION_UNAVAILABLE")
	}
	if u.command.Phase != "BOUND" || originNative(ctx, u.tx, u.command, u.creation, true) != nil {
		return OriginPaymentView{}, ErrReview
	}
	var nativeStatus int64
	if u.tx.QueryRowContext(ctx, `SELECT order_status FROM orders WHERE id=?`, cap.OrderID).Scan(&nativeStatus) != nil || nativeStatus != 0 {
		return OriginPaymentView{}, ErrReview
	}
	if err = originLockAssets(ctx, u.tx, u.command); err != nil {
		return e.rejectUnsent(ctx, u, cap, "ASSET_EVIDENCE_UNAVAILABLE")
	}
	if _, err = e.verifyAssets(ctx, u.tx, u.command, u.creation); err != nil {
		return e.rejectUnsent(ctx, u, cap, "ASSET_EVIDENCE_UNAVAILABLE")
	}
	coupon, err := e.verifyCoupon(ctx, u.tx, u.command, u.creation)
	if err != nil {
		return e.rejectUnsent(ctx, u, cap, "COUPON_EVIDENCE_UNAVAILABLE")
	}
	providerRequest, err := e.BuildRequest(ctx, u.tx, u.command, u.creation, input)
	if err != nil {
		return e.rejectUnsent(ctx, u, cap, "PROVIDER_INPUT_UNAVAILABLE")
	}
	if coupon != nil {
		providerRequest.CouponPolicy = &coupon.policy
	}
	if providerRequest.OrderID != cap.OrderID || providerRequest.CustomerID != cap.CustomerID {
		return OriginPaymentView{}, ErrReview
	}
	sealed, hash, err := originSeal(e.Key, "payment-request:"+cap.CommandID, providerRequest)
	if err != nil {
		return OriginPaymentView{}, err
	}
	now := e.now()
	attempt = OriginAttempt{Contract: OriginPaymentsContract, CommandID: cap.CommandID, OrderID: cap.OrderID, CustomerID: cap.CustomerID, CreationHash: cap.CreationHash, RequestHash: cap.RequestHash, ReferenceHash: cap.ReferenceHash, PaymentRequestHash: cap.PaymentRequestHash, Phase: "SENDING", Provider: providerRequest.Provider, PayloadHash: hash, CreatedAt: now, UpdatedAt: now, Version: 1}
	data, _ := originCanonical(attempt)
	seal, _ := OriginMAC(e.Key, "payment-attempt", attempt)
	if _, err = u.tx.ExecContext(ctx, `INSERT INTO pos_rewrite_screening_origin_payment_attempts(command_id,order_id,customer_id,phase,data,proof_hash,payload,response) VALUES(?,?,?,'SENDING',?,?,?,NULL)`, attempt.CommandID, attempt.OrderID, attempt.CustomerID, string(data), seal, sealed); err != nil {
		return OriginPaymentView{}, err
	}
	// Once this commits, neither POST replay nor GET can call Start again.
	if err = u.commit(ctx); err != nil {
		return OriginPaymentView{}, err
	}
	u.close()
	u = nil
	observation, err := e.Provider.Start(ctx, providerRequest)
	if err != nil {
		return e.markUnknown(ctx, cap, caller)
	}
	return e.accept(ctx, cap, caller, observation, requestID)
}
func (e *OriginEngine) Read(ctx context.Context, cap OriginPaymentAuthorization, caller OriginCaller, recoverProvider bool, requestID string) (OriginPaymentView, error) {
	u, err := e.open(ctx, cap, caller, false, true)
	if err != nil {
		return OriginPaymentView{}, err
	}
	defer u.close()
	attempt, payload, response, err := originReadAttempt(ctx, u.tx, cap.CommandID, e.Key)
	if errors.Is(err, sql.ErrNoRows) {
		fence, readErr := originReadNoEffect(ctx, u.tx, u.command, cap, e.Key)
		if readErr != nil {
			return OriginPaymentView{}, readErr
		}
		if fence == nil {
			return OriginPaymentView{}, sql.ErrNoRows
		}
		return OriginPaymentView{Status: "NO_EFFECT", CommandID: cap.CommandID, OrderID: cap.OrderID, NoEffect: fence}, u.commit(ctx)
	}
	if err != nil {
		return OriginPaymentView{}, err
	}
	if attempt.PaymentRequestHash != cap.PaymentRequestHash {
		return OriginPaymentView{}, ErrReview
	}
	view, err := e.view(ctx, u, attempt, payload, response)
	if err != nil {
		return view, err
	}
	if !recoverProvider || attempt.Phase == "CONFIRMED" || attempt.Phase == "FAILED" || attempt.Phase == "CAPTURED" {
		return view, u.commit(ctx)
	}
	if caller.StageRecovery != "" {
		u.currentAuthority, err = OriginCurrentAuthority(ctx, u.tx, u.command, caller, e.Key, e.now())
		if err != nil {
			return view, err
		}
		if err = e.stageRecovery(ctx, u, attempt, cap, caller.StageRecovery, false); err != nil {
			return view, err
		}
	}
	var request OriginProviderRequest
	if originOpen(e.Key, "payment-request:"+cap.CommandID, payload, attempt.PayloadHash, &request) != nil {
		return OriginPaymentView{}, ErrReview
	}
	if e.Provider == nil {
		return view, u.commit(ctx)
	}
	if err = u.commit(ctx); err != nil {
		return view, err
	}
	u.close()
	u = nil
	observation, err := e.Provider.Recover(ctx, request)
	if err != nil {
		return view, nil
	}
	return e.accept(ctx, cap, caller, observation, requestID)
}
func (e *OriginEngine) markUnknown(ctx context.Context, cap OriginPaymentAuthorization, caller OriginCaller) (OriginPaymentView, error) {
	u, err := e.open(ctx, cap, caller, false, false)
	if err != nil {
		return OriginPaymentView{}, err
	}
	defer u.close()
	a, _, _, err := originReadAttempt(ctx, u.tx, cap.CommandID, e.Key)
	if err != nil {
		return OriginPaymentView{}, err
	}
	if a.Phase == "SENDING" {
		a.Phase = "UNCERTAIN"
		a.UpdatedAt = e.now()
		if err = originAttemptSave(ctx, u.tx, a, e.Key, nil); err != nil {
			return OriginPaymentView{}, err
		}
	}
	return OriginPaymentView{Status: a.Phase, CommandID: a.CommandID, OrderID: a.OrderID}, u.commit(ctx)
}
func (e *OriginEngine) accept(ctx context.Context, cap OriginPaymentAuthorization, caller OriginCaller, o OriginProviderResponse, requestID string) (OriginPaymentView, error) {
	if err := e.recordObservation(ctx, cap.CommandID, o); err != nil {
		return OriginPaymentView{}, err
	}
	u, err := e.open(ctx, cap, caller, true, false)
	if err != nil {
		return OriginPaymentView{}, err
	}
	defer u.close()
	a, payload, response, err := originReadAttempt(ctx, u.tx, cap.CommandID, e.Key)
	if err != nil {
		return OriginPaymentView{}, err
	}
	if a.Phase == "CONFIRMED" || a.Phase == "CAPTURED" {
		v, err := e.view(ctx, u, a, payload, response)
		if err != nil {
			return v, err
		}
		return v, u.commit(ctx)
	}
	o, err = originRetainClientResponse(e.Key, a, response, o)
	if err != nil {
		return OriginPaymentView{}, err
	}
	v, err := e.apply(ctx, u, a, o, requestID)
	if err != nil {
		return v, err
	}
	return v, u.commit(ctx)
}
func originRetainClientResponse(key string, a OriginAttempt, encrypted string, o OriginProviderResponse) (OriginProviderResponse, error) {
	if a.ResponseHash == nil {
		return o, nil
	}
	var prior OriginProviderResponse
	if originOpen(key, "payment-response:"+a.CommandID, encrypted, *a.ResponseHash, &prior) != nil {
		return o, ErrReview
	}
	if o.ClientAuthToken == "" {
		o.ClientAuthToken = prior.ClientAuthToken
	}
	if len(prior.ClientResponse) > 0 && o.Route != "process-order" {
		o.ClientResponse = prior.ClientResponse
	}
	return o, nil
}

func (e *OriginEngine) apply(ctx context.Context, u *originUnit, a OriginAttempt, o OriginProviderResponse, requestID string) (OriginPaymentView, error) {
	if o.OrderID != a.OrderID || !originHash.MatchString(o.EvidenceHash) || !originPoint(o.ObservedAt) || o.ObservedAt > e.now()+1000 || o.AmountPaise < 0 || len(o.ProviderReference) > 255 || len(o.ClientAuthToken) > 16000 || len(o.ClientResponse) > 64000 || len(o.ProviderMessage) > 16000 {
		return OriginPaymentView{}, ErrReview
	}
	switch o.Route {
	case "process-order", "provider-read", "webhook", "cron", "return", "gokwik":
	default:
		return OriginPaymentView{}, ErrReview
	}
	observationHash, err := OriginMAC(e.Key, "payment-observation", o)
	if err != nil {
		return OriginPaymentView{}, err
	}
	var savedRequest OriginProviderRequest
	var payload string
	if u.tx.QueryRowContext(ctx, `SELECT payload FROM pos_rewrite_screening_origin_payment_attempts WHERE command_id=?`, a.CommandID).Scan(&payload) != nil || originOpen(e.Key, "payment-request:"+a.CommandID, payload, a.PayloadHash, &savedRequest) != nil {
		return OriginPaymentView{}, ErrReview
	}
	if savedRequest.StockMode != "legacy" && savedRequest.StockMode != "shadow" && savedRequest.StockMode != "reserve" {
		return OriginPaymentView{}, ErrReview
	}
	before, err := OriginEvidence(ctx, u.tx, u.command, e.Key)
	if err != nil {
		return OriginPaymentView{}, err
	}
	confirmed := o.Status == "DIRECT" || o.Status == "CHARGED"
	failed := o.Status == "AUTHENTICATION_FAILED" || o.Status == "AUTHORIZATION_FAILED" || o.Status == "JUSPAY_DECLINED" || o.Status == "ORDER_FAILED"
	phase := "PENDING"
	amountMismatch := false
	collector := NewOriginEffectCollector(u.command, originSafeRequestID(requestID), e.Key)
	collector.StockMode = savedRequest.StockMode
	fundingBasis := ""
	var fundingHash, assetActivationHash, couponConsumptionHash *string
	if o.Status == "TXN_CREATED" {
		if before.OrderStatus == 0 && before.PaymentStatus != 6 {
			if err = originNativePaymentLog(ctx, u.tx, u.command, o, e.Key); err != nil {
				return OriginPaymentView{}, err
			}
			if _, err = u.tx.ExecContext(ctx, `UPDATE orders SET payment_status=6 WHERE id=? AND order_status=0`, a.OrderID); err != nil {
				return OriginPaymentView{}, err
			}
		}
	}
	if confirmed {
		if (before.OrderStatus == 17 || a.Declined) && o.Status != "DIRECT" {
			confirmed = false
			phase = "CAPTURED"
		} else if before.OrderStatus != 0 {
			return OriginPaymentView{}, ErrReview
		}
		if confirmed && o.Status != "DIRECT" {
			var expected int64
			if u.tx.QueryRowContext(ctx, `SELECT CAST(FLOOR(pay_amt)*100 AS SIGNED) FROM orders WHERE id=?`, a.OrderID).Scan(&expected) != nil {
				return OriginPaymentView{}, ErrReview
			}
			if expected > o.AmountPaise {
				if e.Mismatch == nil {
					return OriginPaymentView{}, ErrReview
				}
				if err = e.Mismatch(ctx, u.tx, OriginApplyContext{u.command, u.creation, o, collector.RequestID, savedRequest.StockMode, a.Provider}, collector); err != nil {
					return OriginPaymentView{}, err
				}
				confirmed = false
				phase = "CAPTURED"
				amountMismatch = true
			}
			if confirmed {
				var started time.Time
				query := `SELECT created_at FROM payments WHERE order_id=? ORDER BY id LIMIT 1 FOR SHARE`
				if a.Provider == "gokwik" {
					query = `SELECT created_at FROM gokwik_orders WHERE order_id=? AND status='CREATED' ORDER BY created_at LIMIT 1 FOR SHARE`
				}
				readErr := u.tx.QueryRowContext(ctx, query, a.OrderID).Scan(&started)
				if readErr != nil && !errors.Is(readErr, sql.ErrNoRows) {
					return OriginPaymentView{}, readErr
				}
				if errors.Is(readErr, sql.ErrNoRows) && a.Provider == "gokwik" {
					link, err := originReadGokwikLink(ctx, u.tx, u.command, e.Key)
					if err != nil || link == nil {
						return OriginPaymentView{}, ErrReview
					}
					started = time.UnixMilli(link.DispatchStartedAt)
				}
				window := int64(7200000)
				if o.Route == "webhook" {
					window = e.WebhookWindowMillis
					if window <= 0 || window > 86400000 {
						return OriginPaymentView{}, ErrReview
					}
				}
				if confirmed && time.UnixMilli(o.ObservedAt).Sub(started) >= time.Duration(window)*time.Millisecond {
					confirmed = false
					phase = "CAPTURED"
					if _, err = u.tx.ExecContext(ctx, `UPDATE orders SET payment_status=8 WHERE id=? AND order_status=0`, a.OrderID); err != nil {
						return OriginPaymentView{}, err
					}
				}
			}
		}
		if confirmed {
			pending, err := PendingOriginScreeningCredit(ctx, u.tx, u.command.CustomerID, e.Key, u.command.ID)
			if err != nil {
				return OriginPaymentView{}, err
			}
			legacy, err := pendingLegacyOriginCredit(ctx, u.tx, u.command.CustomerID, e.LegacyKey)
			if err != nil || u.counter.before+pending+legacy+uint64(u.command.MarkerRows) > 2 {
				return OriginPaymentView{}, ErrReview
			}
			if err = originLockAssets(ctx, u.tx, u.command); err != nil {
				return OriginPaymentView{}, err
			}
			assets, err := e.verifyAssets(ctx, u.tx, u.command, u.creation)
			if err != nil {
				return OriginPaymentView{}, err
			}
			coupon, err := e.verifyCoupon(ctx, u.tx, u.command, u.creation)
			if err != nil {
				return OriginPaymentView{}, err
			}
			if coupon != nil {
				if savedRequest.CouponPolicy == nil || !originEqual(*savedRequest.CouponPolicy, coupon.policy) {
					return OriginPaymentView{}, ErrReview
				}
			} else if savedRequest.CouponPolicy != nil {
				return OriginPaymentView{}, ErrReview
			}
			fundingBasis, fundingHash, err = e.funding(ctx, u.tx, u.command, u.creation, o)
			if err != nil {
				return OriginPaymentView{}, err
			}
			cards, err := lockPendingGiftCards(ctx, u.tx, originInt(a.OrderID))
			if err != nil {
				return OriginPaymentView{}, err
			}
			if e.Apply == nil {
				return OriginPaymentView{}, ErrReview
			}
			if err = e.Apply(ctx, u.tx, OriginApplyContext{u.command, u.creation, o, collector.RequestID, savedRequest.StockMode, a.Provider}, collector); err != nil {
				return OriginPaymentView{}, err
			}
			var paid int64
			if u.tx.QueryRowContext(ctx, `SELECT payment_status FROM orders WHERE id=?`, a.OrderID).Scan(&paid) != nil {
				return OriginPaymentView{}, ErrReview
			}
			if paid == 4 && (fundingBasis == "source-cod" || fundingBasis == "source-coc") {
				return OriginPaymentView{}, ErrReview
			}
			if o.Status == "CHARGED" && paid != 4 {
				return OriginPaymentView{}, ErrReview
			}
			// A source placed/COD order is not a funded gift. Activation is bound
			// to actual paid native status; retained issuance evidence is mandatory.
			activation := int64(14)
			if paid == 4 {
				activation = 3
			}
			if err = recordGiftCardIssuances(ctx, u.tx, originInt(a.OrderID), activation, cards); err != nil {
				return OriginPaymentView{}, err
			}
			assetHash, err := FinishOriginAssets(ctx, u.tx, u.command, u.creation, assets, e.Key)
			if err != nil {
				return OriginPaymentView{}, err
			}
			if assetHash != "" {
				assetActivationHash = &assetHash
			}
			couponHash, err := FinishOriginCoupon(ctx, u.tx, u.command, u.creation, coupon, e.Key, "confirm")
			if err != nil {
				return OriginPaymentView{}, err
			}
			if couponHash != "" {
				couponConsumptionHash = &couponHash
			}
			phase = "CONFIRMED"
		}
	} else if failed {
		if before.OrderStatus != 0 && before.OrderStatus != 17 {
			return OriginPaymentView{}, ErrReview
		}
		if a.Phase != "FAILED" {
			if e.Decline == nil {
				return OriginPaymentView{}, ErrReview
			}
			if err = originLockAssets(ctx, u.tx, u.command); err != nil {
				return OriginPaymentView{}, err
			}
			coupon, err := e.verifyCoupon(ctx, u.tx, u.command, u.creation)
			if err != nil {
				return OriginPaymentView{}, err
			}
			if coupon != nil {
				if savedRequest.CouponPolicy == nil || !originEqual(*savedRequest.CouponPolicy, coupon.policy) {
					return OriginPaymentView{}, ErrReview
				}
			} else if savedRequest.CouponPolicy != nil {
				return OriginPaymentView{}, ErrReview
			}
			if err = e.Decline(ctx, u.tx, OriginApplyContext{u.command, u.creation, o, collector.RequestID, savedRequest.StockMode, a.Provider}, collector); err != nil {
				return OriginPaymentView{}, err
			}
			couponHash, err := FinishOriginCoupon(ctx, u.tx, u.command, u.creation, coupon, e.Key, "decline")
			if err != nil {
				return OriginPaymentView{}, err
			}
			if couponHash != "" {
				couponConsumptionHash = &couponHash
			}
		} else if u.creation.CouponHash != "" {
			var hash string
			if u.tx.QueryRowContext(ctx, `SELECT proof_hash FROM pos_rewrite_screening_origin_coupon_consumptions WHERE command_id=? AND action='decline' FOR SHARE`, u.command.ID).Scan(&hash) != nil || verifyOriginCouponConsumption(ctx, u.tx, u.command, u.creation, hash, e.Key, "decline") != nil {
				return OriginPaymentView{}, ErrReview
			}
			couponConsumptionHash = &hash
		}
		phase = "FAILED"
		a.Declined = true
	}
	if o.Status != "TXN_CREATED" {
		logged := o
		if amountMismatch {
			logged.LogStatus = "AMOUNT_MISMATCH"
		}
		if err = originNativePaymentLog(ctx, u.tx, u.command, logged, e.Key); err != nil {
			return OriginPaymentView{}, err
		}
	}
	after, err := OriginEvidence(ctx, u.tx, u.command, e.Key)
	if err != nil {
		return OriginPaymentView{}, err
	}
	if before.HeaderHash != after.HeaderHash || before.LinesHash != after.LinesHash {
		return OriginPaymentView{}, ErrReview
	}
	if err = u.counter.final(ctx, u.tx, u.command, before.OrderStatus != 0 && before.OrderStatus != 17, phase == "CONFIRMED"); err != nil {
		return OriginPaymentView{}, err
	}
	effectsHash, err := collector.persist(ctx, u.tx)
	if err != nil {
		return OriginPaymentView{}, err
	}
	a.Phase = phase
	a.UpdatedAt = e.now()
	a.ObservationHash = &observationHash
	_, responseHash, err := originSeal(e.Key, "payment-response:"+a.CommandID, o)
	if err != nil {
		return OriginPaymentView{}, err
	}
	a.ResponseHash = &responseHash
	if err = originAttemptSave(ctx, u.tx, a, e.Key, &o); err != nil {
		return OriginPaymentView{}, err
	}
	view := OriginPaymentView{Status: phase, CommandID: a.CommandID, OrderID: a.OrderID, Response: &o}
	if phase == "CONFIRMED" {
		if after.OrderStatus == 0 || after.OrderStatus == 17 || after.PaymentStatus != 1 && after.PaymentStatus != 4 {
			return OriginPaymentView{}, ErrReview
		}
		proof := OriginPayment{Contract: "pos-screening-origin-payment-v1", CommandID: a.CommandID, Origin: u.command.Origin, OrderID: a.OrderID, CustomerID: a.CustomerID, CreationHash: a.CreationHash, RequestHash: a.RequestHash, ReferenceHash: a.ReferenceHash, Method: u.creation.Method, Status: phase, ObservationHash: observationHash, Provider: a.Provider, Before: before, After: after, EffectsHash: effectsHash, SourceCommit: OriginPaymentsSourceCommit, CreatedAt: e.now(), FundingBasis: fundingBasis, FundingHash: fundingHash, AssetActivationHash: assetActivationHash, CouponConsumptionHash: couponConsumptionHash}
		if err = originPersist(ctx, u.tx, "payment", a.CommandID, e.Key, "payment", proof); err != nil {
			return OriginPaymentView{}, err
		}
		view.Receipt = &proof
	} else if phase == "FAILED" || phase == "CAPTURED" {
		proof := OriginPaymentOutcome{OriginPayment: OriginPayment{Contract: "pos-screening-origin-payment-outcome-v1", CommandID: a.CommandID, Origin: u.command.Origin, OrderID: a.OrderID, CustomerID: a.CustomerID, CreationHash: a.CreationHash, RequestHash: a.RequestHash, ReferenceHash: a.ReferenceHash, Method: u.creation.Method, Status: phase, ObservationHash: observationHash, Provider: a.Provider, Before: before, After: after, EffectsHash: effectsHash, SourceCommit: OriginPaymentsSourceCommit, CreatedAt: e.now(), CouponConsumptionHash: couponConsumptionHash}, NoConfirmation: true}
		raw, err := originCanonical(proof)
		if err != nil {
			return view, err
		}
		seal, err := OriginMAC(e.Key, "payment-outcome", proof)
		if err != nil {
			return view, err
		}
		if _, err = u.tx.ExecContext(ctx, `INSERT INTO pos_rewrite_screening_origin_payment_outcomes(command_id,observation_hash,order_id,data,proof_hash) VALUES(?,?,?,?,?)`, a.CommandID, observationHash, a.OrderID, string(raw), seal); err != nil {
			return view, err
		}
	}
	return view, nil
}
func (e *OriginEngine) view(ctx context.Context, u *originUnit, a OriginAttempt, payload, response string) (OriginPaymentView, error) {
	v := OriginPaymentView{Status: a.Phase, CommandID: a.CommandID, OrderID: a.OrderID}
	if a.CreationHash != *u.command.CreationHash || a.RequestHash != u.command.RequestHash || a.ReferenceHash != u.command.ReferenceHash {
		return v, ErrReview
	}
	if a.ResponseHash != nil {
		var r OriginProviderResponse
		if response == "" || originOpen(e.Key, "payment-response:"+a.CommandID, response, *a.ResponseHash, &r) != nil {
			return v, ErrReview
		}
		v.Response = &r
	}
	if a.Phase == "CONFIRMED" {
		p, err := ReadOriginPayment(ctx, u.tx, u.command, u.creation, e.Key)
		if err != nil {
			return v, err
		}
		v.Receipt = &p
	}
	return v, nil
}
func ReadOriginPayment(ctx context.Context, tx *sql.Tx, c OriginCommand, creation OriginCreation, key string) (OriginPayment, error) {
	var p OriginPayment
	var raw []byte
	var seal, order string
	if tx.QueryRowContext(ctx, `SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_payments WHERE command_id=? FOR SHARE`, c.ID).Scan(&order, &raw, &seal) != nil || originVerify(key, "payment", raw, seal, &p, 16000) != nil || p.Contract != "pos-screening-origin-payment-v1" || p.CommandID != c.ID || p.OrderID != creation.OrderID || order != p.OrderID || p.CustomerID != c.CustomerID || p.Origin != c.Origin || p.CreationHash != *c.CreationHash || p.RequestHash != c.RequestHash || p.ReferenceHash != c.ReferenceHash || p.Method != creation.Method || p.Status != "CONFIRMED" || p.SourceCommit != OriginPaymentsSourceCommit || p.After.HeaderHash != creation.HeaderHash || p.Before.HeaderHash != creation.HeaderHash || p.After.LinesHash != p.Before.LinesHash || !originHash.MatchString(p.ObservationHash) || !originHash.MatchString(p.EffectsHash) {
		return p, ErrReview
	}
	if verifyOriginFunding(ctx, tx, c, creation, p, key) != nil {
		return p, ErrReview
	}
	if creation.AssetsHash != "" {
		if p.AssetActivationHash == nil || verifyOriginAssetActivation(ctx, tx, c, creation, *p.AssetActivationHash, key) != nil {
			return p, ErrReview
		}
	} else if p.AssetActivationHash != nil {
		return p, ErrReview
	}
	if creation.CouponHash != "" {
		if p.CouponConsumptionHash == nil || verifyOriginCouponConsumption(ctx, tx, c, creation, *p.CouponConsumptionHash, key, "confirm") != nil {
			return p, ErrReview
		}
	} else if p.CouponConsumptionHash != nil {
		return p, ErrReview
	}
	if verifyOriginGokwikNative(ctx, tx, c, creation, p, key) != nil {
		return p, ErrReview
	}
	return p, nil
}

func originLockAssets(ctx context.Context, tx *sql.Tx, c OriginCommand) error {
	if c.OrderID == nil {
		return ErrReview
	}
	order := *c.OrderID
	// Fixed customer-first native prefix. Collection locks precede vouchers,
	// including both newly issued cards and a card spent by this order.
	rows, e := tx.QueryContext(ctx, `SELECT DISTINCT collection_no FROM gift_vouchers WHERE (order_id=? OR id=(SELECT voucher_used FROM orders WHERE id=?)) AND gv_type='GIFT_CARD' ORDER BY collection_no LIMIT 101`, order, order)
	if e != nil {
		return e
	}
	var collections []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) != nil || id < 1 {
			rows.Close()
			return ErrReview
		}
		collections = append(collections, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil || len(collections) > 100 {
		return ErrReview
	}
	for _, id := range collections {
		var found int64
		if tx.QueryRowContext(ctx, `SELECT id FROM gift_card_collection WHERE id=? FOR UPDATE`, id).Scan(&found) != nil {
			return ErrReview
		}
	}
	queries := []string{`SELECT id FROM gift_vouchers WHERE order_id=? OR id=(SELECT voucher_used FROM orders WHERE id=?) ORDER BY id LIMIT 1001 FOR UPDATE`, `SELECT id FROM tss_money_history WHERE user_id=? AND added_amt>0 AND is_expired=0 ORDER BY id LIMIT 10001 FOR UPDATE`, `SELECT id FROM tss_point_history WHERE user_id=? AND added_amt>0 AND is_expired=0 ORDER BY id LIMIT 10001 FOR UPDATE`, `SELECT e.id FROM user_eav e JOIN users u ON u.email=e.entity WHERE u.id=? AND e.attribute IN('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') ORDER BY e.id LIMIT 101 FOR UPDATE`, `SELECT ps.prod_id FROM product_stocks ps WHERE prod_id IN(SELECT prod_id FROM has_products WHERE order_id=?) ORDER BY ps.prod_id LIMIT 2001 FOR UPDATE`, `SELECT ps.id FROM product_store ps JOIN order_stores os ON os.store_id=ps.store_id WHERE os.order_id=? AND ps.product_id IN(SELECT prod_id FROM has_products WHERE order_id=?) ORDER BY ps.product_id,ps.id LIMIT 2001 FOR UPDATE`}
	args := [][]interface{}{{order, order}, {c.CustomerID}, {c.CustomerID}, {c.CustomerID}, {order}, {order, order}}
	limits := []int{1000, 10000, 10000, 100, 2000, 2000}
	for i, q := range queries {
		r, err := tx.QueryContext(ctx, q, args[i]...)
		if err != nil {
			return err
		}
		n := 0
		for r.Next() {
			var id int64
			if r.Scan(&id) != nil {
				r.Close()
				return ErrReview
			}
			n++
		}
		err = r.Err()
		r.Close()
		if err != nil || n > limits[i] {
			return ErrReview
		}
	}
	return nil
}

func pendingLegacyOriginCredit(ctx context.Context, tx *sql.Tx, customer, key string) (uint64, error) {
	rows, e := tx.QueryContext(ctx, `SELECT operation_id,customer_id,sku,CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_import_screening_reservations FORCE INDEX(ix_import_screening_customer) WHERE customer_id=? AND sku='390238' ORDER BY operation_id LIMIT 1001`, customer)
	if e != nil {
		return 0, e
	}
	var values []screeningState
	for rows.Next() {
		var op, user, sku, seal string
		var order sql.NullString
		var raw []byte
		if rows.Scan(&op, &user, &sku, &order, &raw, &seal) != nil {
			rows.Close()
			return 0, ErrReview
		}
		v, e := checkedScreeningState(raw, seal, op, user, sku, order, key)
		if e != nil {
			rows.Close()
			return 0, e
		}
		values = append(values, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil || len(values) > 1000 {
		return 0, ErrReview
	}
	var total uint64
	for _, v := range values {
		if v.Phase == "RESERVED" {
			total += uint64(v.MarkerRows)
		} else if v.Phase == "BOUND" || v.Phase == "COUNTED" {
			p, e := readScreeningProjection(ctx, tx, *v.OrderID, v.CustomerID, v.Scope.StoreID, v.Scope.CounterID)
			if e != nil {
				return 0, e
			}
			if len(p.lines) != len(v.Lines) || len(p.markers) != len(v.Markers) {
				return 0, ErrReview
			}
			for i, l := range v.Lines {
				if l != p.lines[i] {
					return 0, ErrReview
				}
			}
			for i, m := range v.Markers {
				if m != p.markers[i] {
					return 0, ErrReview
				}
			}
			if v.Phase == "BOUND" && !p.included {
				total += uint64(v.MarkerRows)
			}
		}
	}
	return total, nil
}

// Stable order for effect manifests and native descriptor comparisons.
func OriginSortEffects(values []OriginEffect) {
	sort.Slice(values, func(i, j int) bool { return values[i].ID < values[j].ID })
}
func OriginOriginalOrderID(id int64) string { return strconv.FormatInt(id, 10) }
func OriginHashEqual(a, b string) bool      { return hmac.Equal([]byte(a), []byte(b)) }
func OriginPaymentRequestHash(key string, input OriginPaymentInput) (string, error) {
	if len(input.Original) > 0 {
		var value map[string]interface{}
		if OriginDecode(input.Original, &value, 16000) != nil {
			return "", ErrReview
		}
		return OriginMAC(key, "payment-request", value)
	}
	return OriginMAC(key, "payment-request", input)
}

// Original customer/staff routes may derive this local, ephemeral dispatch
// view only from the already source-HMACed command after real JWT validation.
// It is never available for the external-system origin or a browser body.
func (e *OriginEngine) NativeAuthorization(ctx context.Context, commandID string, caller OriginCaller, input OriginPaymentInput) (OriginPaymentAuthorization, error) {
	var cap OriginPaymentAuthorization
	if caller.System || caller.StageRecovery != "" || caller.Credential == "" || e.ready(false) != nil {
		return cap, ErrReview
	}
	tx, err := e.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return cap, err
	}
	defer tx.Rollback()
	c, err := ReadOriginCommand(ctx, tx, commandID, caller.CustomerID, e.Key, false)
	if err != nil {
		return cap, err
	}
	caller.AuthorityClock = e.now
	if c.Origin == "external-system" || c.OrderID == nil || c.CreationHash == nil || originInt(*c.OrderID) != input.Order {
		return cap, ErrReview
	}
	if _, err = OriginAuthorize(ctx, tx, c, caller, e.Key, e.now()); err != nil {
		return cap, err
	}
	hash, err := OriginPaymentRequestHash(e.Key, input)
	if err != nil {
		return cap, err
	}
	return OriginPaymentAuthorization{Contract: "pos-screening-origin-payment-submission-v1", CommandID: c.ID, OrderID: *c.OrderID, CustomerID: c.CustomerID, CreationHash: *c.CreationHash, RequestHash: c.RequestHash, ReferenceHash: c.ReferenceHash, AuthorityHash: c.AuthorityHash, PaymentRequestHash: hash, IssuedAt: e.now(), ExpiresAt: e.now() + 60000}, nil
}
func (e *OriginEngine) NativeReadAuthorization(ctx context.Context, commandID string, caller OriginCaller) (OriginPaymentAuthorization, error) {
	var cap OriginPaymentAuthorization
	if caller.System || caller.Credential == "" || e.ready(false) != nil {
		return cap, ErrReview
	}
	tx, err := e.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return cap, err
	}
	defer tx.Rollback()
	caller.AuthorityClock = e.now
	c, err := ReadOriginCommand(ctx, tx, commandID, caller.CustomerID, e.Key, false)
	if err != nil {
		return cap, err
	}
	if c.Origin == "external-system" || c.OrderID == nil || c.CreationHash == nil {
		return cap, ErrReview
	}
	if _, err = OriginReadAuthorize(ctx, tx, c, caller, e.Key, e.now()); err != nil {
		return cap, err
	}
	a, _, _, err := originReadAttempt(ctx, tx, c.ID, e.Key)
	if errors.Is(err, sql.ErrNoRows) {
		a.PaymentRequestHash, err = originNoEffectRequestHash(ctx, tx, c, e.Key)
	}
	if err != nil {
		return cap, err
	}
	return OriginPaymentAuthorization{Contract: "pos-screening-origin-payment-submission-v1", CommandID: c.ID, OrderID: *c.OrderID, CustomerID: c.CustomerID, CreationHash: *c.CreationHash, RequestHash: c.RequestHash, ReferenceHash: c.ReferenceHash, AuthorityHash: c.AuthorityHash, PaymentRequestHash: a.PaymentRequestHash, IssuedAt: e.now(), ExpiresAt: e.now() + 60000}, nil
}
func (e *OriginEngine) verifyAssets(ctx context.Context, tx *sql.Tx, c OriginCommand, creation OriginCreation) (*OriginAssetActivation, error) {
	if creation.AssetsHash != "" {
		return VerifyOriginAssets(ctx, tx, c, creation, e.Key)
	}
	var gifts int
	if tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM gift_vouchers WHERE order_id=?`, creation.OrderID).Scan(&gifts) != nil || gifts != 0 {
		return nil, ErrReview
	}
	for _, line := range creation.Lines {
		if e.MemberProducts[line.ProductID] {
			return nil, ErrReview
		}
	}
	return nil, nil
}

// Server-only provider recovery input. Caller authentication is performed by
// the original callback/cron/customer receiver. No private payload is exposed
// on the public GET; the owned SQL transaction ends before provider I/O.
func (e *OriginEngine) RetainedProviderRequest(ctx context.Context, orderID string) (OriginProviderRequest, error) {
	var request OriginProviderRequest
	if e.ready(false) != nil || !originIdentifier(orderID) {
		return request, ErrReview
	}
	var command, customer string
	if e.DB.QueryRowContext(ctx, `SELECT id,CAST(customer_id AS CHAR) FROM pos_rewrite_screening_origin_commands WHERE order_id=?`, orderID).Scan(&command, &customer) != nil {
		return request, ErrReview
	}
	tx, err := e.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return request, err
	}
	defer tx.Rollback()
	var current string
	if tx.QueryRowContext(ctx, `SELECT CAST(id AS CHAR) FROM users WHERE id=? FOR SHARE`, customer).Scan(&current) != nil {
		return request, ErrReview
	}
	c, err := ReadOriginCommand(ctx, tx, command, customer, e.Key, false)
	if err != nil {
		return request, err
	}
	if _, err = ReadOriginCreation(ctx, tx, c, e.Key); err != nil {
		return request, err
	}
	a, payload, _, err := originReadAttempt(ctx, tx, command, e.Key)
	if err != nil {
		return request, err
	}
	if originOpen(e.Key, "payment-request:"+command, payload, a.PayloadHash, &request) != nil || request.OrderID != orderID || request.CustomerID != customer {
		return request, ErrReview
	}
	return request, tx.Commit()
}

func OriginDefiniteFailure(ctx context.Context, tx *sql.Tx, c OriginCommand, creation OriginCreation, key string) (bool, error) {
	a, _, _, err := originReadAttempt(ctx, tx, c.ID, key)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if a.Phase != "FAILED" || a.ObservationHash == nil {
		return false, nil
	}
	var count int
	if tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM pos_rewrite_screening_origin_payments WHERE command_id=?`, c.ID).Scan(&count) != nil || count != 0 {
		return false, ErrReview
	}
	var raw []byte
	var seal string
	var v OriginPaymentOutcome
	if tx.QueryRowContext(ctx, `SELECT CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_payment_outcomes WHERE command_id=? AND observation_hash=? FOR SHARE`, c.ID, *a.ObservationHash).Scan(&raw, &seal) != nil || originVerify(key, "payment-outcome", raw, seal, &v, 16000) != nil || v.Contract != "pos-screening-origin-payment-outcome-v1" || v.Status != "FAILED" || !v.NoConfirmation || v.CommandID != c.ID || v.CustomerID != c.CustomerID || v.OrderID != creation.OrderID || v.CreationHash != *c.CreationHash || v.RequestHash != c.RequestHash || v.ReferenceHash != c.ReferenceHash || v.ObservationHash != *a.ObservationHash || v.After.OrderStatus != 17 || v.After.HeaderHash != creation.HeaderHash || v.After.LinesHash != v.Before.LinesHash {
		return false, ErrReview
	}
	if creation.CouponHash != "" {
		if v.CouponConsumptionHash == nil || verifyOriginCouponConsumption(ctx, tx, c, creation, *v.CouponConsumptionHash, key, "decline") != nil {
			return false, ErrReview
		}
	} else if v.CouponConsumptionHash != nil {
		return false, ErrReview
	}
	var status int64
	var header string
	if tx.QueryRowContext(ctx, `SELECT order_status,`+OriginHeaderSQL+` FROM orders WHERE id=? FOR SHARE`, creation.OrderID).Scan(&status, &header) != nil {
		return false, ErrReview
	}
	return status == 17 && header == v.After.HeaderHash, nil
}
