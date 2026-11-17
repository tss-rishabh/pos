package juspay

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"backend-tss-domestic_payments_api/internal/poscheckout"
	"backend-tss-domestic_payments_api/utils"
	"github.com/gbrlsnchs/jwt"
	"github.com/gin-gonic/gin"
	"github.com/jinzhu/gorm"
)

const originCommandHeader="X-TSS-Screening-Command"
const originAuthorizationHeader="X-TSS-Screening-Payment-Authorization"

func originEngine(c *gin.Context,provider string,newWork bool)(*poscheckout.OriginEngine,error){
	return originEngineContext(c.Request.Context(),c,provider,newWork)
}
func originEngineContext(requestContext context.Context,c *gin.Context,provider string,newWork bool)(*poscheckout.OriginEngine,error){
	key,legacy:=os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY"),os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY")
	selected:=os.Getenv("POS_SCREENING_ORIGIN_GO_CONTRACT")==poscheckout.OriginPaymentsContract&&os.Getenv("DEMO_MODE")!="true"
	e:=&poscheckout.OriginEngine{DB:utils.Db.DB(),Key:key,LegacyKey:legacy,CSKAPIKey:os.Getenv("POS_SCREENING_ORIGIN_CSK_API_KEY"),Selected:selected,Clock:time.Now}
	e.ExchangeFunding=readOtherOriginExchange
	e.MemberProducts=map[string]bool{};for _,name:=range []string{"EXCLUSIVE_PRODUCT_ID","EXCLUSIVE_99_PRODUCT_ID","EXCLUSIVE_QUARTERLY_ID","EXCLUSIVE_QUARTERLY_ID_FREE","EXCLUSIVE_UPGRADE_IDS"}{for _,id:=range strings.Split(os.Getenv(name),","){id=strings.TrimSpace(id);if id!=""{e.MemberProducts[id]=true}}}
	couponContract,deductionMode:=os.Getenv("POS_SCREENING_ORIGIN_GO_COUPON_CONTRACT"),os.Getenv("IS_DEDUCT")
	e.CouponPolicy=func(ctx context.Context,tx *sql.Tx,command poscheckout.OriginCommand,creation poscheckout.OriginCreation)(poscheckout.OriginCouponPolicy,error){
		policy:=poscheckout.OriginCouponPolicy{Contract:couponContract,DeductionMode:deductionMode}
		if couponContract!=poscheckout.OriginCouponConsumptionContract||deductionMode!="0"&&deductionMode!="1"{return policy,poscheckout.ErrReview}
		db,err:=gorm.Open("mysql",tx);if err!=nil{return policy,err};db.LogMode(false);var order Order;if err=db.Where("id=?",creation.OrderID).First(&order).Error;err!=nil{return policy,err}
		var store OrderStore;res:=db.Where("order_id=?",order.ID).First(&store);if res.Error!=nil&&!gorm.IsRecordNotFoundError(res.Error){return policy,res.Error};exchange,err:=originExchange(db,&order);if err!=nil{return policy,err}
		policy.WillConsume=!exchange&&((order.HlParentOrderId<=0&&deductionMode=="1")||store.StoreID>0);policy.WillReverse=deductionMode=="0"&&store.StoreID==0;if !policy.WillConsume{if exchange{policy.NoConsumptionReason="exchange"}else if order.HlParentOrderId>0{policy.NoConsumptionReason="hyperlocal-child"}};return policy,nil
	}
	gate,err:=newOriginGateway(e.DB,os.Getenv);if err!=nil{e.Selected=false}else{e.Provider=gate}
	stockMode,modeErr:=poscheckout.OriginStockMode(requestContext,os.Getenv);if modeErr!=nil{e.Selected=false}
	e.BuildRequest=func(ctx context.Context,tx *sql.Tx,command poscheckout.OriginCommand,creation poscheckout.OriginCreation,input poscheckout.OriginPaymentInput)(poscheckout.OriginProviderRequest,error){if c==nil{return poscheckout.OriginProviderRequest{},poscheckout.ErrReview};request,err:=buildOriginRequest(ctx,tx,command,creation,input,provider,c);request.StockMode=stockMode;return request,err}
	hours,_:=strconv.ParseFloat(os.Getenv("MAX_PAYMENT_WINDOW_HOURS"),64);if hours>0&&hours<=24{e.WebhookWindowMillis=int64(hours*3600000)}
	e.Apply=func(ctx context.Context,tx *sql.Tx,scope poscheckout.OriginApplyContext,effects *poscheckout.OriginEffectCollector)error{
		db,err:=gorm.Open("mysql",tx);if err!=nil{return err};db.LogMode(false);var order Order
		if err=db.Where("id=?",scope.Creation.OrderID).First(&order).Error;err!=nil{return err};if order.User!=int(originParseID(scope.Command.CustomerID)){return poscheckout.ErrReview}
		exchange,err:=originExchange(db,&order);if err!=nil{return err}
		// A real signature/status read, amount check and window check have
		// already proved capture. Preserve the source's captured(8)->paid(4)
		// branch even if TXN_CREATED arrived late or method15 is used.
		if scope.Observation.Status=="CHARGED"{if err=db.Model(&order).Update("payment_status",8).Error;err!=nil{return err};order.PaymentStatus=8}
		if modeErr!=nil||scope.StockMode!=stockMode{return poscheckout.ErrReview};if exchange{err=order.applyOtherOriginExchange(db,effects,scope.StockMode)}else{
		reduce:=true;if scope.Observation.Status=="DIRECT"&&(order.PaymentMethod==PaymentMethodCOD||order.PaymentMethod==PaymentMethodPrepaid)||scope.Observation.Route=="webhook"{reduce=false}
		err=order.applyOtherOriginSource(db,effects,scope.StockMode,reduce)}
		if err!=nil{return err};if scope.Provider=="gokwik"&&scope.Observation.Status=="CHARGED"{return recordOtherOriginGokwikSuccess(ctx,tx,db,scope,key)};return nil
	}
	e.Decline=func(ctx context.Context,tx *sql.Tx,scope poscheckout.OriginApplyContext,effects *poscheckout.OriginEffectCollector)error{
		db,err:=gorm.Open("mysql",tx);if err!=nil{return err};db.LogMode(false);var order Order;if err=db.Where("id=?",scope.Creation.OrderID).First(&order).Error;err!=nil{return err}
		if order.Status!=0{return nil};var store OrderStore;res:=db.Where("order_id=?",order.ID).First(&store);if res.Error!=nil&&!gorm.IsRecordNotFoundError(res.Error){return res.Error}
		if scope.Observation.Status!="AUTHORIZATION_FAILED"{if err=db.Model(&order).Update("order_status",17).Error;err!=nil{return err};if err=effects.Add("payment-failure","","",0,0,false);err!=nil{return err}}
		if os.Getenv("IS_DEDUCT")=="0"&&store.StoreID==0{
			if order.TssMoneyUsed>0{if err=order.revertOtherOriginMoney(db);err!=nil{return err}}
			if order.TssPointsUsed>0{if err=order.revertOtherOriginPoints(db);err!=nil{return err}}
			if order.VoucherUsed>0{if err=originProvedVoucherDebit(db,&order);err!=nil{return err};if err=order.revertOtherOriginVoucher(db);err!=nil{return err}}
			if order.CouponUsed>0{if err=order.revertOtherOriginCoupon(db);err!=nil{return err}}
		}
		if err=order.revertOtherOriginDonation(db);err!=nil{return err};if err=db.Model(&order).Update("payment_status",7).Error;err!=nil{return err}
		if err=effects.Add("hold-release","","",0,0,false);err!=nil{return err};if os.Getenv("TRANS_LOCK_FEATURE")=="1"{return effects.Add("wallet-unlock","","",5,0,false)};return nil
	}
	e.Mismatch=func(ctx context.Context,tx *sql.Tx,scope poscheckout.OriginApplyContext,effects *poscheckout.OriginEffectCollector)error{
		db,err:=gorm.Open("mysql",tx);if err!=nil{return err};db.LogMode(false);var order Order;if err=db.Where("id=?",scope.Creation.OrderID).First(&order).Error;err!=nil{return err}
		payable:=fmt.Sprintf("%.2f",order.PayAmount);charged:=fmt.Sprintf("%.2f",float64(scope.Observation.AmountPaise)/100);source:=scope.Observation.Route;if source=="webhook"{source="webhook:ORDER_SUCCEEDED"}
		now:=FetchCurrentTime().Format("2006-01-02 15:04:05");comment:=Comment{OrderID:order.ID,StatusID:order.Status,Comment:"Payment amount mismatch: gateway charged "+charged+" against payable "+payable+" (source: "+source+"). Order left unconfirmed for manual review.",Notify:0,UserID:order.User,CreatedAt:now,UpdatedAt:now}
		if err=db.Create(&comment).Error;err!=nil{return err};if os.Getenv("PAYMENT_ALERT_WEBHOOK")!=""{return effects.AddAmountMismatch(payable,charged,source,now)};return nil
	}
	return e,nil
}
func originParseID(id string)int64{n,_:=strconv.ParseInt(id,10,64);return n}
func originExchange(db *gorm.DB,order *Order)(bool,error){
	if order.ParentOrderId>0{var parent Order;if err:=db.Set("gorm:query_option","FOR SHARE").Where("id=?",order.ParentOrderId).First(&parent).Error;err!=nil{return false,err};if parent.User!=order.User{return false,poscheckout.ErrReview};if parent.IsExpress==1{return true,nil}}
	var log ReshippingOrderLogs;res:=db.Where("order_id=?",order.ID).First(&log);if res.Error!=nil&&!gorm.IsRecordNotFoundError(res.Error){return false,res.Error};return log.Id>0||order.PaymentMethod==PaymentMethodPrepaid&&order.OriginalOrderId>0,nil
}
func originProvedVoucherDebit(db *gorm.DB,order *Order)error{
	// A decline may credit only its genuine original debit. Never reactivate a
	// card merely because the current status is 0 or a request named an order.
	var count int;res:=db.Table("gift_voucher_history").Where("order_id=? AND gv_id=? AND user_id=? AND platform='ORDER_PLACED' AND added_amt=?",order.ID,order.VoucherUsed,order.User,-order.VoucherAmountUsed).Count(&count)
	if res.Error!=nil{return res.Error};if count!=1{return poscheckout.ErrReview};return nil
}

