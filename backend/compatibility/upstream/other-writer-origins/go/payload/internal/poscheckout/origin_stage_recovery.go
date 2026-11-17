package poscheckout

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
)

// Source issues this only after genuine CURRENT authentication and inspection
// of an already-started immutable original payment attempt. It never grants a
// new order, SENDING checkpoint, provider Start or changed financial payload.
type OriginStageRecovery struct {
	Contract string `json:"contract"`;RecoveryID string `json:"recoveryId"`;CommandID string `json:"commandId"`;Origin string `json:"origin"`;OrderID string `json:"orderId"`;CustomerID string `json:"customerId"`
	ActorID *string `json:"actorId"`;StoreID *string `json:"storeId"`;CounterID *string `json:"counterId"`
	CreationHash string `json:"creationHash"`;RequestHash string `json:"requestHash"`;ReferenceHash string `json:"referenceHash"`;OriginalAuthorityHash string `json:"originalAuthorityHash"`;PaymentRequestHash string `json:"paymentRequestHash"`;PayloadHash string `json:"payloadHash"`
	AttemptVersion int64 `json:"attemptVersion"`;AttemptHash string `json:"attemptHash"`;CurrentAuthority map[string]interface{} `json:"currentAuthority"`;CurrentAuthorityHash string `json:"currentAuthorityHash"`
	Reason string `json:"reason"`;IssuedAt int64 `json:"issuedAt"`;ExpiresAt int64 `json:"expiresAt"`;NoProviderStart bool `json:"noProviderStart"`
}
type OriginStageRecoveryUse struct {
	Contract string `json:"contract"`;RecoveryID string `json:"recoveryId"`;CommandID string `json:"commandId"`;OrderID string `json:"orderId"`;CustomerID string `json:"customerId"`
	RecoveryHash string `json:"recoveryHash"`;CreationHash string `json:"creationHash"`;RequestHash string `json:"requestHash"`;PaymentRequestHash string `json:"paymentRequestHash"`;PayloadHash string `json:"payloadHash"`;Provider string `json:"provider"`
	AttemptVersion int64 `json:"attemptVersion"`;AttemptHash string `json:"attemptHash"`;AttemptCreatedAt int64 `json:"attemptCreatedAt"`;CurrentAuthorityHash string `json:"currentAuthorityHash"`;AcceptedAt int64 `json:"acceptedAt"`;ExpiresAt int64 `json:"expiresAt"`
}
func(e *OriginEngine)stageRecovery(ctx context.Context,u *originUnit,a OriginAttempt,cap OriginPaymentAuthorization,header string,requireUse bool)error{
	if len(header)<1||len(header)>30000{return ErrReview};var envelope OriginEnvelope;var value OriginStageRecovery;decoded,err:=base64.RawURLEncoding.DecodeString(header)
	if err!=nil||OriginDecode(decoded,&envelope,22000)!=nil||originVerify(e.Key,"payment-stage-recovery",envelope.Data,envelope.ProofHash,&value,16000)!=nil{return ErrReview}
	c:=u.command;now:=e.now()
	switch value.Reason{case "service-rotation","customer-contact-changed","source-reconciliation","session-renewal":default:return ErrReview}
	if value.Contract!="pos-screening-origin-stage-recovery-v1"||!originUUID.MatchString(value.RecoveryID)||value.CommandID!=c.ID||value.Origin!=c.Origin||value.OrderID!=a.OrderID||value.CustomerID!=c.CustomerID||!originSame(value.ActorID,c.ActorID)||!originSame(value.StoreID,c.StoreID)||!originSame(value.CounterID,c.CounterID)||value.CreationHash!=a.CreationHash||value.RequestHash!=c.RequestHash||value.ReferenceHash!=c.ReferenceHash||value.OriginalAuthorityHash!=c.AuthorityHash||value.PaymentRequestHash!=a.PaymentRequestHash||value.PaymentRequestHash!=cap.PaymentRequestHash||value.PayloadHash!=a.PayloadHash||value.AttemptVersion<1||!originHash.MatchString(value.AttemptHash)||!originHash.MatchString(value.CurrentAuthorityHash)||!value.NoProviderStart||!originPoint(value.IssuedAt)||!originPoint(value.ExpiresAt)||value.IssuedAt>now||value.ExpiresAt<=now||value.ExpiresAt>value.IssuedAt+60000||len(value.Reason)<1||len(value.Reason)>500||u.currentAuthority==nil{return ErrReview}
	currentHash,err:=OriginMAC(e.Key,"authority",u.currentAuthority);if err!=nil||currentHash!=value.CurrentAuthorityHash||!originEqual(u.currentAuthority,value.CurrentAuthority){return ErrReview}
	var sourceRaw []byte;var sourceSeal,sourceCommand,sourceOrder string;var actual OriginStageRecovery
	if u.tx.QueryRowContext(ctx,`SELECT command_id,CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_stage_recoveries WHERE recovery_id=? FOR SHARE`,value.RecoveryID).Scan(&sourceCommand,&sourceOrder,&sourceRaw,&sourceSeal)!=nil||sourceCommand!=c.ID||sourceOrder!=a.OrderID||sourceSeal!=envelope.ProofHash||originVerify(e.Key,"payment-stage-recovery",sourceRaw,sourceSeal,&actual,16000)!=nil||!originEqual(actual,value){return ErrReview}
	var use OriginStageRecoveryUse;var raw []byte;var seal,command,order string
	err=u.tx.QueryRowContext(ctx,`SELECT command_id,CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_stage_recovery_uses WHERE recovery_id=? FOR UPDATE`,value.RecoveryID).Scan(&command,&order,&raw,&seal)
	if err==nil{
		if originVerify(e.Key,"payment-stage-recovery-use",raw,seal,&use,16000)!=nil||use.Contract!="pos-screening-origin-stage-recovery-use-v1"||use.RecoveryID!=value.RecoveryID||use.CommandID!=c.ID||command!=c.ID||use.OrderID!=a.OrderID||order!=a.OrderID||use.CustomerID!=c.CustomerID||use.RecoveryHash!=envelope.ProofHash||use.CreationHash!=a.CreationHash||use.RequestHash!=a.RequestHash||use.PaymentRequestHash!=a.PaymentRequestHash||use.PayloadHash!=a.PayloadHash||use.Provider!=a.Provider||use.AttemptVersion!=value.AttemptVersion||use.AttemptHash!=value.AttemptHash||use.AttemptCreatedAt!=a.CreatedAt||use.AttemptVersion>a.Version||use.CurrentAuthorityHash!=currentHash||use.ExpiresAt!=value.ExpiresAt||use.AcceptedAt<value.IssuedAt||use.AcceptedAt>=use.ExpiresAt{return ErrReview}
		// Metadata observations may advance the SAME attempt; original payload,
		// provider reference, authority, lease and payment request never change.
		if a.Phase!="SENDING"&&a.Phase!="PENDING"&&a.Phase!="UNCERTAIN"{return ErrReview};return nil
	}
	if !errors.Is(err,sql.ErrNoRows){return err};if requireUse||a.Phase!="SENDING"&&a.Phase!="PENDING"&&a.Phase!="UNCERTAIN"||a.Version!=value.AttemptVersion{return ErrReview}
	var nativeHash string;if u.tx.QueryRowContext(ctx,`SELECT proof_hash FROM pos_rewrite_screening_origin_payment_attempts WHERE command_id=?`,c.ID).Scan(&nativeHash)!=nil||nativeHash!=value.AttemptHash{return ErrReview}
	use=OriginStageRecoveryUse{Contract:"pos-screening-origin-stage-recovery-use-v1",RecoveryID:value.RecoveryID,CommandID:c.ID,OrderID:a.OrderID,CustomerID:c.CustomerID,RecoveryHash:envelope.ProofHash,CreationHash:a.CreationHash,RequestHash:a.RequestHash,PaymentRequestHash:a.PaymentRequestHash,PayloadHash:a.PayloadHash,Provider:a.Provider,AttemptVersion:a.Version,AttemptHash:nativeHash,AttemptCreatedAt:a.CreatedAt,CurrentAuthorityHash:currentHash,AcceptedAt:now,ExpiresAt:value.ExpiresAt}
	raw,err=originCanonical(use);if err!=nil{return err};seal,err=OriginMAC(e.Key,"payment-stage-recovery-use",use);if err!=nil{return err};_,err=u.tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_stage_recovery_uses(recovery_id,command_id,order_id,data,proof_hash) VALUES(?,?,?,?,?)`,value.RecoveryID,c.ID,a.OrderID,string(raw),seal);return err
}
