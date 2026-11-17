package juspay

import (
	"context"
	"database/sql"
	"strconv"
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"github.com/jinzhu/gorm"
)

// Preserve the original ProcessOrder selector order. The declaration records
// original exchange authority; it does not masquerade as a bank transaction.
func readOtherOriginExchange(ctx context.Context,tx *sql.Tx,c poscheckout.OriginCommand,creation poscheckout.OriginCreation)(*poscheckout.OriginExchangeSelection,error){
	db,err:=gorm.Open("mysql",tx);if err!=nil{return nil,err};db.LogMode(false);var order Order;if err=db.Where("id=?",creation.OrderID).First(&order).Error;err!=nil{return nil,err}
	read:=func(id int)(*poscheckout.OriginExchangeReference,error){var value poscheckout.OriginExchangeReference;var customer string;if tx.QueryRowContext(ctx,`SELECT CAST(id AS CHAR),CAST(user_id AS CHAR),`+poscheckout.OriginHeaderSQL+`,`+poscheckout.OriginAllocationSQL+`,order_status,payment_status FROM orders WHERE id=? FOR SHARE`,id).Scan(&value.OrderID,&customer,&value.HeaderHash,&value.AllocationHash,&value.OrderStatus,&value.PaymentStatus)!=nil||customer!=c.CustomerID{return nil,poscheckout.ErrReview};return &value,nil}
	if order.ParentOrderId>0{var parent Order;if err=db.Set("gorm:query_option","FOR SHARE").Where("id=?",order.ParentOrderId).First(&parent).Error;err!=nil{return nil,err};if parent.IsExpress==1{ref,err:=read(int(parent.ID));if err!=nil{return nil,err};return &poscheckout.OriginExchangeSelection{Selector:"express-parent",Reference:ref},nil}}
	var log ReshippingOrderLogs;res:=db.Set("gorm:query_option","FOR SHARE").Where("order_id=?",order.ID).First(&log);if res.Error!=nil&&!gorm.IsRecordNotFoundError(res.Error){return nil,res.Error}
	if log.Id>0{var hash string;const native="LOWER(SHA2(CAST(JSON_OBJECT('id',id,'parentOrderId',parent_order_id,'orderId',order_id,'productId',prod_id,'reshippedStatus',reshipped_status,'remark',remark,'createdAt',DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s'),'updatedAt',DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s')) AS CHAR CHARACTER SET utf8mb4),256))";if err=db.Table("reshipping_order_log").Select(native+" AS hash").Where("id=? AND order_id=?",log.Id,order.ID).Row().Scan(&hash);err!=nil{return nil,err};selection:=&poscheckout.OriginExchangeSelection{Selector:"reshipping",Reshipping:&poscheckout.OriginReshippingReference{ID:strconv.FormatUint(uint64(log.Id),10),InputHash:hash}};return selection,nil}
	if order.PaymentMethod==PaymentMethodPrepaid&&order.OriginalOrderId>0{ref,err:=read(order.OriginalOrderId);if err!=nil{return nil,err};return &poscheckout.OriginExchangeSelection{Selector:"original-prepaid",Reference:ref},nil};return nil,nil
}