func originCaller(c *gin.Context,customer string,system bool)(poscheckout.OriginCaller,error){
	value:=poscheckout.OriginCaller{CustomerID:customer,System:system,CSKAPIKey:os.Getenv("POS_SCREENING_ORIGIN_CSK_API_KEY"),StaffGrantID:c.GetHeader("X-TSS-Screening-Staff-Grant")}
	if system{if c.GetHeader(originAuthorizationHeader)==""{return value,poscheckout.ErrReview};return value,nil}
	raw:=c.GetHeader("Authorization");if raw==""||len(raw)>16000{return value,poscheckout.ErrReview};token:=raw;value.TwoFA=strings.HasPrefix(raw,"2f.");if value.TwoFA{token=strings.TrimPrefix(raw,"2f.")}
	if value.TwoFA&&os.Getenv("JWT_KEY_512")==""||!value.TwoFA&&os.Getenv("JWT_KEY")==""{return value,poscheckout.ErrReview};claims,err:=jwt.FromString(token);if err!=nil{return value,poscheckout.ErrReview};if value.TwoFA{err=claims.Verify(jwt.HS512(os.Getenv("JWT_KEY_512")))}else{err=claims.Verify(jwt.HS256(os.Getenv("JWT_KEY")))}
	if err!=nil||claims.Subject()!=customer||!claims.ExpirationTime().After(time.Now()){return value,poscheckout.ErrReview};value.Credential=raw;value.CredentialExpiresAt=claims.ExpirationTime().UnixMilli();return value,nil
}

