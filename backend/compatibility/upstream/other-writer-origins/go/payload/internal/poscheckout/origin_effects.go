package poscheckout

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type OriginEffect struct {
	ID string `json:"id"`; CommandID string `json:"commandId"`; OrderID string `json:"orderId"`; CustomerID string `json:"customerId"`
	ActorID *string `json:"actorId"`; Kind string `json:"kind"`; ProductID string `json:"productId"`; LineID string `json:"lineId"`; Quantity int64 `json:"quantity"`
	GatewayPaid bool `json:"gatewayPaid"`; LocationID int64 `json:"locationId"`; RequestID string `json:"requestId"`
	StockMode string `json:"stockMode"`; Sequence int64 `json:"sequence"`; Priority int64 `json:"priority"`
}
type OriginEffectCollector struct {Command OriginCommand;RequestID string;key string;StockMode string;Values []OriginEffect}
var originEffectKinds=map[string]bool{"inventory":true,"online-product-sync":true,"store-product-sync":true,"hold-set":true,"hold-reconcile":true,"hold-release":true,"wallet-unlock":true,"welcome-exclusive":true,"order-producer":true,"order-engagement":true,"gift-voucher-check":true,"auto-deliver":true,"order-email":true,"gift-voucher-emails":true,"store-utm":true,"freebie-count":true,"hyperlocal":true,"payment-failure":true,"stock-line-cancel":true}
func NewOriginEffectCollector(c OriginCommand,requestID,key string)*OriginEffectCollector{return &OriginEffectCollector{Command:c,RequestID:originSafeRequestID(requestID),key:key,Values:[]OriginEffect{}}}
func(c *OriginEffectCollector)Add(kind,product,line string,quantity,location int64,gatewayPaid bool)error{
	if c.Command.OrderID==nil||!originEffectKinds[kind]||len(c.Values)>=1000||quantity<0||quantity>999||location<0||product!=""&&!originIdentifier(product)||line!=""&&!originIdentifier(line){return ErrReview}
	v:=OriginEffect{CommandID:c.Command.ID,OrderID:*c.Command.OrderID,CustomerID:c.Command.CustomerID,ActorID:c.Command.ActorID,Kind:kind,ProductID:product,LineID:line,Quantity:quantity,LocationID:location,GatewayPaid:gatewayPaid,RequestID:c.RequestID,StockMode:c.StockMode,Priority:originEffectPriority(kind)};id,e:=OriginMAC(c.key,"go-effect",v);if e!=nil{return e};v.ID=id
	for _,old:=range c.Values{if old.ID==id{return nil}};c.Values=append(c.Values,v);return nil
}
func(c *OriginEffectCollector)persist(ctx context.Context,tx *sql.Tx)(string,error){
	if len(c.Values)==0{return OriginMAC(c.key,"go-effects",c.Values)}
	var sequence int64;if tx.QueryRowContext(ctx,`SELECT COALESCE(MAX(sequence_no),0) FROM pos_rewrite_screening_origin_go_effects WHERE command_id=?`,c.Values[0].CommandID).Scan(&sequence)!=nil{return "",ErrReview}
	for i,v:=range c.Values{sequence++;v.Sequence=sequence;v.Priority=originEffectPriority(v.Kind);c.Values[i]=v;raw,e:=originCanonical(v);if e!=nil{return "",e};seal,e:=OriginMAC(c.key,"go-effect",v);if e!=nil{return "",e};if _,e=tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_go_effects(id,command_id,order_id,kind,priority,sequence_no,data,proof_hash,phase,receipt,receipt_hash,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,'PENDING',NULL,NULL,?)`,v.ID,v.CommandID,v.OrderID,v.Kind,v.Priority,v.Sequence,string(raw),seal,time.Now().UnixMilli());e!=nil{return "",e}}
	return OriginMAC(c.key,"go-effects",c.Values)
}
func originEffectPriority(kind string)int64{switch kind{case "inventory","hold-set","online-product-sync","store-product-sync":return 0;case "hold-reconcile","hold-release":return 1;case "stock-line-cancel":return 2;case "wallet-unlock":return 4;default:return 3}}
type OriginEffectReceipt struct {Accepted bool `json:"accepted"`;EvidenceHash string `json:"evidenceHash"`;Additional []OriginEffect `json:"additional"`}
type OriginEffectHandler func(context.Context,OriginEffect)(OriginEffectReceipt,error)

// SENDING and UNCERTAIN are never selected again. A broker/Redis/HTTP timeout
// therefore cannot produce another message, cancellation or inventory debit.
func DispatchOriginEffects(ctx context.Context,db *sql.DB,key string,handlers map[string]OriginEffectHandler,limit int,observe func(OriginEffect,string))error{
	if !originKey.MatchString(key)||limit<1||limit>100{return ErrReview};for k,v:=range handlers{if !originEffectKinds[k]||v==nil{return ErrReview}}
	for i:=0;i<limit;i++{
		tx,e:=db.BeginTx(ctx,&sql.TxOptions{Isolation:sql.LevelReadCommitted});if e!=nil{return e};var id,kind,seal string;var raw []byte;var priority,sequence int64
		e=tx.QueryRowContext(ctx,`SELECT e.id,e.kind,e.priority,e.sequence_no,CASE WHEN OCTET_LENGTH(e.data)<=16000 THEN e.data ELSE NULL END,e.proof_hash FROM pos_rewrite_screening_origin_go_effects e WHERE e.phase='PENDING' AND NOT EXISTS(SELECT 1 FROM pos_rewrite_screening_origin_go_effects p WHERE p.command_id=e.command_id AND (p.priority<e.priority OR p.priority=e.priority AND p.sequence_no<e.sequence_no) AND p.phase<>'ACCEPTED') ORDER BY e.updated_at_ms,e.id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id,&kind,&priority,&sequence,&raw,&seal)
		if errors.Is(e,sql.ErrNoRows){tx.Rollback();return nil};if e!=nil{tx.Rollback();return e};var effect OriginEffect
		if originVerify(key,"go-effect",raw,seal,&effect,16000)!=nil||effect.ID!=id||effect.Kind!=kind||effect.Priority!=priority||effect.Sequence!=sequence||priority!=originEffectPriority(kind)||sequence<1||!originEffectKinds[kind]{tx.Rollback();return ErrReview}
		handler:=handlers[kind];if handler==nil{tx.Rollback();return ErrReview}
		if _,e=tx.ExecContext(ctx,`UPDATE pos_rewrite_screening_origin_go_effects SET phase='SENDING',updated_at_ms=? WHERE id=? AND phase='PENDING'`,time.Now().UnixMilli(),id);e!=nil{tx.Rollback();return e};if e=tx.Commit();e!=nil{return e}
		receipt,deliveryErr:=originDeliver(ctx,handler,effect);phase:="UNCERTAIN";var body interface{};var receiptHash interface{}
		if originHash.MatchString(receipt.EvidenceHash)&&len(receipt.Additional)<=1000{r,e:=originCanonical(receipt);if e!=nil{return e};body=string(r);receiptHash,e=OriginMAC(key,"go-effect-receipt",map[string]interface{}{"effectId":id,"receipt":receipt});if e!=nil{return e};if deliveryErr==nil&&receipt.Accepted{phase="ACCEPTED"}}
		tx,e=db.BeginTx(ctx,&sql.TxOptions{Isolation:sql.LevelReadCommitted});if e!=nil{return e}
		var current string;if tx.QueryRowContext(ctx,`SELECT phase FROM pos_rewrite_screening_origin_go_effects WHERE id=? FOR UPDATE`,id).Scan(&current)!=nil||current!="SENDING"{tx.Rollback();return ErrReview}
		if phase=="ACCEPTED"&&len(receipt.Additional)>0{
			// Additional effects may only be exact source oversell cancellations.
			collector:=&OriginEffectCollector{key:key,Values:receipt.Additional};for _,a:=range receipt.Additional{if kind!="hold-reconcile"||a.Kind!="stock-line-cancel"||a.CommandID!=effect.CommandID||a.OrderID!=effect.OrderID||a.CustomerID!=effect.CustomerID||a.LineID==""||!effect.GatewayPaid{tx.Rollback();return ErrReview}}
			if _,e=collector.persist(ctx,tx);e!=nil{tx.Rollback();return e}
		}
		if _,e=tx.ExecContext(ctx,`UPDATE pos_rewrite_screening_origin_go_effects SET phase=?,receipt=?,receipt_hash=?,updated_at_ms=? WHERE id=? AND phase='SENDING'`,phase,body,receiptHash,time.Now().UnixMilli(),id);e!=nil{tx.Rollback();return e};if e=tx.Commit();e!=nil{return e};if observe!=nil{observe(effect,phase)}
	};return nil
}
func originDeliver(ctx context.Context,h OriginEffectHandler,e OriginEffect)(receipt OriginEffectReceipt,err error){defer func(){if recover()!=nil{err=ErrReview}}();return h(ctx,e)}

