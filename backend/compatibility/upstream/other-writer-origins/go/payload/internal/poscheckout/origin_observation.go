package poscheckout

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"
)

// Real provider observations are retained before attempting allocation. A
// revoked customer/staff or failed native fence cannot erase collected money.
// Only source-authenticated provider adapters call this server-only method.
func(e *OriginEngine)recordObservation(ctx context.Context,command string,o OriginProviderResponse)error{
	if e.ready(false)!=nil||!originUUID.MatchString(command)||!originIdentifier(o.OrderID)||!originHash.MatchString(o.EvidenceHash){return ErrReview}
	id,err:=OriginMAC(e.Key,"observation-id",map[string]interface{}{"commandId":command,"orderId":o.OrderID,"providerReference":o.ProviderReference,"status":o.Status,"evidenceHash":o.EvidenceHash});if err!=nil{return err}
	sealed,hash,err:=originSeal(e.Key,"provider-observation:"+id,o);if err!=nil{return err}
	meta:=map[string]interface{}{"contract":"pos-screening-origin-provider-observation-v1","id":id,"commandId":command,"orderId":o.OrderID,"payloadHash":hash,"observedAt":o.ObservedAt};data,err:=originCanonical(meta);if err!=nil{return err};seal,err:=OriginMAC(e.Key,"provider-observation",meta);if err!=nil{return err}
	retained,cancel:=context.WithTimeout(context.WithoutCancel(ctx),5*time.Second);defer cancel()
	_,err=e.DB.ExecContext(retained,`INSERT INTO pos_rewrite_screening_origin_payment_observations(id,command_id,order_id,data,proof_hash,payload) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,id,command,o.OrderID,string(data),seal,sealed);return err
}

func originRetainedPrefix(ctx context.Context,tx *sql.Tx,c OriginCommand)error{
	if c.ActorID!=nil{
		var role,kind,active int64;if tx.QueryRowContext(ctx,`SELECT role,user_type,is_active FROM pos_user WHERE id=? FOR SHARE`,*c.ActorID).Scan(&role,&kind,&active)!=nil||role<1||role>5||(kind!=1&&kind!=2)||active!=1{return ErrReview}
		var category,storeType string;if c.StoreID==nil||c.CounterID==nil||tx.QueryRowContext(ctx,`SELECT is_active,category,type FROM stores WHERE id=? FOR UPDATE`,*c.StoreID).Scan(&active,&category,&storeType)!=nil||active!=1||kind==2&&category!="FRANCHISE"||storeType!="STORE"&&storeType!="CORE_WAREHOUSE"{return ErrReview}
		if role!=1||kind!=1{var assignment int64;if tx.QueryRowContext(ctx,`SELECT id FROM user_stores WHERE django_user_id=? AND store_id=? ORDER BY id LIMIT 1 FOR SHARE`,*c.ActorID,*c.StoreID).Scan(&assignment)!=nil{return ErrReview}}
		var counter int64;if tx.QueryRowContext(ctx,`SELECT id FROM store_counters WHERE id=? AND store_id=? AND is_active=1 FOR SHARE`,*c.CounterID,*c.StoreID).Scan(&counter)!=nil{return ErrReview}
	}
	var active int64;var blocked,disabled sql.NullInt64;if tx.QueryRowContext(ctx,`SELECT status,is_block,is_disabled FROM users WHERE id=? FOR UPDATE`,c.CustomerID).Scan(&active,&blocked,&disabled)!=nil||active!=1||blocked.Valid&&blocked.Int64!=0||disabled.Valid&&disabled.Int64!=0{return ErrReview};return nil
}

// Observe is never reachable from an arbitrary payment-status body. Its caller
// must verify the original provider signature/shared header or perform the
// authenticated provider status request first. It neither charges nor retries.
func(e *OriginEngine)Observe(ctx context.Context,orderID string,o OriginProviderResponse,requestID string)(OriginPaymentView,error){
	var command,customer string;if e.ready(false)!=nil||o.OrderID!=orderID{return OriginPaymentView{},ErrReview}
	if err:=e.DB.QueryRowContext(ctx,`SELECT id,CAST(customer_id AS CHAR) FROM pos_rewrite_screening_origin_commands WHERE order_id=?`,orderID).Scan(&command,&customer);err!=nil{return OriginPaymentView{},err}
	if err:=e.recordObservation(ctx,command,o);err!=nil{return OriginPaymentView{},err}
	conn,err:=e.DB.Conn(ctx);if err!=nil{return OriginPaymentView{},err};u:=&originUnit{engine:e,conn:conn};defer u.close()
	u.tx,err=conn.BeginTx(ctx,&sql.TxOptions{Isolation:sql.LevelReadCommitted});if err!=nil{return OriginPaymentView{},err}
	hint,err:=ReadOriginCommand(ctx,u.tx,command,customer,e.Key,false);if err!=nil{return OriginPaymentView{},err};if err=originRetainedPrefix(ctx,u.tx,hint);err!=nil{return OriginPaymentView{},err}
	u.command,err=ReadOriginCommand(ctx,u.tx,command,customer,e.Key,true);if err!=nil{return OriginPaymentView{},err};u.creation,err=ReadOriginCreation(ctx,u.tx,u.command,e.Key);if err!=nil{return OriginPaymentView{},err}
	u.counter,err=enterOriginCounter(ctx,u.tx,u.command);if err!=nil{return OriginPaymentView{},err};if err=originNative(ctx,u.tx,u.command,u.creation,false);err!=nil{return OriginPaymentView{},err}
	a,payload,response,err:=originReadAttempt(ctx,u.tx,command,e.Key);if errors.Is(err,sql.ErrNoRows){return OriginPaymentView{},ErrReview};if err!=nil{return OriginPaymentView{},err}
	if a.Phase=="CONFIRMED"||a.Phase=="CAPTURED"{view,err:=e.view(ctx,u,a,payload,response);if err!=nil{return view,err};return view,u.commit(ctx)}
	view,err:=e.apply(ctx,u,a,o,requestID);if err!=nil{return view,err};return view,u.commit(ctx)
}

func originNativePaymentLog(ctx context.Context,tx *sql.Tx,c OriginCommand,o OriginProviderResponse,key string)error{
	if o.LogStatus==""{return nil};switch o.LogStatus{case "TXN_CREATED","ORDER_SUCCEEDED","ORDER_FAILED","AUTHENTICATION_FAILED","AUTHORIZATION_FAILED","JUSPAY_DECLINED":default:return ErrReview}
	id,err:=OriginMAC(key,"payment-native-event",map[string]interface{}{"commandId":c.ID,"providerReference":o.ProviderReference,"evidenceHash":o.EvidenceHash,"status":o.LogStatus});if err!=nil{return err}
	var found string;err=tx.QueryRowContext(ctx,`SELECT CAST(payment_id AS CHAR) FROM pos_rewrite_screening_origin_payment_events WHERE id=? FOR UPDATE`,id).Scan(&found);if err==nil{return nil};if !errors.Is(err,sql.ErrNoRows){return err}
	pgResponse,_:=strconv.ParseInt(o.GatewayReference,10,32);if pgResponse<0{pgResponse=0};amount:=strconv.FormatInt(o.AmountPaise/100,10)+"."+func()string{x:=strconv.FormatInt(o.AmountPaise%100,10);if len(x)==1{return "0"+x};return x}()
	result,err:=tx.ExecContext(ctx,`INSERT INTO payments(order_id,user_id,pg_id,pg_response,amount,status,jp_order,created_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,o.OrderID,c.CustomerID,o.GatewayID,pgResponse,amount,o.LogStatus,o.ProviderReference);if err!=nil{return err};payment,err:=result.LastInsertId();if err!=nil||payment<=0{return ErrReview};_,err=tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_payment_events(id,command_id,payment_id) VALUES(?,?,?)`,id,c.ID,payment);return err
}