func otherOriginRefused(c *gin.Context){poscheckout.OriginLogEvent(os.Stdout,"refused",c.GetHeader("X-Request-ID"),nil);c.Header("Cache-Control","private, no-store");c.JSON(http.StatusServiceUnavailable,gin.H{"status":http.StatusServiceUnavailable,"message":"The original payment requires reconciliation."})}
func otherOriginMissing(c *gin.Context){c.Header("Cache-Control","private, no-store");c.JSON(http.StatusNotFound,gin.H{"code":"SCREENING_ORIGIN_PAYMENT_NOT_FOUND","message":"No retained payment attempt was found. This is not a no-effect receipt."})}
func RegisterOtherOriginPaymentRoutes(group *gin.RouterGroup){
	group.POST("/screening-origins/:commandId/payment",func(c *gin.Context){serveOtherOriginPayment(c,false)})
	group.GET("/screening-origins/:commandId/payment",func(c *gin.Context){serveOtherOriginPayment(c,true)})
}
func serveOtherOriginPayment(c *gin.Context,read bool){
	c.Header("Cache-Control","private, no-store");if c.Request.URL.RawQuery!=""{otherOriginRefused(c);return}
	key:=os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY");purpose:="payment-submission";if read{purpose="payment-read"}
	if _,err:=poscheckout.OriginMAC(key,"ready",nil);err!=nil{otherOriginRefused(c);return}
	var origin,customer string;if utils.Db.DB().QueryRowContext(c.Request.Context(),`SELECT origin,CAST(customer_id AS CHAR) FROM pos_rewrite_screening_origin_commands WHERE id=?`,c.Param("commandId")).Scan(&origin,&customer)!=nil{otherOriginRefused(c);return}
	caller,err:=originCaller(c,customer,origin=="external-system");if err!=nil{otherOriginRefused(c);return}
	engine,err:=originEngine(c,"juspay",!read);if err!=nil{otherOriginRefused(c);return}
	var cap poscheckout.OriginPaymentAuthorization;var input poscheckout.OriginPaymentInput
	if !read{raw,e:=io.ReadAll(io.LimitReader(c.Request.Body,16001));if e!=nil||poscheckout.OriginDecode(raw,&input,16000)!=nil{otherOriginRefused(c);return};input.Original=raw}
	if c.GetHeader(originAuthorizationHeader)!=""{cap,err=poscheckout.OriginAuthorization(c.GetHeader(originAuthorizationHeader),key,purpose,time.Now().UnixMilli())}else if !caller.System{if read{cap,err=engine.NativeReadAuthorization(c.Request.Context(),c.Param("commandId"),caller)}else{cap,err=engine.NativeAuthorization(c.Request.Context(),c.Param("commandId"),caller,input)}}else{err=poscheckout.ErrReview}
	if read&&errors.Is(err,sql.ErrNoRows){otherOriginMissing(c);return};if err!=nil||cap.CommandID!=c.Param("commandId")||cap.CustomerID!=customer||c.GetHeader(originCommandHeader)!=""&&c.GetHeader(originCommandHeader)!=cap.CommandID{otherOriginRefused(c);return}
	var view poscheckout.OriginPaymentView
	if read{view,err=engine.Read(c.Request.Context(),cap,caller,true,c.GetHeader("X-Request-ID"))}else{
		view,err=engine.Start(c.Request.Context(),cap,caller,input,c.GetHeader("X-Request-ID"))
	}
	if read&&errors.Is(err,sql.ErrNoRows){otherOriginMissing(c);return};if err!=nil{otherOriginRefused(c);return};c.JSON(http.StatusOK,view)
}

