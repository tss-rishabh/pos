package juspay

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"time"
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"github.com/jinzhu/gorm"
)

// Original Gokwik SUCCESS audit, appended in the same native transaction as
// the genuine source confirmation. The source table has no modeled row ID;
// retain its exact native content hash rather than inventing an identifier.
func recordOtherOriginGokwikSuccess(ctx context.Context,tx *sql.Tx,db *gorm.DB,scope poscheckout.OriginApplyContext,key string)error{
	o:=scope.Observation;if o.Status!="CHARGED"||scope.Provider!="gokwik"||o.GatewayReference==""{return poscheckout.ErrReview}
	var row GokwikOrder;res:=db.Set("gorm:query_option","FOR UPDATE").Where("order_id=? AND status='CREATED'",scope.Creation.OrderID).Order("created_at").First(&row)
	if res.Error!=nil&&!gorm.IsRecordNotFoundError(res.Error){return res.Error}
	if row.RequestId==""{
		link,err:=poscheckout.ReadOriginGokwikLinkInTransaction(ctx,tx,scope.Command,key);if err!=nil||link==nil||link.ProviderReference!=o.ProviderReference{return poscheckout.ErrReview}
		row=GokwikOrder{OrderId:uint(originParseID(scope.Creation.OrderID)),UserId:uint(originParseID(scope.Command.CustomerID)),RequestId:link.RequestID,GokwikOID:link.ProviderReference,MOID:scope.Creation.OrderID,OrderType:"upi"}
	}else if row.GokwikOID!=o.ProviderReference||row.UserId!=uint(originParseID(scope.Command.CustomerID))||row.OrderId!=uint(originParseID(scope.Creation.OrderID))||row.OrderType!="upi"{return poscheckout.ErrReview}
	row.TransactionID=o.GatewayReference;row.OrderStatus="paid";if row.Total==""{row.Total=strconv.FormatInt(o.AmountPaise/100,10)+"."+func()string{v:=strconv.FormatInt(o.AmountPaise%100,10);if len(v)==1{return "0"+v};return v}()};row.StatusCode=200;row.StatusMessage=o.ProviderMessage;row.Status="SUCCESS";row.CreatedAt=time.Now();row.UpdatedAt=row.CreatedAt
	var count int;if db.Table("gokwik_orders").Where("order_id=? AND status='SUCCESS'",row.OrderId).Count(&count).Error!=nil||count!=0{return poscheckout.ErrReview};if db.Create(&row).Error!=nil{return poscheckout.ErrReview}
	const native="LOWER(SHA2(CAST(JSON_OBJECT('orderId',order_id,'customerId',user_id,'requestId',request_id,'providerReference',gokwik_oid,'transactionId',transaction_id,'orderStatus',order_status,'total',total,'merchantOrderId',moid,'merchantId',mid,'phone',phone,'orderType',order_type,'statusCode',status_code,'statusMessage',status_message,'status',status,'createdAt',DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s'),'updatedAt',DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))"
	rows,err:=tx.QueryContext(ctx,`SELECT `+native+` FROM gokwik_orders WHERE order_id=? AND status='SUCCESS' AND gokwik_oid=? AND transaction_id=? LIMIT 2 FOR SHARE`,scope.Creation.OrderID,o.ProviderReference,o.GatewayReference);if err!=nil{return err};var hash string;if !rows.Next()||rows.Scan(&hash)!=nil||rows.Next(){rows.Close();return poscheckout.ErrReview};err=rows.Err();rows.Close();if err!=nil{return err}
	observation,err:=poscheckout.OriginMAC(key,"payment-observation",o);if err!=nil{return err}
	data:=map[string]interface{}{"contract":"pos-screening-origin-gokwik-native-v1","commandId":scope.Command.ID,"orderId":scope.Creation.OrderID,"customerId":scope.Command.CustomerID,"creationHash":*scope.Command.CreationHash,"requestHash":scope.Command.RequestHash,"observationHash":observation,"inputHash":hash,"status":"SUCCESS","sourceCommit":poscheckout.OriginPaymentsSourceCommit,"createdAt":row.CreatedAt.UnixMilli()}
	raw,err:=json.Marshal(data);if err!=nil{return err};seal,err:=poscheckout.OriginMAC(key,"gokwik-native",data);if err!=nil{return err};_,err=tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_gokwik_native_events(command_id,order_id,input_hash,data,proof_hash) VALUES(?,?,?,?,?)`,scope.Command.ID,scope.Creation.OrderID,hash,string(raw),seal);return err
}
