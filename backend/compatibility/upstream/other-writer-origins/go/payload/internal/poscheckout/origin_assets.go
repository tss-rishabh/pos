package poscheckout

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"strconv"
	"time"
)

// Kept verbatim with screening-origins/origin_assets.py. The complete private
// identity is hashed natively; recipients, PINs and EAV values are never logged.
const OriginLineAssetSQL = `LOWER(SHA2(CAST(JSON_OBJECT('lineId',has_products.id,'orderId',has_products.order_id,'productId',has_products.prod_id,'subProductId',has_products.sub_prod_id,'giftId',has_products.gift_voucher_id,'quantity',has_products.qty) AS CHAR CHARACTER SET utf8mb4),256))`
const OriginGiftAssetSQL = `LOWER(SHA2(CAST(JSON_OBJECT('id',gift_vouchers.id,'fromId',gift_vouchers.from_id,'toId',gift_vouchers.to_id,'code',gift_vouchers.voucher_code,'theme',gift_vouchers.theme,'toName',gift_vouchers.to_name,'toPhone',gift_vouchers.to_phone,'value',gift_vouchers.voucher_value,'initialValue',gift_vouchers.voucher_initial_value,'message',gift_vouchers.message,'status',gift_vouchers.status,'orderId',gift_vouchers.order_id,'couponId',gift_vouchers.coupon_id,'occasion',gift_vouchers.occassion_name,'occasionMessage',gift_vouchers.occassion_custom_msg,'type',gift_vouchers.gv_type,'start',gift_vouchers.start_date,'end',gift_vouchers.end_date,'collection',gift_vouchers.collection_no,'serial',gift_vouchers.gift_card_srno,'isPin',gift_vouchers.is_gcpin,'platform',gift_vouchers.platform) AS CHAR CHARACTER SET utf8mb4),256))`
const originGiftInitialSQL = `LOWER(SHA2(CAST(JSON_OBJECT('id',gift_vouchers.id,'fromId',gift_vouchers.from_id,'toId',gift_vouchers.to_id,'code',gift_vouchers.voucher_code,'theme',gift_vouchers.theme,'toName',gift_vouchers.to_name,'toPhone',gift_vouchers.to_phone,'value',gift_vouchers.voucher_value,'initialValue',gift_vouchers.voucher_initial_value,'message',gift_vouchers.message,'status',0,'orderId',gift_vouchers.order_id,'couponId',gift_vouchers.coupon_id,'occasion',gift_vouchers.occassion_name,'occasionMessage',gift_vouchers.occassion_custom_msg,'type',gift_vouchers.gv_type,'start',gift_vouchers.start_date,'end',gift_vouchers.end_date,'collection',gift_vouchers.collection_no,'serial',gift_vouchers.gift_card_srno,'isPin',gift_vouchers.is_gcpin,'platform',gift_vouchers.platform) AS CHAR CHARACTER SET utf8mb4),256))`

type OriginLineAsset struct {LineID string `json:"lineId"`;ProductID string `json:"productId"`;GiftID *string `json:"giftId"`;InputHash string `json:"inputHash"`}
type OriginGiftAsset struct {ID string `json:"id"`;FromID string `json:"fromId"`;OrderID string `json:"orderId"`;LineIDs []string `json:"lineIds"`;InputHash string `json:"inputHash"`}
type OriginOrdinaryProvenance struct {OrderID string `json:"orderId"`;Contract string `json:"contract"`;OperationID string `json:"operationId"`;ProofHash string `json:"proofHash"`}
type OriginMembershipAsset struct {
	EntityHash string `json:"entityHash"`;ProductIDs []string `json:"productIds"`;LineIDs []string `json:"lineIds"`
	BeforeRevision string `json:"beforeRevision"`;AfterRevision string `json:"afterRevision"`
	Before []MembershipState `json:"before"`;After []MembershipState `json:"after"`;Provenance *OriginOrdinaryProvenance `json:"provenance"`
}
type OriginAssets struct {
	Contract string `json:"contract"`;CommandID string `json:"commandId"`;Origin string `json:"origin"`;CustomerID string `json:"customerId"`;OrderID string `json:"orderId"`
	RequestHash string `json:"requestHash"`;CartHash string `json:"cartHash"`;HeaderHash string `json:"headerHash"`
	LineAssets []OriginLineAsset `json:"lineAssets"`;Gifts []OriginGiftAsset `json:"gifts"`;Membership *OriginMembershipAsset `json:"membership"`
	SourceCommit string `json:"sourceCommit"`;CreatedAt int64 `json:"createdAt"`
}
type OriginAssetActivation struct {assets OriginAssets;entity string;revision uint64;ordinary *membershipActivation}

