package poscheckout

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

const originTestKey = "fixture-origin-independent-key-0123456789"
const originTestCommand = "11111111-1111-4111-8111-111111111111"
const originTestRecovery = "22222222-2222-4222-8222-222222222222"
const originTestNow = int64(1795000000000)

var originTestHash = strings.Repeat("a", 64)

func originFixture(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv("POS_ORIGIN_MYSQL_DSN")
	if raw == "" {
		t.Fatal("isolated origin MySQL fixture is required")
	}
	config, err := mysql.ParseDSN(raw)
	if err != nil || config.Net != "tcp" || config.Addr != "mysql:3306" || config.DBName != "pos_origin_contract_test" {
		t.Fatal("refusing non-isolated origin database")
	}
	db, err := sql.Open("mysql", raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, table := range []string{"users", "orders", "pos_rewrite_screening_origin_commands", "pos_rewrite_screening_origin_creations", "pos_rewrite_screening_origin_payments", "pos_rewrite_screening_origin_payment_attempts", "pos_rewrite_screening_origin_go_effects", "pos_rewrite_screening_origin_stage_recoveries", "pos_rewrite_screening_origin_stage_recovery_uses", "pos_rewrite_screening_origin_services", "pos_rewrite_screening_origin_system_authorities", "pos_rewrite_screening_origin_funding_declarations", "pos_rewrite_screening_origin_exchange_funding"} {
		originExec(t, db, "DROP TABLE IF EXISTS "+table)
	}
	for _, ddl := range []string{
		`CREATE TABLE users(id BIGINT PRIMARY KEY,status INT,is_block INT,is_disabled INT,is_two_fa INT,email VARCHAR(96),telephone VARCHAR(32))`,
		`CREATE TABLE orders(id BIGINT PRIMARY KEY,user_id BIGINT,payment_method INT,currency VARCHAR(8),pay_amt DECIMAL(12,2))`,
		`CREATE TABLE pos_rewrite_screening_origin_commands(id VARCHAR(36) PRIMARY KEY,origin VARCHAR(32),customer_id BIGINT,actor_id BIGINT NULL,store_id BIGINT NULL,counter_id BIGINT NULL,phase VARCHAR(16),order_id BIGINT,data JSON,proof_hash VARCHAR(64))`,
		`CREATE TABLE pos_rewrite_screening_origin_creations(command_id VARCHAR(36) PRIMARY KEY,order_id BIGINT,data JSON,proof_hash VARCHAR(64))`,
		`CREATE TABLE pos_rewrite_screening_origin_payments(command_id VARCHAR(36) PRIMARY KEY,order_id BIGINT,data JSON,proof_hash VARCHAR(64))`,
		`CREATE TABLE pos_rewrite_screening_origin_payment_attempts(command_id VARCHAR(36) PRIMARY KEY,order_id BIGINT,customer_id BIGINT,phase VARCHAR(16),data JSON,proof_hash VARCHAR(64),payload MEDIUMTEXT,response MEDIUMTEXT NULL)`,
		`CREATE TABLE pos_rewrite_screening_origin_go_effects(id VARCHAR(64) PRIMARY KEY,command_id VARCHAR(36),order_id BIGINT,kind VARCHAR(32),priority INT,sequence_no BIGINT,data JSON,proof_hash VARCHAR(64),phase VARCHAR(16),receipt JSON NULL,receipt_hash VARCHAR(64) NULL,updated_at_ms BIGINT)`,
		`CREATE TABLE pos_rewrite_screening_origin_stage_recoveries(recovery_id VARCHAR(36) PRIMARY KEY,command_id VARCHAR(36),order_id BIGINT,data JSON,proof_hash VARCHAR(64))`,
		`CREATE TABLE pos_rewrite_screening_origin_stage_recovery_uses(recovery_id VARCHAR(36) PRIMARY KEY,command_id VARCHAR(36),order_id BIGINT,data JSON,proof_hash VARCHAR(64))`,
		`CREATE TABLE pos_rewrite_screening_origin_services(id VARCHAR(16) PRIMARY KEY,data JSON,proof_hash VARCHAR(64),revoked INT)`,
		`CREATE TABLE pos_rewrite_screening_origin_system_authorities(command_id VARCHAR(36) PRIMARY KEY,data JSON,proof_hash VARCHAR(64))`,
		`CREATE TABLE pos_rewrite_screening_origin_funding_declarations(command_id VARCHAR(36) PRIMARY KEY,order_id BIGINT,data JSON,proof_hash VARCHAR(64))`,
		`CREATE TABLE pos_rewrite_screening_origin_exchange_funding(command_id VARCHAR(36) PRIMARY KEY,order_id BIGINT,data JSON,proof_hash VARCHAR(64))`,
		`INSERT INTO users VALUES(77,1,0,0,0,'fixture@example.test','9000000000')`,
		`INSERT INTO orders VALUES(700,77,3,'INR',500.00)`,
	} {
		originExec(t, db, ddl)
	}
	return db
}
func originExec(t *testing.T, db *sql.DB, q string, args ...interface{}) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatal(err)
	}
}
func originBytes(t *testing.T, v interface{}) string {
	t.Helper()
	b, e := originCanonical(v)
	if e != nil {
		t.Fatal(e)
	}
	return string(b)
}
func originSign(t *testing.T, purpose string, v interface{}) string {
	t.Helper()
	h, e := OriginMAC(originTestKey, purpose, v)
	if e != nil {
		t.Fatal(e)
	}
	return h
}
func originSeed(t *testing.T, db *sql.DB) (*OriginEngine, OriginCommand, OriginCreation, OriginAttempt, OriginPaymentAuthorization, OriginCaller) {
	order := "700"
	c := OriginCommand{Contract: "pos-screening-origin-command-v1", ID: originTestCommand, Origin: "customer", CustomerID: "77", NamespaceHash: originTestHash, RequestHash: originTestHash, CartHash: originTestHash, ReferenceHash: originTestHash, AuthorityHash: originTestHash, Quantity: 1, MarkerRows: 1, LineItemsEnabled: true, Phase: "BOUND", OrderID: &order, Lines: []OriginTicketLine{{"701", 1}}, Markers: []OriginMarker{{"702", "701"}}, Version: 3, CreatedAt: originTestNow - 1000, UpdatedAt: originTestNow - 500, ExpiresAt: originTestNow + 10000}
	source := OriginCreation{Contract: "pos-screening-origin-creation-v1", CommandID: c.ID, Origin: c.Origin, CustomerID: c.CustomerID, AuthorityHash: c.AuthorityHash, RequestHash: c.RequestHash, CartHash: c.CartHash, ReferenceHash: c.ReferenceHash, OrderID: order, Method: 1, HeaderHash: originTestHash, AllocationHash: originTestHash, Lines: []OriginLine{{"701", "390238", 1, originTestHash}}, TicketLines: c.Lines, Markers: c.Markers, LineItemsEnabled: true, EffectsHash: originTestHash, SourceCommit: OriginSourceCommit, CreatedAt: originTestNow - 500}
	seal := originSign(t, "creation", source)
	c.CreationHash = &seal
	if c.validate() != nil || source.validate(c) != nil {
		t.Fatal("invalid source fixture")
	}
	originExec(t, db, `INSERT INTO pos_rewrite_screening_origin_commands VALUES(?,?,77,NULL,NULL,NULL,'BOUND',700,?,?)`, c.ID, c.Origin, originBytes(t, c), originSign(t, "command", c))
	originExec(t, db, `INSERT INTO pos_rewrite_screening_origin_creations VALUES(?,700,?,?)`, c.ID, originBytes(t, source), seal)
	request := OriginProviderRequest{Provider: "juspay", OrderID: order, CustomerID: "77", StockMode: "legacy", CustomerFields: map[string]string{}, OrderFields: map[string]string{}}
	payload, payloadHash, err := originSeal(originTestKey, "payment-request:"+c.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	a := OriginAttempt{Contract: OriginPaymentsContract, CommandID: c.ID, OrderID: order, CustomerID: "77", CreationHash: seal, RequestHash: c.RequestHash, ReferenceHash: c.ReferenceHash, PaymentRequestHash: originTestHash, Phase: "PENDING", Provider: "juspay", PayloadHash: payloadHash, CreatedAt: originTestNow - 100, UpdatedAt: originTestNow - 100, Version: 1}
	originExec(t, db, `INSERT INTO pos_rewrite_screening_origin_payment_attempts VALUES(?,700,77,?,?,?, ?,NULL)`, c.ID, a.Phase, originBytes(t, a), originSign(t, "payment-attempt", a), payload)
	cap := OriginPaymentAuthorization{Contract: "pos-screening-origin-payment-submission-v1", CommandID: c.ID, OrderID: order, CustomerID: "77", CreationHash: seal, RequestHash: c.RequestHash, ReferenceHash: c.ReferenceHash, AuthorityHash: c.AuthorityHash, PaymentRequestHash: originTestHash, IssuedAt: originTestNow, ExpiresAt: originTestNow + 60000}
	engine := &OriginEngine{DB: db, Key: originTestKey, Clock: func() time.Time { return time.UnixMilli(originTestNow) }}
	caller := OriginCaller{CustomerID: "77", Credential: "genuine-new-login", CredentialExpiresAt: originTestNow + 60000}
	return engine, c, source, a, cap, caller
}

type originProviderSpy struct{ starts, reads int }

func (p *originProviderSpy) Start(context.Context, OriginProviderRequest) (OriginProviderResponse, error) {
	p.starts++
	return OriginProviderResponse{}, errors.New("fixture forbids provider start")
}
func (p *originProviderSpy) Recover(context.Context, OriginProviderRequest) (OriginProviderResponse, error) {
	p.reads++
	return OriginProviderResponse{}, errors.New("fixture lost acknowledgement")
}
func TestOriginNativeTerminalReadAndStartGuard(t *testing.T) {
	db := originFixture(t)
	e, c, source, a, cap, caller := originSeed(t, db)
	spy := &originProviderSpy{}
	e.Provider = spy
	caller.StageRecovery = "invalid expired header ignored by terminal GET"
	if _, err := e.Start(context.Background(), cap, caller, OriginPaymentInput{Order: 700, Method: 1}, "fixture"); !errors.Is(err, ErrReview) {
		t.Fatal("recovery-marked Start was not refused")
	}
	if _, err := e.NativeAuthorization(context.Background(), c.ID, caller, OriginPaymentInput{Order: 700, Method: 1}); !errors.Is(err, ErrReview) {
		t.Fatal("recovery-marked admission was not refused")
	}
	for _, phase := range []string{"CONFIRMED", "FAILED", "CAPTURED"} {
		a.Phase = phase
		originExec(t, db, `UPDATE pos_rewrite_screening_origin_payment_attempts SET phase=?,data=?,proof_hash=? WHERE command_id=?`, phase, originBytes(t, a), originSign(t, "payment-attempt", a), c.ID)
		if phase == "CONFIRMED" {
			p := OriginPayment{Contract: "pos-screening-origin-payment-v1", CommandID: c.ID, Origin: c.Origin, OrderID: a.OrderID, CustomerID: c.CustomerID, CreationHash: a.CreationHash, RequestHash: c.RequestHash, ReferenceHash: c.ReferenceHash, Method: source.Method, Status: phase, ObservationHash: originTestHash, Provider: "juspay", Before: OriginNativeEvidence{HeaderHash: source.HeaderHash, LinesHash: originTestHash}, After: OriginNativeEvidence{HeaderHash: source.HeaderHash, LinesHash: originTestHash}, EffectsHash: originTestHash, FundingBasis: "source-cod", SourceCommit: OriginPaymentsSourceCommit, CreatedAt: originTestNow}
			originExec(t, db, `INSERT INTO pos_rewrite_screening_origin_payments VALUES(?,700,?,?)`, c.ID, originBytes(t, p), originSign(t, "payment", p))
		}
		view, err := e.Read(context.Background(), cap, caller, true, "fixture")
		if err != nil || view.Status != phase {
			t.Fatalf("terminal %s: %#v %v", phase, view, err)
		}
	}
	if spy.starts != 0 || spy.reads != 0 {
		t.Fatal("terminal read or recovery admission contacted provider")
	}
}
func TestOriginNativeRecoveryUseAndLostACK(t *testing.T) {
	db := originFixture(t)
	e, c, _, a, cap, caller := originSeed(t, db)
	spy := &originProviderSpy{}
	e.Provider = spy
	// Current identity is derived by the production native authorizer, including
	// actual SQL JSON scalar types. Original command authority stays immutable.
	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	principal, err := OriginCurrentAuthority(context.Background(), tx, c, caller, e.Key, e.now())
	if err != nil {
		t.Fatal(err)
	}
	tx.Rollback()
	value := OriginStageRecovery{Contract: "pos-screening-origin-stage-recovery-v1", RecoveryID: originTestRecovery, CommandID: c.ID, Origin: c.Origin, OrderID: a.OrderID, CustomerID: c.CustomerID, CreationHash: a.CreationHash, RequestHash: c.RequestHash, ReferenceHash: c.ReferenceHash, OriginalAuthorityHash: c.AuthorityHash, PaymentRequestHash: a.PaymentRequestHash, PayloadHash: a.PayloadHash, AttemptVersion: a.Version, AttemptHash: originSign(t, "payment-attempt", a), CurrentAuthority: principal, CurrentAuthorityHash: originSign(t, "authority", principal), Reason: "session-renewal", IssuedAt: e.now(), ExpiresAt: e.now() + 60000, NoProviderStart: true}
	seal := originSign(t, "payment-stage-recovery", value)
	originExec(t, db, `INSERT INTO pos_rewrite_screening_origin_stage_recoveries VALUES(?,?,700,?,?)`, value.RecoveryID, c.ID, originBytes(t, value), seal)
	env := OriginEnvelope{Data: []byte(originBytes(t, value)), ProofHash: seal}
	caller.StageRecovery = base64.RawURLEncoding.EncodeToString([]byte(originBytes(t, env)))
	view, err := e.Read(context.Background(), cap, caller, true, "fixture")
	if err != nil || view.Status != "PENDING" || spy.reads != 1 || spy.starts != 0 {
		t.Fatalf("lost ACK recovery: %#v %v spy=%#v", view, err, spy)
	}
	var uses int
	if db.QueryRow(`SELECT COUNT(*) FROM pos_rewrite_screening_origin_stage_recovery_uses`).Scan(&uses) != nil || uses != 1 {
		t.Fatal("recovery use not durable before provider read")
	}
	a.Version++
	a.UpdatedAt++
	originExec(t, db, `UPDATE pos_rewrite_screening_origin_payment_attempts SET data=?,proof_hash=? WHERE command_id=?`, originBytes(t, a), originSign(t, "payment-attempt", a), c.ID)
	if _, err = e.Read(context.Background(), cap, caller, true, "fixture"); err != nil || spy.reads != 2 {
		t.Fatalf("same attempt metadata replay refused: %v", err)
	}
	caller.Credential = "different-login"
	if _, err = e.Read(context.Background(), cap, caller, true, "fixture"); err == nil || spy.reads != 2 {
		t.Fatal("recovery crossed its current principal")
	}
}
func TestOriginNativeEffectReadNeverRedispatches(t *testing.T) {
	db := originFixture(t)
	e, c, _, _, cap, caller := originSeed(t, db)
	collector := NewOriginEffectCollector(c, "fixture", e.Key)
	if collector.Add("order-email", "", "", 0, 0, false) != nil {
		t.Fatal("effect add")
	}
	tx, _ := db.BeginTx(context.Background(), nil)
	if _, err := collector.persist(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if tx.Commit() != nil {
		t.Fatal("effect commit")
	}
	originExec(t, db, `UPDATE pos_rewrite_screening_origin_go_effects SET phase='UNCERTAIN'`)
	view, err := e.Effects(context.Background(), cap, caller)
	if err != nil || view.Status != "UNCERTAIN" || !view.DispatchBlocked || len(view.Effects) != 1 {
		t.Fatalf("effect read: %#v %v", view, err)
	}
	sent := 0
	if err := DispatchOriginEffects(context.Background(), db, e.Key, map[string]OriginEffectHandler{"order-email": func(context.Context, OriginEffect) (OriginEffectReceipt, error) {
		sent++
		return OriginEffectReceipt{}, nil
	}}, 1, nil); err != nil || sent != 0 {
		t.Fatal("uncertain effect was resent")
	}
	originExec(t, db, `UPDATE pos_rewrite_screening_origin_go_effects SET phase='ACCEPTED',receipt='{}',receipt_hash=?`, originTestHash)
	if _, err = e.Effects(context.Background(), cap, caller); err == nil {
		t.Fatal("forged acceptance receipt was readable")
	}
}
func TestOriginNativeFundingSeparatesCashFromBank(t *testing.T) {
	db := originFixture(t)
	e, c, source, _, _, _ := originSeed(t, db)
	ctx := context.Background()
	for _, entry := range []struct {
		method        int64
		status, basis string
		allowed       bool
	}{{1, "DIRECT", "source-cod", true}, {14, "DIRECT", "source-coc", true}, {3, "DIRECT", "", false}, {3, "CHARGED", "provider-charged", true}} {
		tx, _ := db.BeginTx(ctx, nil)
		source.Method = entry.method
		basis, hash, err := e.funding(ctx, tx, c, source, OriginProviderResponse{Status: entry.status})
		tx.Rollback()
		if (err == nil) != entry.allowed || entry.allowed && (basis != entry.basis || hash != nil) {
			t.Fatalf("funding method%d status%s basis%s %v", entry.method, entry.status, basis, err)
		}
	}
}
func TestOriginNativeCSKFundingRetainsOriginalDeclarationAfterRotation(t *testing.T) {
	db := originFixture(t)
	e, c, source, _, _, _ := originSeed(t, db)
	ctx := context.Background()
	c.Origin = "external-system"
	source.Method = 3
	e.CSKAPIKey = "fixture-current-csk-credential"
	service := map[string]interface{}{"contract": "pos-screening-origin-system-service-v1", "id": "csk", "revision": "1", "credentialHash": originSign(t, "system-credential", e.CSKAPIKey), "configurationHash": originTestHash, "sourceController": "controllers.external.OrderPlacement", "active": true}
	authority := map[string]interface{}{"contract": "pos-screening-origin-system-authority-v1", "commandId": c.ID, "customerId": c.CustomerID, "requestHash": c.RequestHash, "referenceHash": c.ReferenceHash, "serviceId": "csk", "serviceRevision": "1", "credentialHash": service["credentialHash"], "configurationHash": service["configurationHash"]}
	source.SystemAuthorityHash = originSign(t, "system-authority", authority)
	source.Origin = c.Origin
	creationSeal := originSign(t, "creation", source)
	c.CreationHash = &creationSeal
	originExec(t, db, `UPDATE pos_rewrite_screening_origin_commands SET origin=?,data=?,proof_hash=? WHERE id=?`, c.Origin, originBytes(t, c), originSign(t, "command", c), c.ID)
	originExec(t, db, `UPDATE pos_rewrite_screening_origin_creations SET data=?,proof_hash=? WHERE command_id=?`, originBytes(t, source), creationSeal, c.ID)
	originExec(t, db, `INSERT INTO pos_rewrite_screening_origin_services VALUES('csk',?,?,0)`, originBytes(t, service), originSign(t, "system-service", service))
	originExec(t, db, `INSERT INTO pos_rewrite_screening_origin_system_authorities VALUES(?,?,?)`, c.ID, originBytes(t, authority), source.SystemAuthorityHash)
	tx, _ := db.BeginTx(ctx, nil)
	basis, seal, err := e.funding(ctx, tx, c, source, OriginProviderResponse{Status: "DIRECT"})
	if err != nil || basis != "external-system-csk-prepaid" || seal == nil {
		tx.Rollback()
		t.Fatalf("native CSK declaration: %s %v", basis, err)
	}
	if tx.Commit() != nil {
		t.Fatal("funding commit")
	}
	service["revision"] = "2"
	service["credentialHash"] = originSign(t, "system-credential", "rotated-key")
	originExec(t, db, `UPDATE pos_rewrite_screening_origin_services SET data=?,proof_hash=? WHERE id='csk'`, originBytes(t, service), originSign(t, "system-service", service))
	tx, _ = db.BeginTx(ctx, nil)
	defer tx.Rollback()
	receipt := OriginPayment{FundingBasis: basis, FundingHash: seal, CreatedAt: originTestNow + 1000}
	if err = verifyOriginFunding(ctx, tx, c, source, receipt, e.Key); err != nil {
		t.Fatal("retained funding declaration changed after service rotation", err)
	}
	if _, _, err = e.funding(ctx, tx, c, source, OriginProviderResponse{Status: "DIRECT"}); err == nil {
		t.Fatal("rotated original service retained new dispatch authority")
	}
}
func TestOriginProofKeyBounds(t *testing.T) {
	for _, entry := range []struct {
		value string
		valid bool
	}{{strings.Repeat("x", 31), false}, {strings.Repeat("x", 32), true}, {strings.Repeat("x", 4096), true}, {strings.Repeat("x", 4097), false}, {strings.Repeat("x", 32) + "\n", false}} {
		if originKey.MatchString(entry.value) != entry.valid {
			t.Fatalf("proof key length=%d", len(entry.value))
		}
	}
}
