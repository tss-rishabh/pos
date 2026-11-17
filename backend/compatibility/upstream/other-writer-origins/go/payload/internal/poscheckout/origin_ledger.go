package poscheckout

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
)

// Identical to source native.py HEADER/LINE. Values, including native FLOATs,
// are hashed by MySQL, never reconstructed through Go financial arithmetic.
const OriginHeaderSQL = `LOWER(SHA2(CAST(JSON_OBJECT('financial_header_hash',`+HeaderHashSQL+`,'created_at',DATE_FORMAT(orders.created_at,'%Y-%m-%d %H:%i:%s'),'currency',orders.currency,'currency_conv_rate',orders.currency_conv_rate,'shipping_amt',orders.shipping_amt,'order_amt',orders.order_amt,'fraction_value',orders.fraction_value,'first_name',orders.first_name,'last_name',orders.last_name,'address1',orders.address1,'address2',orders.address2,'address3',orders.address3,'phone_no',orders.phone_no,'country_id',orders.country_id,'zone_id',orders.zone_id,'postal_code',orders.postal_code,'city',orders.city) AS CHAR CHARACTER SET utf8mb4),256))`
const OriginLineSQL = `LOWER(SHA2(CAST(JSON_OBJECT('id',has_products.id,'product_id',has_products.prod_id,'sub_product_id',has_products.sub_prod_id,'quantity',has_products.qty,'price',has_products.price,'gst',has_products.gst,'pre_gst_amt',has_products.pre_gst_amt,'disc',has_products.disc,'wallet_disc',has_products.wallet_disc,'voucher_disc',has_products.voucher_disc,'points',has_products.hp_tss_points_used,'refundable',has_products.amount_to_be_refunded,'fraction_value',has_products.fraction_value) AS CHAR CHARACTER SET utf8mb4),256))`
const OriginAllocationSQL = `LOWER(SHA2(CAST(JSON_OBJECT('parentOrderId',orders.parent_order_id,'originalOrderId',orders.original_order_id,'hlParentOrderId',orders.hl_parent_order_id,'locationId',orders.location_id,'locationType',orders.location_type,'isExpress',orders.is_express,'flagId',orders.flag_id,'isNewCalc',orders.is_new_calc) AS CHAR CHARACTER SET utf8mb4),256))`