func originReadLineAssets(ctx context.Context,tx *sql.Tx,order string)([]OriginLineAsset,error){
	rows,e:=tx.QueryContext(ctx,`SELECT CAST(id AS CHAR),CAST(prod_id AS CHAR),CAST(NULLIF(gift_voucher_id,0) AS CHAR),`+OriginLineAssetSQL+` FROM has_products WHERE order_id=? ORDER BY id LIMIT 1001 FOR SHARE`,order);if e!=nil{return nil,e};values:=[]OriginLineAsset{}
	for rows.Next(){var value OriginLineAsset;var gift sql.NullString;if rows.Scan(&value.LineID,&value.ProductID,&gift,&value.InputHash)!=nil{rows.Close();return nil,ErrReview};if gift.Valid{value.GiftID=&gift.String};values=append(values,value)};e=rows.Err();rows.Close();if e!=nil||len(values)<1||len(values)>1000{return nil,ErrReview};return values,nil
}
func originReadGifts(ctx context.Context,tx *sql.Tx,order string,lines []OriginLineAsset,final bool)([]OriginGiftAsset,error){
	hash:=OriginGiftAssetSQL;if final{hash=originGiftInitialSQL};rows,e:=tx.QueryContext(ctx,`SELECT CAST(id AS CHAR),CAST(from_id AS CHAR),CAST(order_id AS CHAR),`+hash+` FROM gift_vouchers WHERE order_id=? ORDER BY id LIMIT 101 FOR UPDATE`,order);if e!=nil{return nil,e};values:=[]OriginGiftAsset{}
	for rows.Next(){var value OriginGiftAsset;if rows.Scan(&value.ID,&value.FromID,&value.OrderID,&value.InputHash)!=nil{rows.Close();return nil,ErrReview};value.LineIDs=[]string{};for _,line:=range lines{if line.GiftID!=nil&&*line.GiftID==value.ID{value.LineIDs=append(value.LineIDs,line.LineID)}};values=append(values,value)};e=rows.Err();rows.Close();if e!=nil||len(values)>100{return nil,ErrReview};return values,nil
}

