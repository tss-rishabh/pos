package poscheckout

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gomodule/redigo/redis"
)

// Copied byte-for-byte from the pinned payments source, not a new stock rule.
//go:embed origin_lua/*.lua
var originLua embed.FS

func originRedisURL(raw string)(string,error){u,e:=url.Parse(raw);if e!=nil||u.Scheme!="rediss"||u.Hostname()==""||u.Fragment!=""||u.RawQuery!=""{return "",ErrReview};return u.String(),nil}
func originRedisConnect(ctx context.Context,endpoint string)(redis.Conn,error){
	if _,e:=originRedisURL(endpoint);e!=nil{return nil,e};return redis.DialURL(endpoint,redis.DialConnectTimeout(5*time.Second),redis.DialReadTimeout(5*time.Second),redis.DialWriteTimeout(5*time.Second))
}
// Called OUTSIDE the SQL financial transaction. Unknown mode is an error,
// never the original helper's silent legacy fallback on a network failure.
func OriginStockMode(ctx context.Context,env func(string)string)(string,error){
	mode:=env("POS_SCREENING_ORIGIN_OVERSELL_MODE");if mode!="legacy"&&mode!="shadow"&&mode!="reserve"{return "",ErrReview}
	if mode=="legacy"&&env("OVERSELL_COUNTER")=="0"{return mode,nil}
	c,e:=originRedisConnect(ctx,env("POS_SCREENING_ORIGIN_INVENTORY_REDIS_URL"));if e!=nil{return "",ErrReview};defer c.Close();actual,e:=redis.String(c.Do("GET","oversell:mode"));if e!=nil{return "",ErrReview};if actual!="shadow"&&actual!="reserve"{actual="legacy"};if actual!=mode{return "",ErrReview};return mode,nil
}
func OriginRedisHandlers(db *sql.DB,key string,env func(string)string)(map[string]OriginEffectHandler,error){
	endpoints:=map[string]string{"hold-set":env("POS_SCREENING_ORIGIN_HOLD_REDIS_URL"),"wallet-unlock":env("POS_SCREENING_ORIGIN_WALLET_REDIS_URL"),"hold-release":env("POS_SCREENING_ORIGIN_INVENTORY_REDIS_URL"),"hold-reconcile":env("POS_SCREENING_ORIGIN_INVENTORY_REDIS_URL")}
	for _,endpoint:=range endpoints{if _,e:=originRedisURL(endpoint);e!=nil{return nil,e}}
	handlers:=map[string]OriginEffectHandler{}
	for kind,endpoint:=range endpoints{k,ep:=kind,endpoint;handlers[k]=func(ctx context.Context,effect OriginEffect)(OriginEffectReceipt,error){
		if (k=="hold-release"||k=="hold-reconcile")&&effect.StockMode=="legacy"{hash:=sha256.Sum256([]byte("source-legacy-no-counter"));return OriginEffectReceipt{Accepted:true,EvidenceHash:hex.EncodeToString(hash[:]),Additional:[]OriginEffect{}},nil}
		conn,e:=originRedisConnect(ctx,ep);if e!=nil{return OriginEffectReceipt{},ErrReview};defer conn.Close()
		var result interface{}
		switch k{
		case "hold-set":if effect.ProductID==""||effect.Quantity<1{return OriginEffectReceipt{},ErrReview};result,e=conn.Do("HMSET",effect.ProductID,effect.OrderID+"_"+effect.ProductID,strconv.FormatInt(effect.Quantity,10))
		case "wallet-unlock":
			// The legacy key is customer-only. A delayed job cannot overwrite a
			// newer checkout's lock; require a cooperating order-owned token.
			result,e=conn.Do("EVAL",`local owner=redis.call('GET',KEYS[2]);if not owner then return 'unqualified' end;if owner~=ARGV[1] then return 'superseded' end; redis.call('SETEX',KEYS[1],ARGV[2],1);redis.call('DEL',KEYS[2]);return 'released'`,2,"txn_lock_"+effect.CustomerID,"txn_lock_owner_"+effect.CustomerID,effect.CommandID,strconv.FormatInt(effect.Quantity,10))
		case "hold-release":script,e2:=originLua.ReadFile("origin_lua/release.lua");if e2!=nil{return OriginEffectReceipt{},ErrReview};result,e=redis.NewScript(0,string(script)).Do(conn,effect.OrderID,effect.CustomerID)
		case "hold-reconcile":
			lines,owners,e2:=originHoldInputs(ctx,db,effect,env);if e2!=nil{return OriginEffectReceipt{},e2};script,e2:=originLua.ReadFile("origin_lua/redecrement.lua");if e2!=nil{return OriginEffectReceipt{},ErrReview};result,e=redis.NewScript(0,string(script)).Do(conn,effect.OrderID,lines,effect.CustomerID,owners)
		}
		if e!=nil{return OriginEffectReceipt{},ErrReview};raw,e:=redis.Bytes(result,nil);if e!=nil{raw=[]byte(fmt.Sprint(result))};if len(raw)>1000000{return OriginEffectReceipt{},ErrReview};hash:=sha256.Sum256(raw)
		receipt:=OriginEffectReceipt{Accepted:true,EvidenceHash:hex.EncodeToString(hash[:]),Additional:[]OriginEffect{}}
		if k=="wallet-unlock"&&string(raw)=="unqualified"{receipt.Accepted=false;return receipt,ErrReview}
		if k=="hold-reconcile"{
			var outcome struct{Unfulfillable []struct{Line string `json:"lineno"`;SKU string `json:"sku"`} `json:"unfulfillable"`;Floored []string `json:"floored"`}
			if json.Unmarshal(raw,&outcome)!=nil||len(outcome.Unfulfillable)>1000||len(outcome.Floored)>1000{return OriginEffectReceipt{},ErrReview}
			for _,line:=range outcome.Unfulfillable{if !originIdentifier(line.Line)||!originIdentifier(line.SKU){return OriginEffectReceipt{},ErrReview};if effect.GatewayPaid{child:=effect;child.Kind="stock-line-cancel";child.LineID=line.Line;child.ProductID=line.SKU;child.ID="";child.Sequence=0;child.Priority=originEffectPriority(child.Kind);child.ID,e=OriginMAC(key,"go-effect",child);if e!=nil{return OriginEffectReceipt{},e};receipt.Additional=append(receipt.Additional,child)}}
			// Any unfulfillable non-gateway line or stale/floored counter is
			// retained as unresolved cash/stock work, never an invented refund.
			if len(outcome.Floored)>0||len(outcome.Unfulfillable)>0&&!effect.GatewayPaid{receipt.Accepted=false;return receipt,ErrReview}
		}
		return receipt,nil
	}}
	return handlers,nil
}
func originHoldInputs(ctx context.Context,db *sql.DB,effect OriginEffect,env func(string)string)(string,string,error){
	rows,e:=db.QueryContext(ctx,`SELECT CAST(hp.id AS CHAR),CAST(hp.prod_id AS CHAR) FROM has_products hp JOIN product_stocks ps ON ps.prod_id=hp.prod_id WHERE hp.order_id=? AND COALESCE(hp.is_express,0)=0 ORDER BY hp.id LIMIT 1001`,effect.OrderID);if e!=nil{return "","",e};lines:=[]map[string]string{};products:=[]interface{}{}
	for rows.Next(){var id,sku string;if rows.Scan(&id,&sku)!=nil{rows.Close();return "","",ErrReview};lines=append(lines,map[string]string{"lineno":id,"sku":sku});products=append(products,sku)};e=rows.Err();rows.Close();if e!=nil||len(lines)>1000{return "","",ErrReview}
	hours,e:=strconv.ParseFloat(env("MAX_PAYMENT_WINDOW_HOURS"),64);if e!=nil||hours<=0||hours>24{return "","",ErrReview};owners:=[]map[string]string{}
	if len(products)>0{marks:=strings.TrimRight(strings.Repeat("?,",len(products)),",");args:=[]interface{}{effect.CustomerID,effect.OrderID};args=append(args,products...);args=append(args,hours*60)
		rows,e=db.QueryContext(ctx,`SELECT CAST(o.id AS CHAR),CAST(hp.id AS CHAR),CAST(hp.prod_id AS CHAR) FROM orders o JOIN has_products hp ON hp.order_id=o.id WHERE o.user_id=? AND o.order_status=0 AND o.id<>? AND hp.prod_id IN(`+marks+`) AND COALESCE(hp.is_express,0)=0 AND o.created_at>=NOW()-INTERVAL ? MINUTE ORDER BY o.id DESC,hp.id LIMIT 10001`,args...);if e!=nil{return "","",e};for rows.Next(){var order,line,sku string;if rows.Scan(&order,&line,&sku)!=nil{rows.Close();return "","",ErrReview};owners=append(owners,map[string]string{"order":order,"lineno":line,"sku":sku})};e=rows.Err();rows.Close();if e!=nil||len(owners)>10000{return "","",ErrReview}}
	a,_:=json.Marshal(lines);b,_:=json.Marshal(owners);return string(a),string(b),nil
}