func ReadOriginCommand(ctx context.Context,tx *sql.Tx,id,customer,key string,lock bool)(OriginCommand,error){
	var value OriginCommand;var raw []byte;var seal,physicalID,origin,nativeCustomer,phase string;var order,actor,store,counter sql.NullString
	// Hints must not hold a command lock before actor/Store/customer. Under
	// the shared customer lock current RC reads are serialized by every writer.
	suffix:="";if lock{suffix=" FOR UPDATE"}
	err:=tx.QueryRowContext(ctx,`SELECT id,origin,CAST(customer_id AS CHAR),CAST(actor_id AS CHAR),CAST(store_id AS CHAR),CAST(counter_id AS CHAR),phase,CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_commands WHERE id=? AND customer_id=?`+suffix,id,customer).Scan(&physicalID,&origin,&nativeCustomer,&actor,&store,&counter,&phase,&order,&raw,&seal)
	if err!=nil{return value,err};if originVerify(key,"command",raw,seal,&value,16000)!=nil||value.validate()!=nil||physicalID!=value.ID||nativeCustomer!=value.CustomerID||origin!=value.Origin||phase!=value.Phase||!originNullEquals(order,value.OrderID)||!originNullEquals(actor,value.ActorID)||!originNullEquals(store,value.StoreID)||!originNullEquals(counter,value.CounterID){return value,ErrReview};return value,nil
}
func originNullEquals(a sql.NullString,b *string)bool{return !a.Valid&&b==nil||a.Valid&&b!=nil&&a.String==*b}
func ReadOriginCreation(ctx context.Context,tx *sql.Tx,c OriginCommand,key string)(OriginCreation,error){
	var value OriginCreation;var raw []byte;var seal,order string
	if c.CreationHash==nil||c.OrderID==nil{return value,ErrReview}
	if err:=tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=256000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_creations WHERE command_id=? FOR SHARE`,c.ID).Scan(&order,&raw,&seal);err!=nil{return value,err}
	if seal!=*c.CreationHash||order!=*c.OrderID||originVerify(key,"creation",raw,seal,&value,256000)!=nil||value.validate(c)!=nil{return value,ErrReview};return value,nil
}
func originNative(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,initial bool)error{
	if c.OrderID==nil{return ErrReview};var user,header string;var method,status,paid int64
	var allocation string
	if tx.QueryRowContext(ctx,`SELECT CAST(user_id AS CHAR),payment_method,order_status,payment_status,`+OriginHeaderSQL+`,`+OriginAllocationSQL+` FROM orders WHERE id=? FOR UPDATE`,*c.OrderID).Scan(&user,&method,&status,&paid,&header,&allocation)!=nil||user!=c.CustomerID||method!=creation.Method||header!=creation.HeaderHash||allocation!=creation.AllocationHash{return ErrReview}
	if initial&&status!=0&&status!=17{return ErrReview}
	rows,e:=tx.QueryContext(ctx,`SELECT CAST(id AS CHAR),CAST(prod_id AS CHAR),qty,`+OriginLineSQL+` FROM has_products WHERE order_id=? ORDER BY id LIMIT 1001 FOR UPDATE`,*c.OrderID);if e!=nil{return e};var lines []OriginLine
	for rows.Next(){var l OriginLine;if rows.Scan(&l.ID,&l.ProductID,&l.Quantity,&l.InputHash)!=nil{rows.Close();return ErrReview};lines=append(lines,l)};e=rows.Err();rows.Close();if e!=nil||!originEqual(lines,creation.Lines){return ErrReview}
	if c.StoreID!=nil{var store,counter string;rows,e=tx.QueryContext(ctx,`SELECT CAST(store_id AS CHAR),CAST(counter_id AS CHAR) FROM order_stores WHERE order_id=? FOR UPDATE`,*c.OrderID);if e!=nil{return e};if !rows.Next()||rows.Scan(&store,&counter)!=nil||store!=*c.StoreID||counter!=*c.CounterID||rows.Next(){rows.Close();return ErrReview};e=rows.Err();rows.Close();if e!=nil{return e}}else{var n int;if tx.QueryRowContext(ctx,`SELECT COUNT(*) FROM order_stores WHERE order_id=? AND store_id<>0`,*c.OrderID).Scan(&n)!=nil||n!=0{return ErrReview}}
	return originMarkers(ctx,tx,c)
}
func originMarkers(ctx context.Context,tx *sql.Tx,c OriginCommand)error{
	if c.OrderID==nil{return ErrReview};rows,e:=tx.QueryContext(ctx,`SELECT CAST(id AS CHAR),CAST(has_product_id AS CHAR),CAST(user_id AS CHAR) FROM spiderman_screening_orders FORCE INDEX(idx_order_id) WHERE order_id=? ORDER BY id LIMIT 3 FOR SHARE`,*c.OrderID);if e!=nil{return e};var markers []OriginMarker
	for rows.Next(){var m OriginMarker;var customer string;if rows.Scan(&m.ID,&m.LineID,&customer)!=nil||customer!=c.CustomerID{rows.Close();return ErrReview};markers=append(markers,m)};e=rows.Err();rows.Close();if e!=nil||!originEqual(markers,c.Markers){return ErrReview};return nil
}

// Called under the shared customer lock by ALL screening writers. Only the
// qualified current projection is read; this is not an old Order history scan.
// Root composes this credit into the existing CSV/public confirmation loop.
func PendingOriginScreeningCredit(ctx context.Context,tx *sql.Tx,customer,key string,except string)(uint64,error){
	if !originIdentifier(customer)||!originKey.MatchString(key){return 0,ErrReview}
	rows,e:=tx.QueryContext(ctx,`SELECT id FROM pos_rewrite_screening_origin_commands FORCE INDEX(ix_screening_origin_customer) WHERE customer_id=? ORDER BY id LIMIT 1001`,customer);if e!=nil{return 0,e};var ids []string
	for rows.Next(){var id string;if rows.Scan(&id)!=nil{rows.Close();return 0,ErrReview};ids=append(ids,id)};e=rows.Err();rows.Close();if e!=nil||len(ids)>1000{return 0,ErrReview}
	var total uint64;for _,id:=range ids{c,e:=ReadOriginCommand(ctx,tx,id,customer,key,false);if e!=nil{return 0,e};if id==except{continue};switch c.Phase{case "RESERVED":total+=uint64(c.MarkerRows);case "BOUND","COUNTED":
		creation,e:=ReadOriginCreation(ctx,tx,c,key);if e!=nil{return 0,e};if originMarkers(ctx,tx,c)!=nil{return 0,ErrReview};var included bool
		if tx.QueryRowContext(ctx,`SELECT order_status IS NOT NULL AND order_status NOT IN(0,17) FROM orders WHERE id=? AND user_id=? FOR SHARE`,*c.OrderID,customer).Scan(&included)!=nil{return 0,ErrReview}
		if c.Phase=="COUNTED"{if !included{return 0,ErrReview};if _,e=ReadOriginPayment(ctx,tx,c,creation,key);e!=nil{return 0,e}}else if !included{failed,e:=OriginDefiniteFailure(ctx,tx,c,creation,key);if e!=nil{return 0,e};if !failed{total+=uint64(c.MarkerRows)}}
	case "REJECTED":var raw []byte;var seal string;var proof map[string]interface{};if tx.QueryRowContext(ctx,`SELECT CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_closures WHERE command_id=? FOR SHARE`,id).Scan(&raw,&seal)!=nil||c.ClosureHash==nil||seal!=*c.ClosureHash||originVerify(key,"closure",raw,seal,&proof,16000)!=nil||proof["commandId"]!=id||proof["customerId"]!=customer||proof["noFinancialEffects"]!=true{return 0,ErrReview}
	};if total>2{return 0,ErrReview}};return total,nil
}

type OriginCounterEntry struct{prelude *importConfirmationPrelude;before uint64}
func enterOriginCounter(ctx context.Context,tx *sql.Tx,c OriginCommand)(*OriginCounterEntry,error){
	if c.OrderID==nil{return nil,ErrReview};user,e:=strconv.ParseInt(c.CustomerID,10,64);if e!=nil{return nil,e};order,e:=strconv.ParseInt(*c.OrderID,10,64);if e!=nil{return nil,e}
	p:=&importConfirmationPrelude{ticket:true,customerLocked:true,user:user};entry:=&OriginCounterEntry{prelude:p}
	if e=enterScreeningCounter(ctx,tx,p,order);e!=nil{return entry,e};entry.before,e=readCurrentScreeningCount(ctx,tx,user);return entry,e
}
func (e *OriginCounterEntry) release(ctx context.Context,tx *sql.Tx)error{if e==nil{return nil};return releaseScreeningCounter(ctx,tx,e.prelude)}
func (e *OriginCounterEntry) final(ctx context.Context,tx *sql.Tx,c OriginCommand,includedBefore bool,confirmed bool)error{
	if e==nil{return ErrReview};after,err:=readCurrentScreeningCount(ctx,tx,e.prelude.user);expected:=e.before;if confirmed&&!includedBefore{expected+=uint64(c.MarkerRows)};if err!=nil||after!=expected||after>2{return ErrReview};return nil
}

type OriginNativeEvidence struct{
	HeaderHash string `json:"headerHash"`; LinesHash string `json:"linesHash"`; WalletHash string `json:"walletHash"`; StockHash string `json:"stockHash"`; GrantHash string `json:"grantHash"`
	OrderStatus int64 `json:"orderStatus"`; PaymentStatus int64 `json:"paymentStatus"`
}
// The selected transaction has locked the customer and every original HP.
// Each projection is bounded and hashes only verified physical columns.
func OriginEvidence(ctx context.Context,tx *sql.Tx,c OriginCommand,key string)(OriginNativeEvidence,error){
	var v OriginNativeEvidence;if c.OrderID==nil{return v,ErrReview};order:=*c.OrderID
	if tx.QueryRowContext(ctx,`SELECT `+OriginHeaderSQL+`,order_status,payment_status FROM orders WHERE id=?`,order).Scan(&v.HeaderHash,&v.OrderStatus,&v.PaymentStatus)!=nil{return v,ErrReview}
	queries:=[]struct{name,query string;args []interface{};target *string}{
		{"lines",`SELECT CAST(id AS CHAR),`+OriginLineSQL+` FROM has_products WHERE order_id=? ORDER BY id LIMIT 1001`,[]interface{}{order},&v.LinesHash},
		{"wallet",`SELECT 'user',LOWER(SHA2(CAST(JSON_OBJECT('money',tss_money,'points',tss_points,'cashback',cashback) AS CHAR),256)) FROM users WHERE id=? UNION ALL SELECT CONCAT('money:',id),LOWER(SHA2(CAST(JSON_OBJECT('amount',added_amt,'before',amt_before,'after',amt_after,'used',used_amt,'platform',platform) AS CHAR),256)) FROM tss_money_history WHERE order_id=? UNION ALL SELECT CONCAT('points:',id),LOWER(SHA2(CAST(JSON_OBJECT('amount',added_amt,'before',amt_before,'after',amt_after,'used',used_amt,'platform',platform) AS CHAR),256)) FROM tss_point_history WHERE order_id=? LIMIT 2001`,[]interface{}{c.CustomerID,order,order},&v.WalletHash},
		{"stock",`SELECT CONCAT('online:',ps.prod_id),LOWER(SHA2(CAST(JSON_OBJECT('product',ps.prod_id,'stock',ps.stock) AS CHAR),256)) FROM product_stocks ps WHERE ps.prod_id IN(SELECT prod_id FROM has_products WHERE order_id=?) UNION ALL SELECT CONCAT('store:',ps.id),LOWER(SHA2(CAST(JSON_OBJECT('product',ps.product_id,'store',ps.store_id,'stock',ps.stock) AS CHAR),256)) FROM product_store ps JOIN order_stores os ON os.store_id=ps.store_id WHERE os.order_id=? AND ps.product_id IN(SELECT prod_id FROM has_products WHERE order_id=?) LIMIT 2001`,[]interface{}{order,order,order},&v.StockHash},
		{"grants",`SELECT CONCAT('gv:',id),LOWER(SHA2(CAST(JSON_OBJECT('value',voucher_value,'initial',voucher_initial_value,'status',status,'type',gv_type,'order',order_id) AS CHAR),256)) FROM gift_vouchers WHERE order_id=? UNION ALL SELECT CONCAT('eav:',e.id),LOWER(SHA2(CAST(JSON_OBJECT('attribute',e.attribute,'value',e.value,'active',e.is_active,'updated',e.updated_at) AS CHAR),256)) FROM user_eav e JOIN users u ON u.email=e.entity WHERE u.id=? AND e.attribute IN('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') LIMIT 2001`,[]interface{}{order,c.CustomerID},&v.GrantHash},
	}
	for _,q:=range queries{rows,err:=tx.QueryContext(ctx,q.query,q.args...);if err!=nil{return v,err};pairs:=map[string]string{};for rows.Next(){var id,hash string;if rows.Scan(&id,&hash)!=nil||!originHash.MatchString(hash)||pairs[id]!=""{rows.Close();return v,ErrReview};pairs[id]=hash};err=rows.Err();rows.Close();if err!=nil||len(pairs)>2000{return v,ErrReview};*q.target,err=OriginMAC(key,"native-"+q.name,pairs);if err!=nil{return v,err}}
	return v,nil
}
func originPersist(ctx context.Context,tx *sql.Tx,table,id,key,purpose string,value interface{})error{
	// Table/column identities are static switch cases, never client strings.
	query:="";switch table{case "payment":query=`INSERT INTO pos_rewrite_screening_origin_payments(order_id,command_id,data,proof_hash) VALUES(?,?,?,?)`;default:return ErrReview}
	raw,e:=originCanonical(value);if e!=nil{return e};seal,e:=OriginMAC(key,purpose,value);if e!=nil{return e};var data struct{OrderID string `json:"orderId"`};if json.Unmarshal(raw,&data)!=nil{return ErrReview};_,e=tx.ExecContext(ctx,query,data.OrderID,id,string(raw),seal);return e
}
func originNoRows(err error)bool{return err==sql.ErrNoRows}
func originInt(id string)int64{n,_:=strconv.ParseInt(id,10,64);return n}
func originFail(format string)error{return fmt.Errorf("origin payment %s",format)}
