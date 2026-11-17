package poscheckout

import (
	"context"
	"crypto/hmac"
	"database/sql"
	"encoding/json"
)

// Caller is constructed only by the adapter after original JWT verification
// (or the separately authenticated system entry). It is not a JSON request.
type OriginCaller struct {
	CustomerID string
	Credential string
	TwoFA bool
	StaffGrantID string
	System bool
	CSKAPIKey string
	CredentialExpiresAt int64
	AuthorityClock func()int64
}
func originNativeJSON(ctx context.Context,tx *sql.Tx,query string,args ...interface{})(map[string]interface{},error){
	var raw []byte;var value map[string]interface{};if err:=tx.QueryRowContext(ctx,query,args...).Scan(&raw);err!=nil{return value,err};if OriginDecode(raw,&value,16000)!=nil{return value,ErrReview};return value,nil
}
func originSignedMap(ctx context.Context,tx *sql.Tx,query,key,purpose string,args ...interface{})(map[string]interface{},error){
	var raw []byte;var seal string;value:=map[string]interface{}{};if err:=tx.QueryRowContext(ctx,query,args...).Scan(&raw,&seal);err!=nil{return value,err};if originVerify(key,purpose,raw,seal,&value,16000)!=nil{return value,ErrReview};return value,nil
}
func originNumber(value interface{},expected int64)bool{v,ok:=value.(json.Number);if !ok{return false};n,e:=v.Int64();return e==nil&&n==expected}
func originInteger(value interface{})(int64,error){v,ok:=value.(json.Number);if !ok{return 0,ErrReview};n,e:=v.Int64();return n,e}
func originString(value interface{})string{s,_:=value.(string);return s}
func originBool(value interface{})bool{return value==true||originNumber(value,1)}

