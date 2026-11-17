package poscheckout

// Evidence around the literal source coupon mutations. These descriptors use
// the genuine source-origin key/scope; no imported order capability is accepted.
import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strconv"
	"time"
)

const OriginCouponConsumptionContract="pos-screening-origin-coupon-consumption-v1"
var originCouponCount=regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)
var originCouponAmount=regexp.MustCompile(`^(0|[1-9][0-9]{0,9})\.[0-9]{2}$`)

type OriginCouponPolicy struct {Contract string `json:"contract"`;DeductionMode string `json:"deductionMode"`;WillConsume bool `json:"willConsume"`;WillReverse bool `json:"willReverse"`;NoConsumptionReason string `json:"noConsumptionReason,omitempty"`}
type OriginCouponPolicyReader func(context.Context,*sql.Tx,OriginCommand,OriginCreation)(OriginCouponPolicy,error)
type OriginCouponUser struct {ID string `json:"id"`;Allowed string `json:"allowed"`;Used string `json:"used"`;MonthlyAllowed string `json:"monthlyAllowed"`;InputHash string `json:"inputHash"`}
type OriginCouponLog struct {ID string `json:"id"`;InputHash string `json:"inputHash"`;Status int64 `json:"status"`}
type OriginCouponAllocation struct {ID string `json:"id"`;ProductID string `json:"productId"`;Quantity int64 `json:"quantity"`;InputHash string `json:"inputHash"`;Discount string `json:"discount"`;Refundable string `json:"refundable"`;RefundInputHash string `json:"refundInputHash"`}
type OriginCouponStaged struct {
	Contract string `json:"contract"`;SourceCommit string `json:"sourceCommit"`;CommandID string `json:"commandId"`;Origin string `json:"origin"`
	ActorID *string `json:"actorId"`;CustomerID string `json:"customerId"`;StoreID *string `json:"storeId"`;CounterID *string `json:"counterId"`
	AuthorityHash string `json:"authorityHash"`;RequestHash string `json:"requestHash"`;CartHash string `json:"cartHash"`;NamespaceHash string `json:"namespaceHash"`
	OrderID string `json:"orderId"`;HeaderHash string `json:"headerHash"`;CouponID string `json:"couponId"`;CouponInputHash string `json:"couponInputHash"`
	ConfigurationHash string `json:"configurationHash"`;OriginConfigurationHash string `json:"originConfigurationHash"`
	HistoryRequirement string `json:"historyRequirement"`
	History *struct {GenerationID string `json:"generationId"`;DocumentHash string `json:"documentHash"`;WitnessHash string `json:"witnessHash"`} `json:"history"`
	BirthdayClaim *struct {ID string `json:"id"`;KeyHash string `json:"keyHash"`;ReceiptHash string `json:"receiptHash"`;ExpiresAt int64 `json:"expiresAt"`} `json:"birthdayClaim"`
	CartCouponDiscount string `json:"cartCouponDiscount"`;HeaderCouponAmount string `json:"headerCouponAmount"`;Consumption string `json:"consumption"`
	CouponUsersBefore []OriginCouponUser `json:"couponUsersBefore"`;CouponUsersAfter []OriginCouponUser `json:"couponUsersAfter"`;SourceLog *OriginCouponLog `json:"sourceLog"`
	Allocations []OriginCouponAllocation `json:"allocations"`;CreatedAt int64 `json:"createdAt"`
	WelcomeConsent *struct {Contract string `json:"contract"`;CustomerID string `json:"customerId"`;CustomerInputHash string `json:"customerInputHash"`;Eligible bool `json:"eligible"`;Rows []struct{ID string `json:"id"`;InputHash string `json:"inputHash"`} `json:"rows"`} `json:"welcomeConsent,omitempty"`
}
type OriginCouponCapture struct {stage OriginCouponStaged;seal string;policy OriginCouponPolicy}