// Source ProcessOrder calls this after its original JWT ownership check and
// before CreateCustomer, provider POST, goroutines or parent financial writes.
func tryOtherOriginProcessOrder(c *gin.Context,order *Order,input POrder,provider string)bool{
	if os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY")==""{return false}
	var command,origin string
	err:=utils.Db.DB().QueryRowContext(c.Request.Context(),`SELECT id,origin FROM pos_rewrite_screening_origin_commands WHERE order_id=?`,order.ID).Scan(&command,&origin)
	if err==sql.ErrNoRows{return false};if err!=nil{otherOriginRefused(c);return true}
	if origin=="external-system"{serveOtherOriginOriginal(c,order,input,provider,command,true);return true}
	serveOtherOriginOriginal(c,order,input,provider,command,false);return true
}
func serveOtherOriginOriginal(c *gin.Context,order *Order,input POrder,provider,command string,system bool){
	engine,err:=originEngine(c,provider,true);if err!=nil{otherOriginRefused(c);return}
	caller,err:=originCaller(c,strconv.Itoa(order.User),system);if err!=nil{otherOriginRefused(c);return}
	request:=poscheckout.OriginPaymentInput{Order:int64(input.Order),Method:int64(input.Method),PaymentMethod:input.PayMethod,Platform:input.Platform,OS:input.Ops}
	var cap poscheckout.OriginPaymentAuthorization
	if c.GetHeader(originAuthorizationHeader)!=""{cap,err=poscheckout.OriginAuthorization(c.GetHeader(originAuthorizationHeader),engine.Key,"payment-submission",time.Now().UnixMilli())}else if !system{cap,err=engine.NativeAuthorization(c.Request.Context(),command,caller,request)}else{err=poscheckout.ErrReview}
	if err!=nil||cap.CommandID!=command{otherOriginRefused(c);return}
	view,err:=engine.Start(c.Request.Context(),cap,caller,request,c.GetHeader("X-Request-ID"));if err!=nil{otherOriginRefused(c);return}
	if view.NoEffect!=nil{c.JSON(http.StatusOK,view);return}
	if view.Status=="CONFIRMED"{c.JSON(http.StatusCreated,gin.H{"status":http.StatusCreated,"message":"/thank-you"});return}
	if view.Response!=nil&&len(view.Response.ClientResponse)>0{c.Data(http.StatusCreated,"application/json",view.Response.ClientResponse);return}
	c.JSON(http.StatusAccepted,gin.H{"status":http.StatusAccepted,"message":"The original payment is awaiting reconciliation.","commandId":command})
}

