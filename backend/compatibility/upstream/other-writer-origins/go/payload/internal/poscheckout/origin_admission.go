package poscheckout

import (
	"context"
	"database/sql"
	"errors"
)

// This is evidence about this original Go dispatcher only. Source order/HP,
// staged coupons or membership may already exist; it is not a refund, bank
// outcome, deletion authorization or claim that those source effects vanished.
type OriginPaymentNoEffect struct {
	Contract string `json:"contract"`;CommandID string `json:"commandId"`;OrderID string `json:"orderId"`;CustomerID string `json:"customerId"`
	CreationHash string `json:"creationHash"`;RequestHash string `json:"requestHash"`;ReferenceHash string `json:"referenceHash"`;AuthorityHash string `json:"authorityHash"`;PaymentRequestHash string `json:"paymentRequestHash"`
	Reason string `json:"reason"`;NoProviderDispatch bool `json:"noProviderDispatch"`;SourceCommit string `json:"sourceCommit"`;CreatedAt int64 `json:"createdAt"`
}
type OriginPaymentNoEffectEnvelope struct {Data OriginPaymentNoEffect `json:"data"`;ProofHash string `json:"proofHash"`}

func originReadNoEffect(ctx context.Context,tx *sql.Tx,c OriginCommand,cap OriginPaymentAuthorization,key string)(*OriginPaymentNoEffectEnvelope,error){
	var v OriginPaymentNoEffect;var raw []byte;var order,seal string
	err:=tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_payment_no_effects WHERE command_id=? FOR SHARE`,c.ID).Scan(&order,&raw,&seal)
	if errors.Is(err,sql.ErrNoRows){return nil,nil};if err!=nil{return nil,err}
	if originVerify(key,"payment-no-effect",raw,seal,&v,16000)!=nil||v.Contract!="pos-screening-origin-payment-no-effect-v1"||v.CommandID!=c.ID||c.OrderID==nil||v.OrderID!=*c.OrderID||order!=v.OrderID||v.CustomerID!=c.CustomerID||c.CreationHash==nil||v.CreationHash!=*c.CreationHash||v.RequestHash!=c.RequestHash||v.ReferenceHash!=c.ReferenceHash||v.AuthorityHash!=c.AuthorityHash||v.PaymentRequestHash!=cap.PaymentRequestHash||!v.NoProviderDispatch||v.SourceCommit!=OriginPaymentsSourceCommit||!originPoint(v.CreatedAt){return nil,ErrReview}
	switch v.Reason{case "CONFIGURATION_UNAVAILABLE","NATIVE_INPUT_CHANGED","ASSET_EVIDENCE_UNAVAILABLE","COUPON_EVIDENCE_UNAVAILABLE","PROVIDER_INPUT_UNAVAILABLE":default:return nil,ErrReview}
	return &OriginPaymentNoEffectEnvelope{v,seal},nil
}
func(e *OriginEngine)rejectUnsent(ctx context.Context,u *originUnit,cap OriginPaymentAuthorization,reason string)(OriginPaymentView,error){
	// Caller owns the original command/customer/Order serialization. Every
	// sender checks this fence under the same lock before writing SENDING.
	a,payload,response,err:=originReadAttempt(ctx,u.tx,u.command.ID,e.Key)
	if err==nil{if a.PaymentRequestHash!=cap.PaymentRequestHash{return OriginPaymentView{},ErrReview};view,err:=e.view(ctx,u,a,payload,response);if err!=nil{return view,err};return view,u.commit(ctx)};if !errors.Is(err,sql.ErrNoRows){return OriginPaymentView{},err}
	prior,err:=originReadNoEffect(ctx,u.tx,u.command,cap,e.Key);if err!=nil{return OriginPaymentView{},err};if prior!=nil{return OriginPaymentView{Status:"NO_EFFECT",CommandID:u.command.ID,OrderID:cap.OrderID,NoEffect:prior},u.commit(ctx)}
	var status int64;var paid int64;if u.tx.QueryRowContext(ctx,`SELECT order_status,payment_status FROM orders WHERE id=?`,cap.OrderID).Scan(&status,&paid)!=nil||status!=0||paid!=1&&paid!=0{return OriginPaymentView{},ErrReview}
	var count int;if u.tx.QueryRowContext(ctx,`SELECT COUNT(*) FROM pos_rewrite_screening_origin_payments WHERE command_id=?`,u.command.ID).Scan(&count)!=nil||count!=0{return OriginPaymentView{},ErrReview}
	v:=OriginPaymentNoEffect{Contract:"pos-screening-origin-payment-no-effect-v1",CommandID:u.command.ID,OrderID:cap.OrderID,CustomerID:u.command.CustomerID,CreationHash:cap.CreationHash,RequestHash:cap.RequestHash,ReferenceHash:cap.ReferenceHash,AuthorityHash:cap.AuthorityHash,PaymentRequestHash:cap.PaymentRequestHash,Reason:reason,NoProviderDispatch:true,SourceCommit:OriginPaymentsSourceCommit,CreatedAt:e.now()}
	raw,err:=originCanonical(v);if err!=nil{return OriginPaymentView{},err};seal,err:=OriginMAC(e.Key,"payment-no-effect",v);if err!=nil{return OriginPaymentView{},err}
	if _,err=u.tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_payment_no_effects(command_id,order_id,data,proof_hash) VALUES(?,?,?,?)`,v.CommandID,v.OrderID,string(raw),seal);err!=nil{return OriginPaymentView{},err}
	return OriginPaymentView{Status:"NO_EFFECT",CommandID:v.CommandID,OrderID:v.OrderID,NoEffect:&OriginPaymentNoEffectEnvelope{v,seal}},u.commit(ctx)
}
func originNoEffectRequestHash(ctx context.Context,tx *sql.Tx,c OriginCommand,key string)(string,error){
	var raw []byte;var seal string;var v OriginPaymentNoEffect
	err:=tx.QueryRowContext(ctx,`SELECT CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_payment_no_effects WHERE command_id=? FOR SHARE`,c.ID).Scan(&raw,&seal);if err!=nil{return "",err};if originVerify(key,"payment-no-effect",raw,seal,&v,16000)!=nil||!originHash.MatchString(v.PaymentRequestHash){return "",ErrReview}
	cap:=OriginPaymentAuthorization{PaymentRequestHash:v.PaymentRequestHash};fence,err:=originReadNoEffect(ctx,tx,c,cap,key);if err!=nil||fence==nil{return "",ErrReview};return v.PaymentRequestHash,nil
}
