package poscheckout

import (
	"context"
	"database/sql"
)

type OriginExchangeReference struct {OrderID string `json:"orderId"`;HeaderHash string `json:"headerHash"`;AllocationHash string `json:"allocationHash"`;OrderStatus int64 `json:"orderStatus"`;PaymentStatus int64 `json:"paymentStatus"`}
type OriginReshippingReference struct {ID string `json:"id"`;InputHash string `json:"inputHash"`}
type OriginExchangeSelection struct {Selector string `json:"selector"`;Reference *OriginExchangeReference `json:"reference"`;Reshipping *OriginReshippingReference `json:"reshipping"`}
type OriginExchangeFundingReader func(context.Context,*sql.Tx,OriginCommand,OriginCreation)(*OriginExchangeSelection,error)
type OriginExchangeFunding struct {
	Contract string `json:"contract"`;CommandID string `json:"commandId"`;OrderID string `json:"orderId"`;CustomerID string `json:"customerId"`
	CreationHash string `json:"creationHash"`;RequestHash string `json:"requestHash"`;ReferenceHash string `json:"referenceHash"`;AuthorityHash string `json:"authorityHash"`;AllocationHash string `json:"allocationHash"`;HeaderHash string `json:"headerHash"`
	Selection OriginExchangeSelection `json:"selection"`;Declaration string `json:"declaration"`;SourceCommit string `json:"sourceCommit"`;CreatedAt int64 `json:"createdAt"`
}
func validOriginExchange(v OriginExchangeSelection)bool{
	switch v.Selector{case "express-parent","original-prepaid":if v.Reference==nil||v.Reshipping!=nil{return false};case "reshipping":if v.Reshipping==nil||!originIdentifier(v.Reshipping.ID)||!originHash.MatchString(v.Reshipping.InputHash){return false};default:return false}
	if v.Reference!=nil&&(!originIdentifier(v.Reference.OrderID)||!originHash.MatchString(v.Reference.HeaderHash)||!originHash.MatchString(v.Reference.AllocationHash)){return false};return true
}
func(e *OriginEngine)exchangeFunding(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,selection OriginExchangeSelection)(string,*string,error){
	if !validOriginExchange(selection){return "",nil,ErrReview}
	v:=OriginExchangeFunding{Contract:"pos-screening-origin-exchange-funding-v1",CommandID:c.ID,OrderID:creation.OrderID,CustomerID:c.CustomerID,CreationHash:*c.CreationHash,RequestHash:c.RequestHash,ReferenceHash:c.ReferenceHash,AuthorityHash:c.AuthorityHash,AllocationHash:creation.AllocationHash,HeaderHash:creation.HeaderHash,Selection:selection,Declaration:"original-source-exchange",SourceCommit:OriginPaymentsSourceCommit,CreatedAt:e.now()}
	raw,err:=originCanonical(v);if err!=nil{return "",nil,err};seal,err:=OriginMAC(e.Key,"exchange-funding",v);if err!=nil{return "",nil,err};if _,err=tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_exchange_funding(command_id,order_id,data,proof_hash) VALUES(?,?,?,?)`,c.ID,creation.OrderID,string(raw),seal);err!=nil{return "",nil,err};return "source-exchange",&seal,nil
}
func verifyOriginExchangeFunding(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,p OriginPayment,key string)error{
	var raw []byte;var seal,order string;var v OriginExchangeFunding
	if p.FundingHash==nil||tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_exchange_funding WHERE command_id=? FOR SHARE`,c.ID).Scan(&order,&raw,&seal)!=nil||seal!=*p.FundingHash||originVerify(key,"exchange-funding",raw,seal,&v,16000)!=nil||v.Contract!="pos-screening-origin-exchange-funding-v1"||v.CommandID!=c.ID||v.OrderID!=creation.OrderID||order!=v.OrderID||v.CustomerID!=c.CustomerID||v.CreationHash!=*c.CreationHash||v.RequestHash!=c.RequestHash||v.ReferenceHash!=c.ReferenceHash||v.AuthorityHash!=c.AuthorityHash||v.AllocationHash!=creation.AllocationHash||v.HeaderHash!=creation.HeaderHash||!validOriginExchange(v.Selection)||v.Declaration!="original-source-exchange"||v.SourceCommit!=OriginPaymentsSourceCommit||!originPoint(v.CreatedAt)||v.CreatedAt>p.CreatedAt{return ErrReview};return nil
}
