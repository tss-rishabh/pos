// Optional private-import authority delegation. Never changes original scope,
// request hash, namespace, order, source receipts or consumed-benefit identity.
package poscheckout

import (
 "bytes"
 "context"
 "crypto/hmac"
 "crypto/sha256"
 "encoding/hex"
 "database/sql"
 "encoding/json"
 "os"
 "time"
)
const ImportAuthoritySuccessionContract = "pos-import-authority-succession-v1"
type importSuccessionReference struct { ID string `json:"id"`; Sequence int64 `json:"sequence"`; Hash string `json:"hash"` }
type importSuccessionEnvelope struct {
 Data struct {
  Contract string `json:"contract"`; ID string `json:"id"`; Sequence int64 `json:"sequence"`
  ManagerID string `json:"managerId"`; OriginalScope importScope `json:"originalScope"`
  SessionDigest string `json:"sessionDigest"`; RequestHash string `json:"requestHash"`; PlanHash string `json:"planHash"`; Namespace string `json:"namespace"`
  OriginalAuthorityHash string `json:"originalAuthorityHash"`; OrderID string `json:"orderId"`
  SourceReceiptHash string `json:"sourceReceiptHash"`; BusinessDate string `json:"businessDate"`; Authority importAuthority `json:"authority"`
  IssuedAt int64 `json:"issuedAt"`; ExpiresAt int64 `json:"expiresAt"`
 } `json:"data"`
 SourceHash string `json:"sourceHash"`
}
func importEqualJSON(first,second interface{}) bool {a,e:=json.Marshal(first);b,f:=json.Marshal(second);return e==nil&&f==nil&&bytes.Equal(a,b)}
func validateImportSuccessionCapability(c *importCapability,key string,now time.Time) error {
 if c.Succession==nil{return nil}
 if os.Getenv("POS_LEGACY_IMPORT_AUTHORITY_SUCCESSION_CONTRACT")!=ImportAuthoritySuccessionContract{return ErrReview}
 raw,ok:=c.raw["succession"].(map[string]interface{});if !ok||len(raw)!=2{return ErrReview}
 data,ok:=raw["data"].(map[string]interface{});if !ok||len(data)!=24{return ErrReview}
 allowed:=[]string{"contract","id","sequence","previous","originalScope","requestHash","planHash","namespace","originalAuthorityHash","orderId","sourceReceiptHash","headerHash","lineHash","evidenceHash","managerId","requestId","sessionHash","sessionDigest","authority","businessDate","reason","reviewedAt","issuedAt","expiresAt"}
 for _,name:=range allowed{if _,exists:=data[name];!exists{return ErrReview}}
 g:=c.Succession.Data
 if g.Contract!=ImportAuthoritySuccessionContract||!importUUID.MatchString(g.ID)||g.Sequence<1||g.Sequence>100||!consentIdentifier(g.ManagerID)||g.OrderID!=c.OrderID||g.RequestHash!=c.RequestHash||g.PlanHash!=c.PlanHash||g.Namespace!=c.Namespace||g.OriginalScope!=c.Scope||g.Authority.CustomerID!=c.Authority.CustomerID||!validContact(g.Authority.Contact)||g.IssuedAt>now.UnixMilli()||g.ExpiresAt<=now.UnixMilli()||g.ExpiresAt!=g.IssuedAt+3600000||c.ExpiresAt>g.ExpiresAt{return ErrReview}
 expected,err:=importMAC(key,"legacy-order-imports.source.authority-succession.v1",data);if err!=nil||!hmac.Equal([]byte(expected),[]byte(c.Succession.SourceHash)){return ErrReview}
 original,err:=importMAC(key,"legacy-order-imports.source.succession-original-authority.v1",c.raw["authority"]);if err!=nil||original!=g.OriginalAuthorityHash{return ErrReview}
 return nil
}
func effectiveLegacyImport(c *importCapability)*importCapability {
 if c==nil||c.Succession==nil{return c};value:=*c;value.Scope.ActorID=c.Succession.Data.ManagerID;value.Authority=c.Succession.Data.Authority;return &value
}
func legacyImportActorHint(c *importCapability,original string) string {
 if c!=nil&&c.Succession!=nil{return c.Succession.Data.ManagerID};return original
}
func verifyLegacyImportSuccession(ctx context.Context,tx *sql.Tx,c *importCapability) error {
 if c==nil{return ErrReview}
 var grantID,sourceHash string;var sequence int64;var active sql.NullString
 err:=tx.QueryRowContext(ctx,`SELECT grant_id,sequence_no,source_hash,active_command_id FROM pos_rewrite_import_authority_heads WHERE operation_id=? FOR SHARE`,c.OperationID).Scan(&grantID,&sequence,&sourceHash,&active)
 if err==sql.ErrNoRows{if c.Succession!=nil{return ErrReview};return nil};if err!=nil{return err}
 if c.Succession==nil||!active.Valid||grantID!=c.Succession.Data.ID||sequence!=c.Succession.Data.Sequence||sourceHash!=c.Succession.SourceHash{return ErrReview}
 if err=validateImportSuccessionCapability(c,c.authKey,time.Now());err!=nil{return err}
 var body []byte;var manager,operation,managerSession string;var nativeSequence int64
 if err=tx.QueryRowContext(ctx,`SELECT data,manager_id,manager_session_id,sequence_no,operation_id FROM pos_rewrite_import_authority_successions WHERE id=? AND OCTET_LENGTH(data)<=16000 FOR SHARE`,grantID).Scan(&body,&manager,&managerSession,&nativeSequence,&operation);err!=nil{return err}
 var native map[string]interface{};decoder:=json.NewDecoder(bytes.NewReader(body));decoder.UseNumber();if decoder.Decode(&native)!=nil||!importEqualJSON(native,c.raw["succession"])||manager!=c.Succession.Data.ManagerID||nativeSequence!=sequence||operation!=c.OperationID{return ErrReview}
 digest:=sha256.Sum256([]byte(managerSession));if hex.EncodeToString(digest[:])!=c.Succession.Data.SessionDigest{return ErrReview}
 var sessionID string
 if err=tx.QueryRowContext(ctx,`SELECT id FROM pos_rewrite_sessions WHERE id=? AND user_id=? AND auth_version=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3) FOR SHARE`,managerSession,c.Succession.Data.ManagerID,c.Succession.Data.Authority.ActorVersion).Scan(&sessionID);err!=nil{return err}
 var claimBody []byte;var claimHash string
 if err=tx.QueryRowContext(ctx,`SELECT data,source_hash FROM pos_rewrite_import_authority_stage_claims WHERE operation_id=? AND stage='confirmation' AND grant_id=? FOR SHARE`,c.OperationID,grantID).Scan(&claimBody,&claimHash);err!=nil{return err}
 var claim map[string]interface{};decoder=json.NewDecoder(bytes.NewReader(claimBody));decoder.UseNumber();if decoder.Decode(&claim)!=nil||len(claim)!=8||claim["contract"]!=ImportAuthoritySuccessionContract||claim["operationId"]!=c.OperationID||claim["stage"]!="confirmation"||claim["nonce"]!=c.Nonce||claim["commandId"]!=active.String||!importEqualJSON(claim["grant"],map[string]interface{}{"id":grantID,"sequence":sequence,"hash":sourceHash}){return ErrReview}
 expected,err:=importMAC(c.authKey,"legacy-order-imports.source.succession-stage.v1",claim);if err!=nil||!hmac.Equal([]byte(expected),[]byte(claimHash)){return ErrReview}
 var receiptHash,stageRequest string
 if err=tx.QueryRowContext(ctx,`SELECT proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='order' AND status='completed' FOR SHARE`,c.OperationID).Scan(&receiptHash);err!=nil{return err}
 if receiptHash!=c.Succession.Data.SourceReceiptHash{return ErrReview}
 if err=tx.QueryRowContext(ctx,`SELECT request_hash FROM pos_rewrite_import_financial_stages WHERE operation_id=? AND kind='confirmation' FOR SHARE`,c.OperationID).Scan(&stageRequest);err!=nil{return err}
 if claim["stageRequestHash"]!=stageRequest{return ErrReview}
 var closeID,closeStatus string;var closeVersion int64
 closeErr:=tx.QueryRowContext(ctx,`SELECT CAST(id AS CHAR),version,status FROM store_day_close WHERE store_id=? AND close_date=? ORDER BY version DESC LIMIT 1 FOR UPDATE`,c.Scope.StoreID,c.Succession.Data.BusinessDate).Scan(&closeID,&closeVersion,&closeStatus)
 var currentClose interface{}
 if closeErr!=nil&&closeErr!=sql.ErrNoRows{return closeErr};if closeErr==nil{currentClose=map[string]interface{}{"id":closeID,"version":closeVersion,"status":closeStatus}}
 raw,_:=c.raw["succession"].(map[string]interface{});data,_:=raw["data"].(map[string]interface{});authority,_:=data["authority"].(map[string]interface{})
 if !importEqualJSON(currentClose,authority["close"]){return ErrReview}
 return nil
}