type originEffectTarget struct{kind,env,method string;appendProduct,appendOrder bool}
var originHTTPTargets=[]originEffectTarget{
	{"inventory","INVENTORY","POST",false,false},{"online-product-sync","NEW_PRODUCT_SYNC_URL","POST",true,false},{"store-product-sync","POS_PRODUCT_SYNC","GET",true,false},
	{"welcome-exclusive","WELCOME_EXCLUSIVE","POST",false,false},{"order-producer","ORDER_PRODUCER_URL","POST",false,false},{"order-engagement","ORDER_EM_CHK_URL","POST",false,false},{"gift-voucher-check","ORDER_GV_CHK_URL","POST",false,false},
	{"auto-deliver","AUTODELIVER_URL","POST",false,false},{"order-email","ORDER_EMAIL","POST",false,false},{"gift-voucher-emails","GIFTVOUCHER_EMAILS","POST",false,false},{"store-utm","STORE_UTM","GET",false,true},
	{"freebie-count","FREEBIE_COUNT","POST",false,false},{"hyperlocal","POS_ADMIN_URL","POST",false,false},{"payment-failure","PAYMENT_FAILURE","POST",false,false},{"stock-line-cancel","ORDER_LINE_CANCEL_URL","POST",false,false},
}
func originEndpoint(raw string)(*url.URL,error){u,e:=url.Parse(raw);if e!=nil||u.Scheme!="https"||u.Hostname()==""||u.User!=nil||u.RawQuery!=""||u.Fragment!=""{return nil,ErrReview};return u,nil}
func OriginHTTPHandlers(env func(string)string,client *http.Client)(map[string]OriginEffectHandler,error){
	if client==nil{client=&http.Client{Timeout:10*time.Second,CheckRedirect:func(*http.Request,[]*http.Request)error{return ErrReview}}}
	handlers:=map[string]OriginEffectHandler{}
	for _,t:=range originHTTPTargets{
		u,e:=originEndpoint(env(t.env));if e!=nil{return nil,e};if t.kind=="hyperlocal"{u.Path=strings.TrimRight(u.Path,"/")+"/api/v1/orders/auto-hl-order/"}
		target,endpoint:=t,u.String()
		handlers[target.kind]=func(ctx context.Context,effect OriginEffect)(OriginEffectReceipt,error){
			destination:=endpoint;if target.appendProduct{if effect.ProductID==""{return OriginEffectReceipt{},ErrReview};destination+=effect.ProductID};if target.appendOrder{destination+=effect.OrderID}
			order:=json.Number(effect.OrderID);body:=map[string]interface{}{"order_id":order}
			switch target.kind{case "inventory":body=map[string]interface{}{"prd":json.Number(effect.ProductID),"qty":effect.Quantity,"comment":"ORDER PLACED FROM SHOP "+effect.OrderID,"user":json.Number(effect.CustomerID)}
			case "online-product-sync":body=map[string]interface{}{"syncInMongo":false,"syncInRedis":false,"syncPrice":false,"syncStock":true}
			case "welcome-exclusive","order-email","gift-voucher-emails","payment-failure":body=map[string]interface{}{"orderId":order}
			case "order-producer":body=map[string]interface{}{"payload":order}
			case "freebie-count":body["change_type"]="incr"
			case "hyperlocal":body["location_id"]=effect.LocationID;body["is_notify"]=1
			case "stock-line-cancel":if !effect.GatewayPaid||effect.LineID==""{return OriginEffectReceipt{},ErrReview};body=map[string]interface{}{"order_id":order,"has_product_id":json.Number(effect.LineID),"user_id":json.Number(effect.CustomerID),"reason_id":9,"comment":"Cancelled automatically: this item was out of stock when the payment was confirmed.","system_comment":true,"refund_mode":1}
			}
			raw,err:=json.Marshal(body);if err!=nil{return OriginEffectReceipt{},ErrReview};var reader io.Reader
			contentType:="application/json";if target.method=="POST"{reader=bytes.NewReader(raw)}
			if target.kind=="hyperlocal"{form:=url.Values{"order_id":{effect.OrderID},"location_id":{strconv.FormatInt(effect.LocationID,10)},"is_notify":{"1"}};reader=strings.NewReader(form.Encode());contentType="application/x-www-form-urlencoded"}
			req,err:=http.NewRequestWithContext(ctx,target.method,destination,reader);if err!=nil{return OriginEffectReceipt{},ErrReview};req.Header.Set("Content-Type",contentType);req.Header.Set("Idempotency-Key",effect.ID);req.Header.Set("X-Request-ID",effect.RequestID)
			switch target.kind{case "order-producer":if env("POST_ORDER_APP_ID")==""||env("POST_ORDER_APP_KEY")==""{return OriginEffectReceipt{},ErrReview};req.Header.Set("ar-app-id",env("POST_ORDER_APP_ID"));req.Header.Set("ar-app-key",env("POST_ORDER_APP_KEY"))
			case "online-product-sync":if env("NEW_PRODUCT_SYNC_SECRET_KEY")==""{return OriginEffectReceipt{},ErrReview};req.Header.Set("x-sync-api-key",env("NEW_PRODUCT_SYNC_SECRET_KEY"))
			case "hyperlocal":if env("POS_ADMIN_APP_ID")==""||env("POS_ADMIN_APP_KEY")==""{return OriginEffectReceipt{},ErrReview};req.Header.Set("APPID",env("POS_ADMIN_APP_ID"));req.Header.Set("APPKEY",env("POS_ADMIN_APP_KEY"))
			case "stock-line-cancel":if env("INTERNAL_APP_ID")==""||env("INTERNAL_APP_KEY")==""{return OriginEffectReceipt{},ErrReview};req.Header.Set("ar-app-id",env("INTERNAL_APP_ID"));req.Header.Set("ar-app-key",env("INTERNAL_APP_KEY"))}
			resp,err:=client.Do(req);if err!=nil{return OriginEffectReceipt{},ErrReview};defer resp.Body.Close();data,err:=io.ReadAll(io.LimitReader(resp.Body,1048577));if err!=nil||len(data)>1048576||resp.StatusCode<200||resp.StatusCode>=300{return OriginEffectReceipt{},ErrReview}
			if target.kind=="stock-line-cancel"{var result struct{Success bool `json:"success"`;Status interface{} `json:"status"`};if json.Unmarshal(data,&result)!=nil||!result.Success&&result.Status!="success"{return OriginEffectReceipt{},ErrReview}}
			hash:=sha256.Sum256(data);return OriginEffectReceipt{Accepted:true,EvidenceHash:hex.EncodeToString(hash[:]),Additional:[]OriginEffect{}},nil
		}
	};return handlers,nil
}

func OriginLogEvent(w io.Writer,event string,requestID string,actor *string){
	if w==nil{return};switch event{case "accepted","refused","uncertain","effect-accepted","effect-uncertain","startup-refused":default:return}
	data,_:=json.Marshal(map[string]interface{}{"eventId":"payments.screening-origin-payment."+event,"eventInstanceId":originSafeRequestID(""),"module":"payments","resource":"screening-origin-payment","requestId":originSafeRequestID(requestID),"userId":actor,"timestamp":time.Now().UTC().Format(time.RFC3339Nano)});w.Write(append(data,'\n'))
}