// Concrete consumer of the source's OWN origin asset descriptor. No copied
// Node/CSV cap, inferred staged-v2 grant or status-only voucher funding is used.
func VerifyOriginAssets(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,key string)(*OriginAssetActivation,error){
	var value OriginAssets;var raw []byte;var order,seal string
	if !originHash.MatchString(creation.AssetsHash)||tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=250000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_assets WHERE command_id=? FOR SHARE`,c.ID).Scan(&order,&raw,&seal)!=nil||seal!=creation.AssetsHash||originVerify(key,"assets",raw,seal,&value,250000)!=nil{return nil,ErrReview}
	if value.Contract!="pos-screening-origin-assets-v1"||value.CommandID!=c.ID||value.Origin!=c.Origin||value.CustomerID!=c.CustomerID||value.OrderID!=creation.OrderID||order!=value.OrderID||value.RequestHash!=c.RequestHash||value.CartHash!=c.CartHash||value.HeaderHash!=creation.HeaderHash||value.SourceCommit!=OriginSourceCommit||value.CreatedAt!=creation.CreatedAt||len(value.Gifts)>100||len(value.LineAssets)!=len(creation.Lines)||len(value.Gifts)==0&&value.Membership==nil{return nil,ErrReview}
	lines,err:=originReadLineAssets(ctx,tx,value.OrderID);if err!=nil||!originEqual(lines,value.LineAssets){return nil,ErrReview}
	for i,line:=range lines{if line.LineID!=creation.Lines[i].ID||line.ProductID!=creation.Lines[i].ProductID||!originHash.MatchString(line.InputHash){return nil,ErrReview}}
	gifts,err:=originReadGifts(ctx,tx,value.OrderID,lines,false);if err!=nil||!originEqual(gifts,value.Gifts){return nil,ErrReview}
	known:=map[string]bool{};for _,gift:=range gifts{if gift.FromID!=c.CustomerID||gift.OrderID!=creation.OrderID||!originHash.MatchString(gift.InputHash){return nil,ErrReview};known[gift.ID]=true;var status int;var kind string;if tx.QueryRowContext(ctx,`SELECT status,gv_type FROM gift_vouchers WHERE id=?`,gift.ID).Scan(&status,&kind)!=nil||status!=0||kind!="GIFT_VOUCHER"&&kind!="GIFT_CARD"||kind=="GIFT_CARD"&&len(gift.LineIDs)==0{return nil,ErrReview}}
	for _,line:=range lines{if line.GiftID!=nil&&!known[*line.GiftID]{return nil,ErrReview}}
	activation:=&OriginAssetActivation{assets:value}
	member:=value.Membership;if member==nil{return activation,nil}
	config,err:=configuredMembership();if err!=nil||config.key==key{return nil,ErrReview};var entity string
	if tx.QueryRowContext(ctx,`SELECT email FROM users WHERE id=? FOR UPDATE`,c.CustomerID).Scan(&entity)!=nil||entity==""{return nil,ErrReview};entityHash,err:=OriginMAC(key,"asset-entity",entity);if err!=nil||entityHash!=member.EntityHash{return nil,ErrReview}
	if err=nativeMembershipFence(ctx,tx,entity);err!=nil{return nil,err}
	owners,err:=tx.QueryContext(ctx,`SELECT CAST(id AS CHAR) FROM users WHERE email=? ORDER BY id LIMIT 2 FOR UPDATE`,entity);if err!=nil{return nil,err};count:=0;for owners.Next(){var id string;if owners.Scan(&id)!=nil||id!=c.CustomerID{owners.Close();return nil,ErrReview};count++};err=owners.Err();owners.Close();if err!=nil||count!=1{return nil,ErrReview}
	products:=make([]int64,0,len(config.products));for id:=range config.products{products=append(products,id)};sort.Slice(products,func(i,j int)bool{return products[i]<products[j]});expectedProducts:=[]string{};for _,id:=range products{expectedProducts=append(expectedProducts,strconv.FormatInt(id,10))};if !originEqual(member.ProductIDs,expectedProducts){return nil,ErrReview}
	expectedLines:=[]string{};for _,line:=range lines{if config.products[originInt(line.ProductID)]{expectedLines=append(expectedLines,line.LineID)}};if len(expectedLines)==0||!originEqual(expectedLines,member.LineIDs)||!coherentMemberStates(member.Before,true)||!coherentMemberStates(member.After,false){return nil,ErrReview}
	before,err:=strconv.ParseUint(member.BeforeRevision,10,64);if err!=nil||strconv.FormatUint(before,10)!=member.BeforeRevision{return nil,ErrReview};after,err:=strconv.ParseUint(member.AfterRevision,10,64);if err!=nil||strconv.FormatUint(after,10)!=member.AfterRevision||after<before{return nil,ErrReview}
	if tx.QueryRowContext(ctx,`SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=? FOR UPDATE`,c.CustomerID).Scan(&activation.revision)!=nil||activation.revision!=after{return nil,ErrReview}
	current,err:=memberStates(ctx,tx,entity);if err!=nil||!sameMemberStates(current,member.After){return nil,ErrReview};activation.entity=entity
	if member.Provenance!=nil{
		proof,err:=readMembershipProof(ctx,tx,originInt(value.OrderID));if err!=nil||member.Provenance.OrderID!=value.OrderID||member.Provenance.Contract!=proof.Contract||member.Provenance.OperationID!=proof.OperationID||member.Provenance.ProofHash!=proof.ProofHash||proof.Contract!=MembershipStagedContract||proof.CustomerID!=originInt(c.CustomerID)||proof.Revision!=after||!validMemberMAC(proof,config.key)||!sameMemberStates(proof.Confirmed,current){return nil,ErrReview}
		var header string;if tx.QueryRowContext(ctx,`SELECT `+HeaderHashSQL+` FROM orders WHERE id=?`,value.OrderID).Scan(&header)!=nil||header!=proof.HeaderHash{return nil,ErrReview}
		activation.ordinary=&membershipActivation{proof:proof,entity:entity,key:config.key}
	}
	return activation,nil
}

func FinishOriginAssets(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,activation *OriginAssetActivation,key string)(string,error){
	if activation==nil{return "",nil};value:=activation.assets
	lines,err:=originReadLineAssets(ctx,tx,value.OrderID);if err!=nil||!originEqual(lines,value.LineAssets){return "",ErrReview}
	gifts,err:=originReadGifts(ctx,tx,value.OrderID,lines,true);if err!=nil||!originEqual(gifts,value.Gifts){return "",ErrReview}
	var paid int64;if tx.QueryRowContext(ctx,`SELECT payment_status FROM orders WHERE id=?`,value.OrderID).Scan(&paid)!=nil{return "",ErrReview}
	for _,gift:=range gifts{var status int;if tx.QueryRowContext(ctx,`SELECT status FROM gift_vouchers WHERE id=?`,gift.ID).Scan(&status)!=nil||paid==4&&status!=1||paid!=4&&status!=0{return "",ErrReview}}
	var confirmed []MembershipState;var revision interface{};var ordinary interface{}
	if value.Membership!=nil{
		if activation.ordinary!=nil{if err=finishMembership(ctx,tx,activation.ordinary);err!=nil{return "",err};var proof membershipProof;proof,err=readMembershipProof(ctx,tx,originInt(value.OrderID));if err!=nil||proof.Contract!=MembershipContract{return "",ErrReview};ordinary=proof.ProofHash}
		confirmed,err=memberStates(ctx,tx,activation.entity);if err!=nil||!coherentMemberStates(confirmed,false){return "",ErrReview};for _,state:=range confirmed{if state.Active!=1{return "",ErrReview}}
		var after uint64;if tx.QueryRowContext(ctx,`SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=? FOR UPDATE`,c.CustomerID).Scan(&after)!=nil||after<activation.revision{return "",ErrReview};revision=strconv.FormatUint(after,10)
	}
	proof:=map[string]interface{}{"contract":"pos-screening-origin-asset-activation-v1","commandId":c.ID,"orderId":creation.OrderID,"customerId":c.CustomerID,"assetsHash":creation.AssetsHash,"creationHash":*c.CreationHash,"headerHash":creation.HeaderHash,"lineAssets":lines,"gifts":gifts,"funded":paid==4,"membershipBefore":func()interface{}{if value.Membership==nil{return nil};return value.Membership.Before}(),"membershipStaged":func()interface{}{if value.Membership==nil{return nil};return value.Membership.After}(),"membershipConfirmed":confirmed,"membershipSourceRevision":func()interface{}{if value.Membership==nil{return nil};return value.Membership.AfterRevision}(),"membershipConfirmedRevision":revision,"ordinaryProvenanceHash":ordinary,"sourceCommit":OriginPaymentsSourceCommit,"createdAt":time.Now().UnixMilli()}
	raw,err:=originCanonical(proof);if err!=nil{return "",err};seal,err:=OriginMAC(key,"asset-activation",proof);if err!=nil{return "",err}
	_,err=tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_asset_activations(command_id,order_id,data,proof_hash) VALUES(?,?,?,?)`,c.ID,creation.OrderID,string(raw),seal);return seal,err
}

// Preserve an independently authenticated original source descriptor when a
// consumer needs an immutable copy; never turn it into a public/CSV grant.
func OriginAssetDescriptorJSON(value OriginAssets)(json.RawMessage,error){raw,e:=originCanonical(value);return json.RawMessage(raw),e}
func verifyOriginAssetActivation(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,hash,key string)error{
	var raw []byte;var seal,order string;var value map[string]interface{}
	if tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=250000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_asset_activations WHERE command_id=? FOR SHARE`,c.ID).Scan(&order,&raw,&seal)!=nil||seal!=hash||originVerify(key,"asset-activation",raw,seal,&value,250000)!=nil||value["contract"]!="pos-screening-origin-asset-activation-v1"||value["commandId"]!=c.ID||value["orderId"]!=creation.OrderID||order!=creation.OrderID||value["customerId"]!=c.CustomerID||value["assetsHash"]!=creation.AssetsHash||value["creationHash"]!=*c.CreationHash||value["headerHash"]!=creation.HeaderHash||value["sourceCommit"]!=OriginPaymentsSourceCommit{return ErrReview};return nil
}
