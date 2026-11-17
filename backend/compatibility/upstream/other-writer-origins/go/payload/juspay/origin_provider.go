package juspay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"backend-tss-domestic_payments_api/internal/poscheckout"
	"github.com/jinzhu/gorm"
)

type originGateway struct{db *sql.DB;env func(string)string;client *http.Client}
func originPrivateEndpoint(raw string)error{u,e:=url.Parse(raw);if e!=nil||u.Scheme!="https"||u.Hostname()==""||u.User!=nil||u.Fragment!=""||u.RawQuery!=""{return poscheckout.ErrReview};return nil}
func newOriginGateway(db *sql.DB,env func(string)string)(*originGateway,error){
	if db==nil{return nil,poscheckout.ErrReview};return &originGateway{db:db,env:env,client:&http.Client{Timeout:10*time.Second,CheckRedirect:func(*http.Request,[]*http.Request)error{return poscheckout.ErrReview}}},nil
}
func originCanonicalCustomerID(id string)string{if len(id)>=8{return id};return strings.Repeat("0",8-len(id))+id}
func(g *originGateway)request(ctx context.Context,provider,method,path string,body io.Reader,contentType string)(int,[]byte,error){
	base:=g.env("JUSPAY_URL");if provider=="gokwik"{base=g.env("GOKWIK_URL")};if originPrivateEndpoint(base)!=nil||strings.HasPrefix(path,"/"){return 0,nil,poscheckout.ErrReview}
	req,e:=http.NewRequestWithContext(ctx,method,strings.TrimRight(base,"/")+"/"+path,body);if e!=nil{return 0,nil,poscheckout.ErrReview}
	if provider!="gokwik"||path!="payment/verify"{if g.env("BASIC_AUTH")==""{return 0,nil,poscheckout.ErrReview};req.SetBasicAuth(g.env("BASIC_AUTH"),"")};req.Header.Set("Content-Type",contentType)
	if provider=="gokwik"{if g.env("GOKWIK_APP_ID")==""||g.env("GOKWIK_APP_SECRET")==""{return 0,nil,poscheckout.ErrReview};req.Header.Set("appid",g.env("GOKWIK_APP_ID"));req.Header.Set("appsecret",g.env("GOKWIK_APP_SECRET"))}else{req.Header.Set("version",g.env("PAYMENT_VERSION_DATE"));if method==http.MethodGet&&strings.HasPrefix(path,"orders/"){req.Header.Set("x-merchantid",g.env("JP_MERCHANT_ID"))}}
	response,e:=g.client.Do(req);if e!=nil{return 0,nil,poscheckout.ErrReview};defer response.Body.Close();raw,e:=io.ReadAll(io.LimitReader(response.Body,1048577));if e!=nil||len(raw)>1048576{return 0,nil,poscheckout.ErrReview};return response.StatusCode,raw,nil
}
func(g *originGateway)Start(ctx context.Context,request poscheckout.OriginProviderRequest)(poscheckout.OriginProviderResponse,error){
	if request.Provider=="none"{customer,e:=g.customer(ctx,request);if e!=nil{return poscheckout.OriginProviderResponse{},e};return originDirectCustomerResponse(request,customer,"process-order"),nil}
	if request.Provider=="gokwik"{code,raw,e:=g.request(ctx,"gokwik",http.MethodPost,"order/create",strings.NewReader(request.OrderFields["body"]),"application/json");if e!=nil||code!=http.StatusOK{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};return g.gokwikCreated(ctx,request,raw)}
	if request.Provider!="juspay"{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview}
	customer,e:=g.customer(ctx,request);if e!=nil{return poscheckout.OriginProviderResponse{},e}
	fields:=url.Values{};for k,v:=range request.OrderFields{fields.Set(k,v)};fields.Set("customer_id",customer)
	code,raw,e:=g.request(ctx,"juspay",http.MethodPost,"orders",strings.NewReader(fields.Encode()),"application/x-www-form-urlencoded");if e!=nil||code!=http.StatusOK{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};return g.juspayResult(ctx,request,raw,"process-order")
}
func(g *originGateway)Recover(ctx context.Context,request poscheckout.OriginProviderRequest)(poscheckout.OriginProviderResponse,error){
	if request.Provider=="none"{code,raw,e:=g.request(ctx,"juspay",http.MethodGet,"customers/"+originCanonicalCustomerID(request.CustomerID),nil,"");if e!=nil||code!=http.StatusOK{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};var customer CustomerResponse;if json.Unmarshal(raw,&customer)!=nil||customer.Customer==""||customer.Hash!=originCanonicalCustomerID(request.CustomerID){return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};return originDirectCustomerResponse(request,customer.Customer,"provider-read"),nil}
	if request.Provider=="gokwik"{return g.gokwikRecover(ctx,request)}
	if request.Provider!="juspay"{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};code,raw,e:=g.request(ctx,"juspay",http.MethodGet,"orders/"+request.OrderID,nil,"");if e!=nil||code!=http.StatusOK{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};return g.juspayResult(ctx,request,raw,"provider-read")
}
func originDirectCustomerResponse(request poscheckout.OriginProviderRequest,customer,route string)poscheckout.OriginProviderResponse{
	evidence:=sha256.Sum256([]byte("source-customer-confirmed:"+request.CustomerID+":"+customer));response,_:=json.Marshal(map[string]interface{}{"status":http.StatusCreated,"message":"/thank-you"})
	return poscheckout.OriginProviderResponse{OrderID:request.OrderID,Status:"DIRECT",ProviderReference:request.OrderID,EvidenceHash:hex.EncodeToString(evidence[:]),ObservedAt:time.Now().UnixMilli(),Route:route,ClientResponse:response}
}
func(g *originGateway)customer(ctx context.Context,request poscheckout.OriginProviderRequest)(string,error){
	reference:=originCanonicalCustomerID(request.CustomerID);lookup:=reference;var existing JpCustomer
	db,e:=gorm.Open("mysql",g.db);if e!=nil{return "",e};db.LogMode(false);res:=db.Where("user=?",originParseID(request.CustomerID)).First(&existing);if res.Error!=nil&&!gorm.IsRecordNotFoundError(res.Error){return "",res.Error};if existing.JuspayCust!=""{lookup=existing.JuspayCust}
	code,raw,e:=g.request(ctx,"juspay",http.MethodGet,"customers/"+url.PathEscape(lookup),nil,"");if e!=nil{return "",e};var customer CustomerResponse
	if code==http.StatusOK{
		if json.Unmarshal(raw,&customer)!=nil||customer.Customer==""||customer.Hash!=reference{return "",poscheckout.ErrReview}
		if strings.TrimSpace(customer.Email)==""||strings.TrimSpace(customer.Mobile)==""||customer.Mobile=="1111111111"&&request.CustomerFields["mobile_number"]!="1111111111"{
			values:=url.Values{};for _,name:=range []string{"email_address","first_name","mobile_number"}{if v:=request.CustomerFields[name];v!=""{values.Set(name,v)}}
			code,raw,e=g.request(ctx,"juspay",http.MethodPost,"customers/"+url.PathEscape(customer.Customer),strings.NewReader(values.Encode()),"application/x-www-form-urlencoded");if e!=nil||code!=http.StatusOK{return "",poscheckout.ErrReview}
		}
	}else if code==http.StatusNotFound||code==http.StatusBadRequest{
		values:=url.Values{};for name,value:=range request.CustomerFields{values.Set(name,value)}
		code,raw,e=g.request(ctx,"juspay",http.MethodPost,"customers",strings.NewReader(values.Encode()),"application/x-www-form-urlencoded");if e!=nil{return "",e}
		if code==http.StatusBadRequest{code,raw,e=g.request(ctx,"juspay",http.MethodGet,"customers/"+reference,nil,"")}
		if e!=nil||code!=http.StatusOK||json.Unmarshal(raw,&customer)!=nil||customer.Hash!=reference||customer.Customer==""{return "",poscheckout.ErrReview}
	}else{return "",poscheckout.ErrReview}
	// A provider customer ACK is not financial proof. Keep its original mapping
	// under the native current customer lock; no parent Order mutation occurs.
	owned:=db.Begin();if owned.Error!=nil{return "",owned.Error};defer owned.Rollback();var native User
	if owned.Set("gorm:query_option","FOR UPDATE").Where("id=?",originParseID(request.CustomerID)).First(&native).Error!=nil||native.Email!=request.CustomerFields["email_address"]{return "",poscheckout.ErrReview}
	if existing.ID==0{existing=JpCustomer{JuspayCust:customer.Customer,User:int(originParseID(request.CustomerID)),Email:native.Email};if owned.Create(&existing).Error!=nil{return "",poscheckout.ErrReview}}else if owned.Model(&existing).Updates(map[string]interface{}{"juspay_cust":customer.Customer,"email":native.Email}).Error!=nil{return "",poscheckout.ErrReview}
	if owned.Commit().Error!=nil{return "",poscheckout.ErrReview};return customer.Customer,nil
}
func(g *originGateway)juspayResult(ctx context.Context,request poscheckout.OriginProviderRequest,raw []byte,route string)(poscheckout.OriginProviderResponse,error){
	var result OrderResponse;if json.Unmarshal(raw,&result)!=nil||result.Order!=request.OrderID||result.JuspayOrder==""||result.Customer==""||len(result.JusPay.ClientAuthToken)>16000{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview}
	amount:=float64(result.Amount);if math.IsNaN(amount)||math.IsInf(amount,0)||amount<0||amount>999999999{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};sum:=sha256.Sum256(raw)
	status:=result.Status;switch status{case "CHARGED","AUTHENTICATION_FAILED","AUTHORIZATION_FAILED","JUSPAY_DECLINED":default:status="PENDING"}
	// The pinned customer token getter is GET-only. It can recover client
	// access after the original order-create ACK was lost, without reissuing
	// either the merchant order or a payment request.
	if route=="provider-read"&&status=="PENDING"&&result.JusPay.ClientAuthToken==""{
		code,customerRaw,readErr:=g.request(ctx,"juspay",http.MethodGet,"customers/"+url.PathEscape(result.Customer)+"?options.get_client_auth_token=true",nil,"")
		if readErr==nil&&code==http.StatusOK{var customer jpCustomerResponse;if json.Unmarshal(customerRaw,&customer)==nil&&customer.Customer==result.Customer&&customer.Hash==originCanonicalCustomerID(request.CustomerID)&&len(customer.Content.ClientAuthToken)<=16000{result.JusPay.ClientAuthToken=customer.Content.ClientAuthToken}}
	}
	response,_:=json.Marshal(map[string]interface{}{"status":http.StatusCreated,"message":json.Number(request.OrderID),"client_auth_token":result.JusPay.ClientAuthToken})
	o:=poscheckout.OriginProviderResponse{OrderID:request.OrderID,Status:status,ProviderReference:result.JuspayOrder,ClientAuthToken:result.JusPay.ClientAuthToken,ClientResponse:response,AmountPaise:int64(math.Round(amount*100)),EvidenceHash:hex.EncodeToString(sum[:]),ObservedAt:time.Now().UnixMilli(),Route:route}
	var details JpWebhookOrder;if json.Unmarshal(raw,&details)!=nil{return o,poscheckout.ErrReview};o.GatewayID=int64(details.GatewayID);o.GatewayReference=strconv.Itoa(details.GatewayRefernceID)
	if status=="CHARGED"{o.LogStatus="ORDER_SUCCEEDED"}else if status=="AUTHENTICATION_FAILED"||status=="AUTHORIZATION_FAILED"||status=="JUSPAY_DECLINED"{o.LogStatus=status}
	db,e:=gorm.Open("mysql",g.db);if e!=nil{return o,e};db.LogMode(false);var current JpOrder;res:=db.Where("juspay_order=?",result.JuspayOrder).First(&current);if res.Error!=nil&&!gorm.IsRecordNotFoundError(res.Error){return o,res.Error}
	value:=JpOrder{Customer:result.Customer,User:int(originParseID(request.CustomerID)),Order:int(originParseID(request.OrderID)),JuspayOrder:result.JuspayOrder,Status:result.Status,Amount:result.Amount,Email:result.Email,Phone:result.Phone,StatusId:result.StatusId,Link_web:result.Links.Link_web,Link_mobile:result.Links.Link_mobile}
	if current.ID==0{e=db.Create(&value).Error}else{if current.Order!=value.Order||current.User!=value.User{return o,poscheckout.ErrReview};e=db.Model(&current).Updates(value).Error};return o,e
}
func(g *originGateway)gokwikCreated(ctx context.Context,request poscheckout.OriginProviderRequest,raw []byte)(poscheckout.OriginProviderResponse,error){
	var result GokwikOrderResponse;if json.Unmarshal(raw,&result)!=nil||result.StatusCode!=200||result.Data.MOID!=request.OrderID||result.Data.RequestId==""||result.Data.GokwikOID==""{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview}
	row:=GokwikOrder{UserId:uint(originParseID(request.CustomerID)),OrderId:uint(originParseID(request.OrderID)),RequestId:result.Data.RequestId,GokwikOID:result.Data.GokwikOID,OrderStatus:result.Data.OrderStatus,Total:result.Data.Total,MOID:result.Data.MOID,MID:result.Data.MID,Phone:result.Data.Phone,OrderType:result.Data.OrderType,StatusCode:result.StatusCode,StatusMessage:result.StatusMessage,Status:"CREATED"}
	db,e:=gorm.Open("mysql",g.db);if e!=nil{return poscheckout.OriginProviderResponse{},e};db.LogMode(false);if e=db.Create(&row).Error;e!=nil{return poscheckout.OriginProviderResponse{},e}
	response,_:=json.Marshal(map[string]interface{}{"status":http.StatusCreated,"order_id":json.Number(request.OrderID),"message":result.StatusMessage,"gokwik_data":result.Data});sum:=sha256.Sum256(raw)
	status:="PENDING";if result.Data.OrderType=="cod"{status="DIRECT"}
	return poscheckout.OriginProviderResponse{OrderID:request.OrderID,Status:status,ProviderReference:result.Data.GokwikOID,ClientResponse:response,EvidenceHash:hex.EncodeToString(sum[:]),ObservedAt:time.Now().UnixMilli(),Route:"gokwik"},nil
}
func(g *originGateway)gokwikRecover(ctx context.Context,request poscheckout.OriginProviderRequest)(poscheckout.OriginProviderResponse,error){
	// The pinned provider has POST payment/verify as its read-only status API.
	// Only the public receiver is GET. Never call order/create from recovery.
	db,e:=gorm.Open("mysql",g.db);if e!=nil{return poscheckout.OriginProviderResponse{},e};db.LogMode(false);var row GokwikOrder
	res:=db.Where("order_id=? AND status='CREATED'",request.OrderID).Order("created_at").First(&row);if res.Error!=nil&&!gorm.IsRecordNotFoundError(res.Error){return poscheckout.OriginProviderResponse{},res.Error}
	if row.RequestId!=""&&row.GokwikOID!=""{
		if strconv.FormatUint(uint64(row.UserId),10)!=request.CustomerID||row.MOID!=request.OrderID{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview}
		if row.OrderType=="cod"{sum:=sha256.Sum256([]byte("original-gokwik-cod-ack:"+row.RequestId+":"+row.GokwikOID));return poscheckout.OriginProviderResponse{OrderID:request.OrderID,Status:"DIRECT",ProviderReference:row.GokwikOID,EvidenceHash:hex.EncodeToString(sum[:]),ObservedAt:time.Now().UnixMilli(),Route:"gokwik"},nil}
		return g.gokwikVerify(ctx,request,row.RequestId,row.GokwikOID)
	}
	link,err:=poscheckout.ReadOriginGokwikLink(ctx,g.db,g.env("POS_SCREENING_ORIGIN_PROOF_KEY"),request.OrderID);if err!=nil||link==nil||link.CustomerID!=request.CustomerID{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview}
	return g.gokwikVerify(ctx,request,link.RequestID,link.ProviderReference)
}
func(g *originGateway)gokwikVerify(ctx context.Context,request poscheckout.OriginProviderRequest,requestID,reference string)(poscheckout.OriginProviderResponse,error){
	if request.Provider!="gokwik"||len(requestID)<1||len(requestID)>255||len(reference)<1||len(reference)>255{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview}
	body,_:=json.Marshal(map[string]string{"request_id":requestID,"gokwik_oid":reference});code,raw,e:=g.request(ctx,"gokwik",http.MethodPost,"payment/verify",bytes.NewReader(body),"application/json");if e!=nil||code!=http.StatusOK{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview}
	var result GokwikPaymentVerifyResponse;if json.Unmarshal(raw,&result)!=nil||result.Data.GokwikOID!=reference{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};status:="PENDING";if result.StatusCode==200{status="CHARGED"}else if result.StatusCode!=202{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview}
	var method int64;if g.db.QueryRowContext(ctx,`SELECT payment_method FROM orders WHERE id=? AND user_id=?`,request.OrderID,request.CustomerID).Scan(&method)!=nil{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};if method==1{status="DIRECT"}
	amount,e:=strconv.ParseFloat(result.Data.Total,64);if e!=nil||math.IsNaN(amount)||math.IsInf(amount,0)||amount<0||amount>999999999{return poscheckout.OriginProviderResponse{},poscheckout.ErrReview};sum:=sha256.Sum256(raw)
	clientResponse,_:=json.Marshal(result)
	return poscheckout.OriginProviderResponse{OrderID:request.OrderID,Status:status,ProviderReference:reference,AmountPaise:int64(math.Round(amount*100)),GatewayReference:result.Data.TransactionId,EvidenceHash:hex.EncodeToString(sum[:]),ObservedAt:time.Now().UnixMilli(),Route:"gokwik",ClientResponse:clientResponse,ProviderMessage:result.StatusMessage},nil
}

// Static JSON refusal only; callers must never interpolate provider errors.
func originProviderFailure()error{return fmt.Errorf("origin provider outcome requires reconciliation")}
