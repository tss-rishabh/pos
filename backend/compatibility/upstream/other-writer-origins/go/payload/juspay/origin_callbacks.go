package juspay

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"backend-tss-domestic_payments_api/internal/poscheckout"
	"backend-tss-domestic_payments_api/utils"
	"github.com/gin-gonic/gin"
)

func originRegistered(ctx context.Context,order string)(bool,error){if os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY")==""{return false,nil};var id string;err:=utils.Db.DB().QueryRowContext(ctx,`SELECT id FROM pos_rewrite_screening_origin_commands WHERE order_id=?`,order).Scan(&id);if err==sql.ErrNoRows{return false,nil};return err==nil,err}
func originMachineAuthorized(c *gin.Context,prefix string)bool{
	force:=os.Getenv(prefix+"_WEBHOOK_AUTH_ENABLED");if force=="0"||force!="1"&&os.Getenv("WEBHOOK_AUTH_ENABLED")=="0"{return false}
	name:=os.Getenv(prefix+"_WEBHOOK_HEADER_NAME");if name==""{name="x-webhook-secret"};supplied:=strings.TrimSpace(c.GetHeader(name));if supplied==""||len(supplied)>4096{return false}
	matched:=false;for _,key:=range strings.Split(os.Getenv(prefix+"_WEBHOOK_SECRET"),","){key=strings.TrimSpace(key);if key!=""&&hmac.Equal([]byte(supplied),[]byte(key)){matched=true}};return matched
}

// The selected branch runs before the old callback's goroutine/logging/write.
// Refund events retain their separate original receiver, not this adapter.
func tryOtherOriginJuspayWebhook(c *gin.Context)bool{
	if os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY")==""{return false}
	raw,err:=io.ReadAll(io.LimitReader(c.Request.Body,1048577));if err!=nil||len(raw)>1048576{otherOriginRefused(c);return true};originRestoreBody(c,raw)
	var event JpWebhook;if json.Unmarshal(raw,&event)!=nil{return false}
	switch event.Event{case "TXN_CREATED","ORDER_SUCCEEDED","ORDER_FAILED":default:return false}
	registered,err:=originRegistered(c.Request.Context(),event.Content.Order.OrderID);if err!=nil{otherOriginRefused(c);return true};if !registered{return false}
	if !originMachineAuthorized(c,"JUSPAY"){c.JSON(http.StatusUnauthorized,gin.H{"status":http.StatusUnauthorized,"message":"Unauthorized."});return true}
	x:=event.Content.Order;status:=x.Status;logStatus:=event.Event;if event.Event=="TXN_CREATED"{status="TXN_CREATED"};if event.Event=="ORDER_SUCCEEDED"&&x.Status!="CHARGED"{otherOriginRefused(c);return true};if event.Event=="ORDER_FAILED"&&status!="AUTHENTICATION_FAILED"&&status!="AUTHORIZATION_FAILED"&&status!="JUSPAY_DECLINED"{status="ORDER_FAILED"}
	amount:=float64(x.Amount);if math.IsNaN(amount)||math.IsInf(amount,0)||amount<0||amount>999999999{otherOriginRefused(c);return true}
	sum:=sha256.Sum256(raw);provider:=x.ID;if provider==""{provider=event.ID}
	observation:=poscheckout.OriginProviderResponse{OrderID:x.OrderID,Status:status,ProviderReference:provider,AmountPaise:int64(math.Round(amount*100)),GatewayID:int64(x.GatewayID),GatewayReference:strconv.Itoa(x.GatewayRefernceID),EvidenceHash:hex.EncodeToString(sum[:]),ObservedAt:time.Now().UnixMilli(),Route:"webhook",LogStatus:logStatus}
	engine,err:=originEngine(c,"juspay",false);if err!=nil{otherOriginRefused(c);return true};view,err:=engine.Observe(c.Request.Context(),x.OrderID,observation,c.GetHeader("X-Request-ID"));if err!=nil{otherOriginRefused(c);return true};c.JSON(http.StatusOK,view);return true
}
func tryOtherOriginCron(c *gin.Context)bool{
	order:=c.Query("order_id");registered,err:=originRegistered(c.Request.Context(),order);if err!=nil{otherOriginRefused(c);return true};if !registered{return false};if !originMachineAuthorized(c,"CRON"){c.JSON(http.StatusUnauthorized,gin.H{"status":http.StatusUnauthorized,"message":"Unauthorized."});return true}
	// The real authenticated provider read proves status/amount. A scheduler's
	// query-string amount is never substituted for what the gateway collected.
	return recoverOtherOriginProvider(c,order,"cron",false)
}
func tryOtherOriginReturn(c *gin.Context,wwe bool)bool{
	order:=c.Query("order_id");registered,err:=originRegistered(c.Request.Context(),order);if err!=nil{otherOriginRefused(c);return true};if !registered{return false}
	decoded,err:=url.PathUnescape(c.Query("signature"));signature,err2:=base64.StdEncoding.DecodeString(decoded)
	message:=url.QueryEscape("order_id="+order+"&status="+c.Query("status")+"&status_id="+c.Query("status_id"));mac:=hmac.New(sha256.New,[]byte(os.Getenv("RESPONSE_KEY")));mac.Write([]byte(message))
	if err!=nil||err2!=nil||os.Getenv("RESPONSE_KEY")==""||!hmac.Equal(mac.Sum(nil),signature){c.JSON(http.StatusUnauthorized,gin.H{"status":http.StatusUnauthorized,"message":"Unauthorized."});return true}
	base:=os.Getenv("ALLOW_CORS");if wwe{base=os.Getenv("ALLOW_CORS_WWE")};if originPrivateEndpoint(base)!=nil{otherOriginRefused(c);return true}
	if c.Query("status_id")=="21"{if !recoverOtherOriginProvider(c,order,"return",true){return true};if c.IsAborted(){return true};c.Redirect(http.StatusFound,strings.TrimRight(base,"/")+"/thank-you?order="+order);return true}
	messages:=map[string]string{"10":"4","23":"3","26":"1","27":"1","22":"2","28":"3"};msg:=messages[c.Query("status_id")];if msg==""{msg="1"};c.Redirect(http.StatusFound,strings.TrimRight(base,"/")+"/checkout?msg="+msg);return true
}
func recoverOtherOriginProvider(c *gin.Context,order,route string,quiet bool)bool{
	engine,err:=originEngine(c,"juspay",false);if err!=nil{otherOriginRefused(c);c.Abort();return true}
	request,err:=engine.RetainedProviderRequest(c.Request.Context(),order);if err!=nil{otherOriginRefused(c);c.Abort();return true}
	observation,err:=engine.Provider.Recover(c.Request.Context(),request);if err!=nil{otherOriginRefused(c);c.Abort();return true};observation.Route=route
	view,err:=engine.Observe(c.Request.Context(),order,observation,c.GetHeader("X-Request-ID"));if err!=nil{otherOriginRefused(c);c.Abort();return true};if !quiet{c.JSON(http.StatusOK,view)};return true
}

func tryOtherOriginGokwikWebhook(c *gin.Context)bool{
	if os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY")==""{return false}
	raw,err:=io.ReadAll(io.LimitReader(c.Request.Body,64001));originRestoreBody(c,raw);var event GokwikWebhook;if err!=nil||len(raw)>64000||json.Unmarshal(raw,&event)!=nil{return false}
	registered,err:=originRegistered(c.Request.Context(),event.MOID);if err!=nil{otherOriginRefused(c);return true};if !registered{return false}
	// Original source had no configured Gokwik webhook authentication. The
	// selected adapter requires the real provider header before any work.
	if !originMachineAuthorized(c,"GOKWIK"){c.JSON(http.StatusUnauthorized,gin.H{"status":http.StatusUnauthorized,"message":"Unauthorized."});return true}
	engine,err:=originEngine(c,"gokwik",false);if err!=nil{otherOriginRefused(c);return true};request,err:=engine.RetainedProviderRequest(c.Request.Context(),event.MOID);if err!=nil{otherOriginRefused(c);return true}
	gate,err:=newOriginGateway(engine.DB,os.Getenv);if err!=nil{otherOriginRefused(c);return true};observation,err:=gate.gokwikVerify(c.Request.Context(),request,event.RequestID,event.GokwikOID);if err!=nil||event.TransactionID!=""&&event.TransactionID!=observation.GatewayReference{otherOriginRefused(c);return true}
	callbackHash:=sha256.Sum256(raw);retained,cancel:=context.WithTimeout(context.WithoutCancel(c.Request.Context()),5*time.Second);defer cancel()
	if err=engine.RecordGokwikLink(retained,event.MOID,event.RequestID,event.GokwikOID,hex.EncodeToString(callbackHash[:]),observation.EvidenceHash);err!=nil{otherOriginRefused(c);return true}
	observation.ProviderMessage="Gokwik Webhook"
	view,err:=engine.Observe(c.Request.Context(),event.MOID,observation,c.GetHeader("X-Request-ID"));if err!=nil{otherOriginRefused(c);return true};c.JSON(http.StatusOK,view);return true
}
func tryOtherOriginGokwikUpdate(row GokwikOrder)(bool,GokwikPaymentVerifyResponse){
	ctx,cancel:=context.WithTimeout(context.Background(),15*time.Second);defer cancel();order:=strconv.FormatUint(uint64(row.OrderId),10);registered,err:=originRegistered(ctx,order);if !registered&&err==nil{return false,GokwikPaymentVerifyResponse{}}
	result:=GokwikPaymentVerifyResponse{StatusCode:http.StatusServiceUnavailable,StatusMessage:"The original payment requires reconciliation."};if err!=nil{return true,result}
	// Internal cron/manual callers obtain status using genuine provider
	// credentials. They cannot manufacture a charged body or new order POST.
	engine,err:=originEngineContext(ctx,nil,"gokwik",false);if err!=nil||engine.Provider==nil{return true,result}
	request,err:=engine.RetainedProviderRequest(ctx,order);if err!=nil{return true,result};observation,err:=engine.Provider.Recover(ctx,request);if err!=nil{return true,result}
	if _,err=engine.Observe(ctx,order,observation,"");err!=nil{return true,result}
	if json.Unmarshal(observation.ClientResponse,&result)!=nil{return true,GokwikPaymentVerifyResponse{StatusCode:http.StatusServiceUnavailable,StatusMessage:"The original payment requires reconciliation."}}
	return true,result
}
func admitOtherOriginGokwikCron(c *gin.Context)bool{
	if os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY")==""{return true}
	if !originMachineAuthorized(c,"CRON"){c.JSON(http.StatusUnauthorized,gin.H{"status":http.StatusUnauthorized,"message":"Unauthorized."});return false};return true
}
func tryOtherOriginGokwikVerification(c *gin.Context)bool{
	if os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY")==""{return false}
	raw,err:=io.ReadAll(io.LimitReader(c.Request.Body,64001));originRestoreBody(c,raw);var input struct{GokwikOID string `json:"gokwik_oid"`};if err!=nil||len(raw)>64000||json.Unmarshal(raw,&input)!=nil||input.GokwikOID==""{otherOriginRefused(c);return true}
	var command,customer,kind string;err=utils.Db.DB().QueryRowContext(c.Request.Context(),`SELECT c.id,CAST(c.customer_id AS CHAR),c.origin FROM pos_rewrite_screening_origin_commands c WHERE c.order_id IN(SELECT order_id FROM gokwik_orders WHERE gokwik_oid=?)`,input.GokwikOID).Scan(&command,&customer,&kind)
	if err==sql.ErrNoRows{return false};if err!=nil||kind=="external-system"{otherOriginRefused(c);return true}
	caller,err:=originCaller(c,customer,false);if err!=nil{c.JSON(http.StatusUnauthorized,gin.H{"status":http.StatusUnauthorized,"message":"Unauthorized."});return true}
	engine,err:=originEngine(c,"gokwik",false);if err!=nil{otherOriginRefused(c);return true};cap,err:=engine.NativeReadAuthorization(c.Request.Context(),command,caller);if err!=nil{otherOriginRefused(c);return true}
	view,err:=engine.Read(c.Request.Context(),cap,caller,true,c.GetHeader("X-Request-ID"));if err!=nil{otherOriginRefused(c);return true};status:=http.StatusForbidden;message:="The original payment is pending.";if view.Status=="CONFIRMED"{status=http.StatusOK;message="Payment Success"};c.JSON(status,gin.H{"status":status,"gokwik_oid":input.GokwikOID,"message":message,"commandId":command});return true
}
