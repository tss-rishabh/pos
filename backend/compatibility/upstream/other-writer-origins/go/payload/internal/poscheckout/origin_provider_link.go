package poscheckout

import (
	"context"
	"database/sql"
	"errors"
)

// A genuine authenticated Gokwik callback supplies the original identifiers
// when the create ACK was lost. An authenticated payment/verify read must agree
// before this immutable link can be retained. It is not a CREATED/paid row.
type OriginGokwikLink struct {
	Contract string `json:"contract"`;CommandID string `json:"commandId"`;OrderID string `json:"orderId"`;CustomerID string `json:"customerId"`
	CreationHash string `json:"creationHash"`;RequestHash string `json:"requestHash"`;PayloadHash string `json:"payloadHash"`
	RequestID string `json:"requestId"`;ProviderReference string `json:"providerReference"`;CallbackHash string `json:"callbackHash"`;VerificationHash string `json:"verificationHash"`
	DispatchStartedAt int64 `json:"dispatchStartedAt"`;CreatedAt int64 `json:"createdAt"`
}
func originReadGokwikLink(ctx context.Context,tx *sql.Tx,c OriginCommand,key string)(*OriginGokwikLink,error){
	var v OriginGokwikLink;var raw []byte;var seal,order string
	err:=tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_gokwik_links WHERE command_id=? FOR SHARE`,c.ID).Scan(&order,&raw,&seal);if errors.Is(err,sql.ErrNoRows){return nil,nil};if err!=nil{return nil,err}
	if originVerify(key,"gokwik-link",raw,seal,&v,16000)!=nil||v.Contract!="pos-screening-origin-gokwik-link-v1"||v.CommandID!=c.ID||c.OrderID==nil||v.OrderID!=*c.OrderID||order!=v.OrderID||v.CustomerID!=c.CustomerID||c.CreationHash==nil||v.CreationHash!=*c.CreationHash||v.RequestHash!=c.RequestHash||len(v.RequestID)<1||len(v.RequestID)>255||len(v.ProviderReference)<1||len(v.ProviderReference)>255||!originPoint(v.DispatchStartedAt)||v.CreatedAt<v.DispatchStartedAt{return nil,ErrReview}
	for _,h:=range []string{v.PayloadHash,v.CallbackHash,v.VerificationHash}{if !originHash.MatchString(h){return nil,ErrReview}}
	a,_,_,err:=originReadAttempt(ctx,tx,c.ID,key);if err!=nil||a.Provider!="gokwik"||a.PayloadHash!=v.PayloadHash||a.CreatedAt!=v.DispatchStartedAt{return nil,ErrReview};return &v,nil
}
func(e *OriginEngine)RecordGokwikLink(ctx context.Context,order,request,reference,callbackHash,verificationHash string)error{
	if e.ready(false)!=nil||!originIdentifier(order)||len(request)<1||len(request)>255||len(reference)<1||len(reference)>255||!originHash.MatchString(callbackHash)||!originHash.MatchString(verificationHash){return ErrReview}
	tx,err:=e.DB.BeginTx(ctx,&sql.TxOptions{Isolation:sql.LevelReadCommitted});if err!=nil{return err};defer tx.Rollback();var command,customer string
	if tx.QueryRowContext(ctx,`SELECT id,CAST(customer_id AS CHAR) FROM pos_rewrite_screening_origin_commands WHERE order_id=?`,order).Scan(&command,&customer)!=nil{return ErrReview}
	c,err:=ReadOriginCommand(ctx,tx,command,customer,e.Key,true);if err!=nil{return err};if _,err=ReadOriginCreation(ctx,tx,c,e.Key);err!=nil{return err}
	a,_,_,err:=originReadAttempt(ctx,tx,c.ID,e.Key);if err!=nil||a.Provider!="gokwik"{return ErrReview}
	prior,err:=originReadGokwikLink(ctx,tx,c,e.Key);if err!=nil{return err};if prior!=nil{if prior.RequestID!=request||prior.ProviderReference!=reference{return ErrReview};return tx.Commit()}
	v:=OriginGokwikLink{Contract:"pos-screening-origin-gokwik-link-v1",CommandID:c.ID,OrderID:order,CustomerID:customer,CreationHash:*c.CreationHash,RequestHash:c.RequestHash,PayloadHash:a.PayloadHash,RequestID:request,ProviderReference:reference,CallbackHash:callbackHash,VerificationHash:verificationHash,DispatchStartedAt:a.CreatedAt,CreatedAt:e.now()}
	raw,err:=originCanonical(v);if err!=nil{return err};seal,err:=OriginMAC(e.Key,"gokwik-link",v);if err!=nil{return err};if _,err=tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_gokwik_links(command_id,order_id,data,proof_hash) VALUES(?,?,?,?)`,c.ID,order,string(raw),seal);err!=nil{return err};return tx.Commit()
}
func ReadOriginGokwikLink(ctx context.Context,db *sql.DB,key,order string)(*OriginGokwikLink,error){
	if db==nil||!originKey.MatchString(key)||!originIdentifier(order){return nil,ErrReview};tx,err:=db.BeginTx(ctx,&sql.TxOptions{Isolation:sql.LevelReadCommitted});if err!=nil{return nil,err};defer tx.Rollback();var command,customer string
	if tx.QueryRowContext(ctx,`SELECT id,CAST(customer_id AS CHAR) FROM pos_rewrite_screening_origin_commands WHERE order_id=?`,order).Scan(&command,&customer)!=nil{return nil,ErrReview}
	c,err:=ReadOriginCommand(ctx,tx,command,customer,key,false);if err!=nil{return nil,err};v,err:=originReadGokwikLink(ctx,tx,c,key);if err!=nil{return nil,err};return v,tx.Commit()
}
func ReadOriginGokwikLinkInTransaction(ctx context.Context,tx *sql.Tx,c OriginCommand,key string)(*OriginGokwikLink,error){return originReadGokwikLink(ctx,tx,c,key)}
func verifyOriginGokwikNative(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,p OriginPayment,key string)error{
	if p.Provider!="gokwik"||p.FundingBasis!="provider-charged"{return nil};var raw []byte;var seal,order,input string;var value map[string]interface{}
	if tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),input_hash,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_gokwik_native_events WHERE command_id=? FOR SHARE`,c.ID).Scan(&order,&input,&raw,&seal)!=nil||originVerify(key,"gokwik-native",raw,seal,&value,16000)!=nil||value["contract"]!="pos-screening-origin-gokwik-native-v1"||value["commandId"]!=c.ID||value["orderId"]!=creation.OrderID||order!=creation.OrderID||value["customerId"]!=c.CustomerID||value["creationHash"]!=*c.CreationHash||value["requestHash"]!=c.RequestHash||value["observationHash"]!=p.ObservationHash||value["inputHash"]!=input||!originHash.MatchString(input)||value["status"]!="SUCCESS"||value["sourceCommit"]!=OriginPaymentsSourceCommit{return ErrReview};return nil
}