func buildOriginRequest(ctx context.Context,tx *sql.Tx,command poscheckout.OriginCommand,creation poscheckout.OriginCreation,input poscheckout.OriginPaymentInput,provider string,c *gin.Context)(poscheckout.OriginProviderRequest,error){
	request:=poscheckout.OriginProviderRequest{Provider:provider,OrderID:creation.OrderID,CustomerID:command.CustomerID,CustomerFields:map[string]string{},OrderFields:map[string]string{}}
	db,err:=gorm.Open("mysql",tx);if err!=nil{return request,err};db.LogMode(false);var order Order;if err=db.Where("id=?",creation.OrderID).First(&order).Error;err!=nil{return request,err}
	if provider=="juspay"{var user User;if err=db.Where("id=?",order.User).First(&user).Error;err!=nil{return request,err};reference:=originCanonicalCustomerID(command.CustomerID);request.CustomerFields=map[string]string{"object_reference_id":reference,"id":reference,"email_address":user.Email,"first_name":user.Firstname};if normalized,ok:=normalizeAndValidateMobile(user.Telephone);ok{request.CustomerFields["mobile_number"]=normalized}}
	exchange,err:=originExchange(db,&order);if err!=nil{return request,err}
	if provider=="juspay"&&(exchange||order.PaymentMethod==PaymentMethodCOD||order.PaymentMethod==PaymentMethodPrepaid||order.PaymentMethod==PaymentMethodCOC){request.Provider="none";return request,nil}
	if provider=="gokwik"{
		body,err:=buildOtherOriginCreateOrderGokwik(db,order.ID,order.User,c.GetHeader("User-Agent"),c.ClientIP());if err!=nil{return request,err};raw,err:=json.Marshal(body);if err!=nil||len(raw)>1000000{return request,poscheckout.ErrReview};request.OrderFields["body"]=string(raw);return request,nil
	}
	descriptions:=map[int]string{PaymentMethodCard:"Debit and Credit Card",PaymentMethodNetbank:"Netbanking",PaymentMethodWallet:"Wallet",PaymentMethodUPI:"UPI",PaymentMethodTWID:"TWID",PaymentMethodSnapmint:"SNAPMINT"}
	description:=descriptions[order.PaymentMethod];if description==""{return request,poscheckout.ErrReview}
	returnURL:=os.Getenv("JUSPAY_RETURN_URL");if c.GetHeader("Origin")==os.Getenv("ALLOW_CORS_WWE"){returnURL=os.Getenv("JUSPAY_RETURN_URL_WWE")}
	if err=originPrivateEndpoint(returnURL);err!=nil{return request,err}
	request.OrderFields,err=buildOtherOriginCreateOrder(db,order.ID,order.User,order.PayAmount,returnURL,order.Phone,description,input.PaymentMethod,input.Platform,input.OS,c.ClientIP(),c.GetHeader("User-Agent"));if err!=nil{return request,err}
	return request,nil
}
func reduceOtherOriginOnline(db *gorm.DB,product *Product,quantity int,order *Order,effects *poscheckout.OriginEffectCollector)error{
	var stock ProductStock;if err:=db.Set("gorm:query_option","FOR UPDATE").Where("prod_id=?",product.ID).First(&stock).Error;err!=nil{return err};if quantity<1||stock.Stock<quantity{return poscheckout.ErrReview}
	if err:=db.Model(&stock).Where("prod_id=?",product.ID).Update("stock",stock.Stock-quantity).Error;err!=nil{return err}
	if err:=effects.Add("hold-set",strconv.FormatUint(uint64(product.ID),10),"",int64(quantity),0,false);err!=nil{return err};return effects.Add("online-product-sync",strconv.FormatUint(uint64(product.ID),10),"",0,0,false)
}
func reduceOtherOriginStore(db *gorm.DB,stock *ProductStore,quantity int,order *Order,effects *poscheckout.OriginEffectCollector)error{
	if quantity<1||stock.Stock<quantity{return poscheckout.ErrReview};if err:=db.Model(stock).Limit(1).Update("stock",stock.Stock-quantity).Error;err!=nil{return err};return effects.Add("store-product-sync",strconv.Itoa(stock.ProductID),"",0,0,false)
}
func createOtherOriginRecord(db *gorm.DB,value interface{})*gorm.DB{
	switch row:=value.(type){case *TssMoneyHistory:if row.AddedAmt<0&&row.Expiry.IsZero(){return db.Omit("expiry").Create(value)};case *TssPointHistory:if row.AddedAmt<0&&row.Expiry.IsZero(){return db.Omit("expiry").Create(value)}};return db.Create(value)
}