// Run before any Order/HP lock or financial mutation: actor -> Store -> current
// assignment/counter -> customer. Command equality is checked afterward.
func OriginAuthorize(ctx context.Context,tx *sql.Tx,hint OriginCommand,caller OriginCaller,key string,now int64)(map[string]interface{},error){
	if caller.CustomerID!=hint.CustomerID{return nil,ErrReview}
	var grant map[string]interface{}
	var actorHash string
	if hint.ActorID!=nil{
		if caller.System||!originUUID.MatchString(caller.StaffGrantID){return nil,ErrReview}
		actor,e:=originNativeJSON(ctx,tx,`SELECT JSON_OBJECT('id',id,'password',password,'role',role,'user_type',user_type,'is_active',is_active) FROM pos_user WHERE id=? FOR SHARE`,*hint.ActorID);if e!=nil{return nil,e}
		role,e:=originInteger(actor["role"]);if e!=nil{return nil,ErrReview};kind,e:=originInteger(actor["user_type"]);if e!=nil{return nil,ErrReview}
		if !originNumber(actor["is_active"],1)||role<1||role>5||(kind!=1&&kind!=2){return nil,ErrReview}
		var epoch string;epochErr:=tx.QueryRowContext(ctx,`SELECT CAST(epoch AS CHAR) FROM pos_rewrite_operator_auth_epochs WHERE operator_id=? FOR SHARE`,*hint.ActorID).Scan(&epoch);if epochErr==sql.ErrNoRows{epoch="0"}else if epochErr!=nil{return nil,epochErr};actor["authEpoch"]=epoch
		actorHash,e=OriginMAC(key,"staff-identity",actor);if e!=nil{return nil,e}
		var active int64;var category,storeType string
		if hint.StoreID==nil||hint.CounterID==nil||tx.QueryRowContext(ctx,`SELECT is_active,category,type FROM stores WHERE id=? FOR UPDATE`,*hint.StoreID).Scan(&active,&category,&storeType)!=nil||active!=1||(storeType!="STORE"&&storeType!="CORE_WAREHOUSE")||kind==2&&category!="FRANCHISE"{return nil,ErrReview}
		if role!=1||kind!=1{var id string;if tx.QueryRowContext(ctx,`SELECT CAST(id AS CHAR) FROM user_stores WHERE django_user_id=? AND store_id=? ORDER BY id LIMIT 1 FOR SHARE`,*hint.ActorID,*hint.StoreID).Scan(&id)!=nil{return nil,ErrReview}}
		var counter string;if tx.QueryRowContext(ctx,`SELECT CAST(id AS CHAR) FROM store_counters WHERE id=? AND store_id=? AND is_active=1 FOR SHARE`,*hint.CounterID,*hint.StoreID).Scan(&counter)!=nil{return nil,ErrReview}
		var revoked int64;var raw []byte;var seal string
		if tx.QueryRowContext(ctx,`SELECT CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash,revoked FROM pos_rewrite_screening_origin_staff_grants WHERE id=? AND actor_id=?`,caller.StaffGrantID,*hint.ActorID).Scan(&raw,&seal,&revoked)!=nil||revoked!=0||originVerify(key,"staff-grant",raw,seal,&grant,16000)!=nil{return nil,ErrReview}
		issued,_:=grant["issuedAt"].(json.Number);expires,_:=grant["expiresAt"].(json.Number);at,ea:=issued.Int64();until,eb:=expires.Int64()
		if grant["contract"]!="pos-screening-origin-staff-grant-v1"||grant["id"]!=caller.StaffGrantID||grant["origin"]!=hint.Origin||grant["actorId"]!=*hint.ActorID||grant["customerId"]!=hint.CustomerID||grant["storeId"]!=*hint.StoreID||grant["counterId"]!=*hint.CounterID||grant["identityHash"]!=actorHash||ea!=nil||eb!=nil||at>now||until<=now||until>at+60000{return nil,ErrReview}
		if err:=originStaffSession(ctx,tx,grant,actorHash,key,now);err!=nil{return nil,err}
		var current []byte;var currentSeal string
		if tx.QueryRowContext(ctx,`SELECT data,proof_hash,revoked FROM pos_rewrite_screening_origin_staff_grants WHERE id=? FOR UPDATE`,caller.StaffGrantID).Scan(&current,&currentSeal,&revoked)!=nil||revoked!=0||currentSeal!=seal||!hmac.Equal(current,raw){return nil,ErrReview}
	}else if hint.Origin=="external-system"{
		if !caller.System||caller.Credential!=""{return nil,ErrReview};if e:=originSystem(ctx,tx,hint,key,caller.CSKAPIKey);e!=nil{return nil,e}
	}else if caller.System||hint.Origin!="customer"{return nil,ErrReview}
	identity,e:=originNativeJSON(ctx,tx,`SELECT JSON_OBJECT('id',id,'status',status,'isBlock',is_block,'isDisabled',is_disabled,'isTwoFa',is_two_fa,'email',email,'telephone',telephone) FROM users WHERE id=? FOR UPDATE`,hint.CustomerID);if e!=nil{return nil,e}
	if !originNumber(identity["status"],1)||identity["isBlock"]!=nil&&!originNumber(identity["isBlock"],0)||identity["isDisabled"]!=nil&&!originNumber(identity["isDisabled"],0){return nil,ErrReview}
	if hint.Origin=="external-system"{return identity,nil}
	if caller.AuthorityClock!=nil{now=caller.AuthorityClock()}
	if caller.Credential==""||len(caller.Credential)>16000||caller.CredentialExpiresAt<=now||caller.TwoFA!=originBool(identity["isTwoFa"]){return nil,ErrReview}
	credential,e:=OriginMAC(key,"customer-credential",caller.Credential);if e!=nil{return nil,e};nativeHash,e:=OriginMAC(key,"customer-identity",identity);if e!=nil{return nil,e}
	principal:=map[string]interface{}{"origin":hint.Origin,"customerId":hint.CustomerID,"actorId":hint.ActorID,"storeId":hint.StoreID,"counterId":hint.CounterID,"credentialHash":credential,"identityHash":nativeHash}
	if grant!=nil{expiry,err:=originInteger(grant["expiresAt"]);if err!=nil||expiry<=now||grant["credentialHash"]!=credential{return nil,ErrReview};if err=originStaffSession(ctx,tx,grant,actorHash,key,now);err!=nil{return nil,err};principal["sessionHash"]=grant["sessionHash"];principal["staffIdentityHash"]=actorHash;principal["grantId"]=caller.StaffGrantID}
	authority,e:=OriginMAC(key,"authority",principal);if e!=nil||!hmac.Equal([]byte(authority),[]byte(hint.AuthorityHash)){return nil,ErrReview};return identity,nil
}