func originCouponUsers(ctx context.Context,tx *sql.Tx,customer,coupon string)([]OriginCouponUser,error){
	// The native SQL leaves are byte-identical to the source producer. Sharing
	// their hash expressions does not share CSV authorization or grant ownership.
	rows,err:=tx.QueryContext(ctx,`SELECT CAST(id AS CHAR),CAST(coupon_allowed_count AS CHAR),CAST(coupon_used_count AS CHAR),CAST(coupon_month_allowed_count AS CHAR),`+ImportCouponUserHashSQL+` FROM coupons_users WHERE user_id=? AND c_id=? ORDER BY id LIMIT 1001 FOR UPDATE`,customer,coupon);if err!=nil{return nil,err};values:=[]OriginCouponUser{}
	for rows.Next(){var v OriginCouponUser;if rows.Scan(&v.ID,&v.Allowed,&v.Used,&v.MonthlyAllowed,&v.InputHash)!=nil{rows.Close();return nil,ErrReview};if !originIdentifier(v.ID)||!originCouponCount.MatchString(v.Allowed)||!originCouponCount.MatchString(v.Used)||!originCouponCount.MatchString(v.MonthlyAllowed)||!originHash.MatchString(v.InputHash){rows.Close();return nil,ErrReview};values=append(values,v)};err=rows.Err();rows.Close();if err!=nil||len(values)>1000{return nil,ErrReview};return values,nil
}
func originCouponLogs(ctx context.Context,tx *sql.Tx,c OriginCommand,order,coupon string)([]OriginCouponLog,error){
	rows,err:=tx.QueryContext(ctx,`SELECT CAST(id AS CHAR),CAST(user_id AS CHAR),CAST(coupon_id AS CHAR),status,`+ImportCouponLogHashSQL+` FROM order_coupon_log WHERE order_id=? ORDER BY id LIMIT 2 FOR UPDATE`,order);if err!=nil{return nil,err};values:=[]OriginCouponLog{}
	for rows.Next(){var v OriginCouponLog;var customer,id string;if rows.Scan(&v.ID,&customer,&id,&v.Status,&v.InputHash)!=nil||customer!=c.CustomerID||id!=coupon||!originIdentifier(v.ID)||!originHash.MatchString(v.InputHash)||v.Status!=0&&v.Status!=1{rows.Close();return nil,ErrReview};values=append(values,v)};err=rows.Err();rows.Close();if err!=nil||len(values)>1{return nil,ErrReview};return values,nil
}
func originCouponAllocations(ctx context.Context,tx *sql.Tx,order string)([]OriginCouponAllocation,error){
	rows,err:=tx.QueryContext(ctx,`SELECT CAST(id AS CHAR),CAST(prod_id AS CHAR),qty,`+OriginLineSQL+`,CAST(CAST(disc AS DECIMAL(12,2)) AS CHAR),CAST(CAST(amount_to_be_refunded AS DECIMAL(12,2)) AS CHAR),`+importCouponRefundHashSQL+` FROM has_products WHERE order_id=? ORDER BY id LIMIT 1001 FOR SHARE`,order);if err!=nil{return nil,err};values:=[]OriginCouponAllocation{}
	for rows.Next(){var v OriginCouponAllocation;if rows.Scan(&v.ID,&v.ProductID,&v.Quantity,&v.InputHash,&v.Discount,&v.Refundable,&v.RefundInputHash)!=nil||!originIdentifier(v.ID)||!originIdentifier(v.ProductID)||v.Quantity<1||v.Quantity>1000||!originHash.MatchString(v.InputHash)||!originHash.MatchString(v.RefundInputHash)||!originCouponAmount.MatchString(v.Discount)||!originCouponAmount.MatchString(v.Refundable){rows.Close();return nil,ErrReview};values=append(values,v)};err=rows.Err();rows.Close();if err!=nil||len(values)<1||len(values)>1000{return nil,ErrReview};return values,nil
}
func originCouponChanges(before,after []OriginCouponUser,delta int64)error{
	if len(before)!=len(after){return ErrReview};seen:=map[string]bool{}
	for i,old:=range before{v:=after[i];a,e:=strconv.ParseInt(old.Used,10,64);b,f:=strconv.ParseInt(v.Used,10,64);if !originIdentifier(old.ID)||seen[old.ID]||!originCouponCount.MatchString(old.Allowed)||!originCouponCount.MatchString(old.Used)||!originCouponCount.MatchString(old.MonthlyAllowed)||!originHash.MatchString(old.InputHash)||e!=nil||f!=nil||a+delta<0||b!=a+delta||old.ID!=v.ID||old.Allowed!=v.Allowed||old.MonthlyAllowed!=v.MonthlyAllowed||delta==0&&old.InputHash!=v.InputHash{return ErrReview};seen[old.ID]=true};return nil
}
func(e *OriginEngine)verifyCoupon(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation)(*OriginCouponCapture,error){
	var coupon,amount string;if tx.QueryRowContext(ctx,`SELECT CAST(COALESCE(coupon_used,0) AS CHAR),CAST(CAST(COALESCE(coupon_amt_used,0) AS DECIMAL(12,2)) AS CHAR) FROM orders WHERE id=?`,creation.OrderID).Scan(&coupon,&amount)!=nil{return nil,ErrReview}
	if creation.CouponHash==""{var count int;if coupon!="0"||amount!="0.00"||tx.QueryRowContext(ctx,`SELECT COUNT(*) FROM pos_rewrite_screening_origin_coupons WHERE command_id=?`,c.ID).Scan(&count)!=nil||count!=0{return nil,ErrReview};return nil,nil}
	if e.CouponPolicy==nil{return nil,ErrReview};policy,err:=e.CouponPolicy(ctx,tx,c,creation);if err!=nil||policy.Contract!=OriginCouponConsumptionContract||policy.DeductionMode!="0"&&policy.DeductionMode!="1"{return nil,ErrReview}
	var v OriginCouponStaged;var raw []byte;var order,seal string
	if tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=500000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_coupons WHERE command_id=? FOR SHARE`,c.ID).Scan(&order,&raw,&seal)!=nil||seal!=creation.CouponHash||originVerify(e.Key,"coupon",raw,seal,&v,500000)!=nil{return nil,ErrReview}
	if v.Contract!="pos-screening-origin-coupon-v1"||v.SourceCommit!=OriginSourceCommit||v.CommandID!=c.ID||v.Origin!=c.Origin||v.CustomerID!=c.CustomerID||!originSame(v.ActorID,c.ActorID)||!originSame(v.StoreID,c.StoreID)||!originSame(v.CounterID,c.CounterID)||v.AuthorityHash!=c.AuthorityHash||v.RequestHash!=c.RequestHash||v.CartHash!=c.CartHash||v.NamespaceHash!=c.NamespaceHash||v.OrderID!=creation.OrderID||order!=v.OrderID||v.HeaderHash!=creation.HeaderHash||v.CreatedAt!=creation.CreatedAt||!originIdentifier(v.CouponID)||v.CouponID!=coupon||originInt(coupon)>2147483647||!originCouponAmount.MatchString(amount)||v.HeaderCouponAmount!=amount||v.CartCouponDiscount!=amount||v.CouponUsersBefore==nil||v.CouponUsersAfter==nil||len(v.CouponUsersBefore)>1000||len(v.CouponUsersAfter)>1000{return nil,ErrReview}
	for _,hash:=range []string{v.CouponInputHash,v.ConfigurationHash,v.OriginConfigurationHash}{if !originHash.MatchString(hash){return nil,ErrReview}}
	if v.HistoryRequirement=="bigquery"{if v.History==nil{return nil,ErrReview};for _,hash:=range []string{v.History.GenerationID,v.History.DocumentHash,v.History.WitnessHash}{if !originHash.MatchString(hash){return nil,ErrReview}}}else if v.HistoryRequirement!="current-controls"||v.History!=nil||v.BirthdayClaim!=nil{return nil,ErrReview}
	if v.BirthdayClaim!=nil&&(!originUUID.MatchString(v.BirthdayClaim.ID)||!originHash.MatchString(v.BirthdayClaim.KeyHash)||!originHash.MatchString(v.BirthdayClaim.ReceiptHash)||!originPoint(v.BirthdayClaim.ExpiresAt)){return nil,ErrReview}
	if v.WelcomeConsent!=nil{w:=v.WelcomeConsent;if w.Contract!="pos-screening-origin-welcome-consent-v1"||w.CustomerID!=c.CustomerID||!originHash.MatchString(w.CustomerInputHash)||w.Rows==nil||len(w.Rows)>1000{return nil,ErrReview};seen:=map[string]bool{};for _,row:=range w.Rows{if !originIdentifier(row.ID)||!originHash.MatchString(row.InputHash)||seen[row.ID]{return nil,ErrReview};seen[row.ID]=true}}
	delta:=int64(0);if v.Consumption=="source-prepaid"{if policy.DeductionMode!="0"||policy.WillConsume||!policy.WillReverse||v.SourceLog==nil{return nil,ErrReview};delta=1}else if v.Consumption!="go-confirmation"||policy.WillReverse||v.SourceLog!=nil||!policy.WillConsume&&policy.NoConsumptionReason!="exchange"&&policy.NoConsumptionReason!="hyperlocal-child"{return nil,ErrReview}
	if originCouponChanges(v.CouponUsersBefore,v.CouponUsersAfter,delta)!=nil{return nil,ErrReview};users,err:=originCouponUsers(ctx,tx,c.CustomerID,coupon);if err!=nil||!originEqual(users,v.CouponUsersAfter){return nil,ErrReview}
	var control string;if tx.QueryRowContext(ctx,`SELECT `+importCouponControlHashSQL+` FROM coupons WHERE id=? FOR SHARE`,coupon).Scan(&control)!=nil||control!=v.CouponInputHash{return nil,ErrReview}
	logs,err:=originCouponLogs(ctx,tx,c,v.OrderID,coupon);if err!=nil{return nil,err};if v.SourceLog==nil{if len(logs)!=0{return nil,ErrReview}}else if len(logs)!=1||logs[0].Status!=1||!originEqual(logs[0],*v.SourceLog){return nil,ErrReview}
	lines,err:=originCouponAllocations(ctx,tx,v.OrderID);if err!=nil||!originEqual(lines,v.Allocations)||len(lines)!=len(creation.Lines){return nil,ErrReview};for i,line:=range lines{native:=creation.Lines[i];if line.ID!=native.ID||line.ProductID!=native.ProductID||line.Quantity!=native.Quantity||line.InputHash!=native.InputHash{return nil,ErrReview}}
	return &OriginCouponCapture{v,seal,policy},nil
}
func FinishOriginCoupon(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,capture *OriginCouponCapture,key,action string)(string,error){
	if capture==nil{return "",nil};v:=capture.stage;delta:=int64(0);if action=="confirm"&&capture.policy.WillConsume{delta=1}else if action=="decline"&&capture.policy.WillReverse{delta=-1}else if action!="confirm"&&action!="decline"{return "",ErrReview}
	users,err:=originCouponUsers(ctx,tx,c.CustomerID,v.CouponID);if err!=nil||originCouponChanges(v.CouponUsersAfter,users,delta)!=nil{return "",ErrReview};lines,err:=originCouponAllocations(ctx,tx,v.OrderID);if err!=nil||!originEqual(lines,v.Allocations){return "",ErrReview}
	logs,err:=originCouponLogs(ctx,tx,c,v.OrderID,v.CouponID);if err!=nil{return "",err};var log *OriginCouponLog
	if action=="confirm"&&(capture.policy.WillConsume||v.SourceLog!=nil){if len(logs)!=1||logs[0].Status!=1{return "",ErrReview};log=&logs[0];if !capture.policy.WillConsume&&!originEqual(*log,*v.SourceLog){return "",ErrReview}}else if action=="decline"&&capture.policy.WillReverse{if len(logs)!=1||logs[0].ID!=v.SourceLog.ID||logs[0].Status!=0{return "",ErrReview};log=&logs[0]}else if len(logs)!=0{return "",ErrReview}
	proof:=map[string]interface{}{"contract":OriginCouponConsumptionContract,"commandId":c.ID,"orderId":creation.OrderID,"customerId":c.CustomerID,"creationHash":*c.CreationHash,"sourceReceiptHash":capture.seal,"couponId":v.CouponID,"headerHash":creation.HeaderHash,"action":action,"policy":capture.policy,"usersBefore":v.CouponUsersAfter,"usersAfter":users,"log":log,"allocations":lines,"sourceCommit":OriginPaymentsSourceCommit,"createdAt":time.Now().UnixMilli()}
	raw,err:=originCanonical(proof);if err!=nil{return "",err};seal,err:=OriginMAC(key,"coupon-consumption",proof);if err!=nil{return "",err};_,err=tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_coupon_consumptions(command_id,action,order_id,data,proof_hash) VALUES(?,?,?,?,?)`,c.ID,action,creation.OrderID,string(raw),seal);return seal,err
}
func verifyOriginCouponConsumption(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,hash,key,action string)error{
	var raw []byte;var seal,order string;var v map[string]interface{};err:=tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=500000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_coupon_consumptions WHERE command_id=? AND action=? FOR SHARE`,c.ID,action).Scan(&order,&raw,&seal)
	if errors.Is(err,sql.ErrNoRows){return ErrReview};if err!=nil{return err};if seal!=hash||originVerify(key,"coupon-consumption",raw,seal,&v,500000)!=nil||v["contract"]!=OriginCouponConsumptionContract||v["commandId"]!=c.ID||v["orderId"]!=creation.OrderID||order!=creation.OrderID||v["customerId"]!=c.CustomerID||v["creationHash"]!=*c.CreationHash||v["sourceReceiptHash"]!=creation.CouponHash||v["headerHash"]!=creation.HeaderHash||v["action"]!=action||v["sourceCommit"]!=OriginPaymentsSourceCommit{return ErrReview};return nil
}