// Guard every old internal confirmation path too. Authenticated callbacks are
// intercepted before entering this method; a raw/unqualified call cannot
// confirm a source-owned origin by bypassing the durable attempt.
func tryOtherOriginInternal(order *Order,db *gorm.DB)(bool,bool){
	if os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY")==""{return false,false}
	var command string;err:=db.CommonDB().QueryRow(`SELECT id FROM pos_rewrite_screening_origin_commands WHERE order_id=?`,order.ID).Scan(&command);if err==sql.ErrNoRows{return false,false};if err!=nil{return true,false}
	var raw []byte;var seal string;database,ok:=db.CommonDB().(*sql.DB);if !ok{return true,false}
	tx,err:=database.BeginTx(context.Background(),&sql.TxOptions{Isolation:sql.LevelReadCommitted});if err!=nil{return true,false};defer tx.Rollback()
	c,err:=poscheckout.ReadOriginCommand(context.Background(),tx,command,strconv.Itoa(order.User),os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY"),false);if err!=nil{return true,false};creation,err:=poscheckout.ReadOriginCreation(context.Background(),tx,c,os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY"));if err!=nil{return true,false}
	if tx.QueryRow(`SELECT data,proof_hash FROM pos_rewrite_screening_origin_payments WHERE command_id=?`,command).Scan(&raw,&seal)!=nil{return true,false}
	_,err=poscheckout.ReadOriginPayment(context.Background(),tx,c,creation,os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY"));return true,err==nil
}
func originRestoreBody(c *gin.Context,raw []byte){c.Request.Body=io.NopCloser(bytes.NewReader(raw))}