// Signed source session is distinct from the one-minute grant. Its exact
// original session hash and actor binding must still be current and unrevoked.
func originStaffSession(ctx context.Context,tx *sql.Tx,grant map[string]interface{},identity,key string,now int64)error{
	hash:=originString(grant["sessionHash"]);if !originHash.MatchString(hash){return ErrReview}
	var id,kind,actor,nativeHash,seal string;var raw []byte;var revoked int64
	if tx.QueryRowContext(ctx,`SELECT id,origin,CAST(actor_id AS CHAR),session_hash,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash,revoked FROM pos_rewrite_screening_origin_sessions WHERE session_hash=? AND actor_id=? FOR SHARE`,hash,grant["actorId"]).Scan(&id,&kind,&actor,&nativeHash,&raw,&seal,&revoked)!=nil{return ErrReview}
	purpose,contract:="legacy-session","pos-screening-legacy-session-v1";if kind=="mpos"{purpose,contract="mpos-session","pos-screening-mpos-session-v1"}
	var value map[string]interface{};if originVerify(key,purpose,raw,seal,&value,16000)!=nil||len(value)!=8||revoked!=0||kind!=grant["origin"]||actor!=grant["actorId"]||nativeHash!=hash||value["contract"]!=contract||value["id"]!=id||value["origin"]!=kind||value["actorId"]!=actor||value["identityHash"]!=identity||value["sessionHash"]!=hash{return ErrReview}
	issued,ea:=originInteger(value["issuedAt"]);until,eb:=originInteger(value["expiresAt"]);if ea!=nil||eb!=nil||issued>now||until<=now||until>issued+3600000{return ErrReview};return nil
}

func originSystem(ctx context.Context,tx *sql.Tx,c OriginCommand,key,credential string)error{
	if credential==""||len(credential)>4096{return ErrReview}
	var raw []byte;var seal string;var revoked int64;var service map[string]interface{}
	if tx.QueryRowContext(ctx,`SELECT CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash,revoked FROM pos_rewrite_screening_origin_services WHERE id='csk' FOR SHARE`).Scan(&raw,&seal,&revoked)!=nil||revoked!=0||originVerify(key,"system-service",raw,seal,&service,16000)!=nil{return ErrReview}
	hash,e:=OriginMAC(key,"system-credential",credential);if e!=nil||service["contract"]!="pos-screening-origin-system-service-v1"||service["id"]!="csk"||service["active"]!=true||service["sourceController"]!="controllers.external.OrderPlacement"||service["credentialHash"]!=hash{return ErrReview}
	var authority map[string]interface{};if tx.QueryRowContext(ctx,`SELECT CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_system_authorities WHERE command_id=? FOR SHARE`,c.ID).Scan(&raw,&seal)!=nil||originVerify(key,"system-authority",raw,seal,&authority,16000)!=nil{return ErrReview}
	if authority["contract"]!="pos-screening-origin-system-authority-v1"||authority["commandId"]!=c.ID||authority["customerId"]!=c.CustomerID||authority["requestHash"]!=c.RequestHash||authority["referenceHash"]!=c.ReferenceHash||authority["serviceId"]!="csk"||authority["serviceRevision"]!=service["revision"]||authority["credentialHash"]!=hash||authority["configurationHash"]!=service["configurationHash"]{return ErrReview};return nil
}
