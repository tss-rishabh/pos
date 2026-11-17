package poscheckout

import (
 "bytes"
 "context"
 "crypto/hmac"
 "crypto/sha256"
 "database/sql"
 "encoding/hex"
 "encoding/json"
 "io"
 "os"
 "strconv"
 "strings"
 "time"
)

const LegacyMembershipStagedReferenceContract = "pos-csv-membership-staged-reference-v1"
const LegacyMembershipReferenceActivationContract = "pos-csv-membership-reference-activation-v1"

type importMemberContactTransfer struct {
 ChallengeID string `json:"challengeId"`
 OperationID string `json:"operationId"`
 DeliveryID string `json:"deliveryId"`
 InputHash string `json:"inputHash"`
 EffectHash string `json:"effectHash"`
 MutationHash string `json:"mutationHash"`
 PreviousEntity string `json:"previousEntity"`
 NextEntity string `json:"nextEntity"`
 CommittedAt int64 `json:"committedAt"`
}
type importMemberStagedReferenceData struct {
 Contract string `json:"contract"`
 OperationID string `json:"operationId"`
 RequestHash string `json:"requestHash"`
 PlanHash string `json:"planHash"`
 Namespace string `json:"namespace"`
 OrderID string `json:"orderId"`
 CustomerID string `json:"customerId"`
 SourceReceiptHash string `json:"sourceReceiptHash"`
 Original importMembershipRecord `json:"original"`
 CurrentEntity string `json:"currentEntity"`
 CurrentRevision string `json:"currentRevision"`
 CurrentRows []MembershipState `json:"currentRows"`
 Transfers []importMemberContactTransfer `json:"transfers"`
 GrantID string `json:"grantId"`
 ManagerID string `json:"managerId"`
 ApprovedAt int64 `json:"approvedAt"`
}
type importMemberStagedReference struct {
 Data importMemberStagedReferenceData `json:"data"`
 SourceHash string `json:"sourceHash"`
}
type importMemberSourceMutation struct {
 Kind string `json:"kind"`
 ProductID string `json:"productId"`
 Delta int `json:"delta"`
 MemberValue string `json:"memberValue"`
 ExpiryBefore string `json:"expiryBefore"`
 ExpiryAfter string `json:"expiryAfter"`
}
type importMemberReferenceActivation struct {
 Contract string `json:"contract"`
 OperationID string `json:"operationId"`
 RequestHash string `json:"requestHash"`
 PlanHash string `json:"planHash"`
 OrderID string `json:"orderId"`
 CustomerID string `json:"customerId"`
 Nonce string `json:"nonce"`
 SourceReceiptHash string `json:"sourceReceiptHash"`
 ReferenceHash string `json:"referenceHash"`
 OriginalStageHash string `json:"originalStageHash"`
 ConfirmationHash string `json:"confirmationHash"`
 SourceMutation importMemberSourceMutation `json:"sourceMutation"`
 Activation importMembershipRecord `json:"activation"`
 ConfirmedAt int64 `json:"confirmedAt"`
}
type importMemberActivation struct {
 ordinary *membershipActivation
 reference *importMemberStagedReference
 original membershipProof
 mutation importMemberSourceMutation
}
func importMemberRecord(p membershipProof) importMembershipRecord {
 return importMembershipRecord{OrderID:strconv.FormatInt(p.OrderID,10),CustomerID:strconv.FormatInt(p.CustomerID,10),
  Revision:strconv.FormatUint(p.Revision,10),HeaderHash:p.HeaderHash,Before:p.Before,Confirmed:p.Confirmed,
  Contract:p.Contract,OperationID:p.OperationID,CreatedAt:p.CreatedAt,EntityDigest:p.EntityDigest,ProofHash:p.ProofHash}
}
func importMemberReferenceMAC(key,kind string,value interface{}) (string,error) {
 // Node operationHash sorts every nested object's keys. Struct declaration
 // order is never a protocol serialization, even when its JSON fields match.
 raw,err:=json.Marshal(value);if err!=nil{return "",err}
 var canonical interface{};decoder:=json.NewDecoder(bytes.NewReader(raw));decoder.UseNumber()
 if decoder.Decode(&canonical)!=nil{return "",ErrReview}
 return importMAC(key,kind,canonical)
}
func decodeImportMemberReference(raw []byte) (*importMemberStagedReference,error) {
 if len(raw)==0||len(raw)>262144{return nil,ErrReview}
 var value importMemberStagedReference
 decoder:=json.NewDecoder(bytes.NewReader(raw));decoder.DisallowUnknownFields()
 if decoder.Decode(&value)!=nil{return nil,ErrReview};var extra interface{}
 if decoder.Decode(&extra)!=io.EOF{return nil,ErrReview}
 key:=os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY")
 seal,err:=importMemberReferenceMAC(key,"legacy-order-imports.source.membership-staged-reference.v1",value.Data)
 if !ProjectionKeyValid(key,key)||err!=nil||!hmac.Equal([]byte(seal),[]byte(value.SourceHash)){return nil,ErrReview}
 return &value,nil
}
func readLegacyMemberReference(ctx context.Context,tx *sql.Tx,c *importCapability,hash string) (*importMemberStagedReference,error) {
 var raw []byte;var id,order,grant string
 var err error
 if hash!="" {
  err=tx.QueryRowContext(ctx,`SELECT id,order_id,grant_id,data FROM pos_rewrite_import_membership_staged_references WHERE id=? AND operation_id=? AND OCTET_LENGTH(data)<=262144 FOR SHARE`,hash,c.OperationID).Scan(&id,&order,&grant,&raw)
 }else{
  if c.Succession==nil{return nil,ErrReview}
  err=tx.QueryRowContext(ctx,`SELECT id,order_id,grant_id,data FROM pos_rewrite_import_membership_staged_references WHERE operation_id=? AND grant_id=? AND OCTET_LENGTH(data)<=262144 FOR SHARE`,c.OperationID,c.Succession.Data.ID).Scan(&id,&order,&grant,&raw)
 }
 if err!=nil{return nil,err}
 reference,err:=decodeImportMemberReference(raw);if err!=nil{return nil,err};r:=reference.Data
 if id!=reference.SourceHash||order!=c.OrderID||r.Contract!=LegacyMembershipStagedReferenceContract||r.OperationID!=c.OperationID||
  r.RequestHash!=c.RequestHash||r.PlanHash!=c.PlanHash||r.Namespace!=c.Namespace||r.OrderID!=c.OrderID||r.CustomerID!=c.Authority.CustomerID||
  r.GrantID!=grant||!importUUID.MatchString(r.GrantID)||!consentIdentifier(r.ManagerID)||r.ApprovedAt<1||
  !consentDigest.MatchString(r.CurrentEntity)||!coherentMemberStates(r.CurrentRows,false)||len(r.Transfers)<1||len(r.Transfers)>16{return nil,ErrReview}
 var originalHash string
 if err=tx.QueryRowContext(ctx,`SELECT proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='membership' AND status='completed' AND request_hash=? FOR SHARE`,c.OperationID,c.RequestHash).Scan(&originalHash);err!=nil{return nil,err}
 if originalHash!=r.SourceReceiptHash{return nil,ErrReview}
 return reference,nil
}
func memberReferenceEvidence(ctx context.Context,tx *sql.Tx,key string,r importMemberStagedReferenceData) error {
 previous:=r.Original.EntityDigest
 for _,v:=range r.Transfers {
  if !importUUID.MatchString(v.ChallengeID)||!importUUID.MatchString(v.OperationID)||!importUUID.MatchString(v.DeliveryID)||v.PreviousEntity!=previous||!consentDigest.MatchString(v.NextEntity)||v.CommittedAt<1{return ErrReview}
  var customer,actor,checkout,kind,status,stage,input string
  if err:=tx.QueryRowContext(ctx,`SELECT customer_id,operator_id,checkout_id,kind,status,stage,encrypted_input FROM pos_rewrite_customer_contact_challenges WHERE id=? AND OCTET_LENGTH(encrypted_input)<=342000`,v.ChallengeID).Scan(&customer,&actor,&checkout,&kind,&status,&stage,&input);err!=nil{return err}
  var effectCustomer,effectActor,challenge,effectKind,effect string;var effectAt int64
  if err:=tx.QueryRowContext(ctx,`SELECT customer_id,operator_id,challenge_id,kind,encrypted_payload,created_at_ms FROM pos_rewrite_customer_contact_deliveries WHERE id=? AND OCTET_LENGTH(encrypted_payload)<=342000`,v.DeliveryID).Scan(&effectCustomer,&effectActor,&challenge,&effectKind,&effect,&effectAt);err!=nil{return err}
  var mutationID,mutationChallenge,mutationActor,mutationCheckout,action,inputHash string;var raw []byte;var committedAt int64
  if err:=tx.QueryRowContext(ctx,`SELECT id,challenge_id,operator_id,checkout_id,action,input_hash,result,created_at_ms FROM pos_rewrite_customer_contact_mutations WHERE id=?`,v.OperationID).Scan(&mutationID,&mutationChallenge,&mutationActor,&mutationCheckout,&action,&inputHash,&raw,&committedAt);err!=nil{return err}
  var result map[string]interface{};decoder:=json.NewDecoder(bytes.NewReader(raw));decoder.UseNumber()
  if decoder.Decode(&result)!=nil{return ErrReview}
  expected,err:=importMAC(key,"legacy-order-imports.source.membership-reference-contact-mutation.v1",map[string]interface{}{
   "id":mutationID,"challengeId":mutationChallenge,"operatorId":mutationActor,"checkoutId":mutationCheckout,
   "action":action,"inputHash":inputHash,"result":result,"createdAt":committedAt})
  inHash,eHash:=sha256.Sum256([]byte(input)),sha256.Sum256([]byte(effect))
  if err!=nil||customer!=r.CustomerID||effectCustomer!=r.CustomerID||actor!=effectActor||actor!=mutationActor||checkout!=mutationCheckout||
   challenge!=v.ChallengeID||mutationChallenge!=v.ChallengeID||kind!="email"||stage!="new"||(status!="COMMITTING"&&status!="COMMITTED"&&status!="UNCERTAIN")||
   effectKind!="source-effects"||action!="commit"||result["status"]!="success"||result["id"]!=v.OperationID||result["challengeId"]!=v.ChallengeID||
   committedAt!=v.CommittedAt||effectAt!=committedAt||hex.EncodeToString(inHash[:])!=v.InputHash||hex.EncodeToString(eHash[:])!=v.EffectHash||expected!=v.MutationHash{return ErrReview}
  previous=v.NextEntity
 }
 if previous!=r.CurrentEntity{return ErrReview};return nil
}

// Selected private reference only. No pre-Apply update to the original staged
// provenance occurs. Ordinary confirmation still calls its exact existing lock.
func lockLegacyImportMembershipActivation(ctx context.Context,tx *sql.Tx,c *importCapability,orderID,userID int64,header string,lines []Line,replay bool) (*importMemberActivation,error) {
 if c==nil||c.Succession==nil||replay { ordinary,err:=lockMembership(ctx,tx,orderID,userID,header,lines,replay);return &importMemberActivation{ordinary:ordinary},err }
 original,err:=readMembershipProof(ctx,tx,orderID)
 if err==sql.ErrNoRows{ordinary,e:=lockMembership(ctx,tx,orderID,userID,header,lines,replay);return &importMemberActivation{ordinary:ordinary},e};if err!=nil{return nil,err}
 config,err:=configuredMembership();if err!=nil{return nil,err}
 var entity string;if err=tx.QueryRowContext(ctx,`SELECT email FROM users WHERE id=? FOR UPDATE`,userID).Scan(&entity);err!=nil{return nil,err}
 entityDigest,err:=memberHash("pending-cancellation.membership-entity.v1",entity,config.key);if err!=nil{return nil,err}
 if entityDigest==original.EntityDigest{ordinary,e:=lockMembership(ctx,tx,orderID,userID,header,lines,replay);return &importMemberActivation{ordinary:ordinary},e}
 if os.Getenv("POS_LEGACY_IMPORT_MEMBERSHIP_STAGED_REFERENCE_CONTRACT")!=LegacyMembershipStagedReferenceContract{return nil,ErrReview}
 reference,err:=readLegacyMemberReference(ctx,tx,c,"");if err!=nil{return nil,err};r:=reference.Data
 if r.GrantID!=c.Succession.Data.ID||r.ManagerID!=c.Succession.Data.ManagerID||r.ApprovedAt!=c.Succession.Data.IssuedAt||
  original.Contract!=MembershipStagedContract||original.OrderID!=orderID||original.CustomerID!=userID||original.HeaderHash!=header||
  !validMemberMAC(original,config.key)||!importEqualJSON(r.Original,importMemberRecord(original))||r.CurrentEntity!=entityDigest{return nil,ErrReview}
 if err=nativeMembershipFence(ctx,tx,entity);err!=nil{return nil,err}
 if err=memberReferenceEvidence(ctx,tx,os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY"),r);err!=nil{return nil,err}
 var revision uint64;if err=tx.QueryRowContext(ctx,`SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=? FOR UPDATE`,userID).Scan(&revision);err!=nil{return nil,err}
 current,err:=memberStates(ctx,tx,entity);if err!=nil{return nil,err}
 if strconv.FormatUint(revision,10)!=r.CurrentRevision||revision<=original.Revision||!sameMemberStates(current,r.CurrentRows){return nil,ErrReview}
 var owners int;if err=tx.QueryRowContext(ctx,`SELECT COUNT(*) FROM (SELECT id FROM users WHERE email=? ORDER BY id LIMIT 2) same_entity`,entity).Scan(&owners);err!=nil{return nil,err};if owners!=1{return nil,ErrReview}
 needed:=false;for _,line:=range lines{if config.products[line.ProductID]{needed=true}};if !needed{return nil,ErrReview}
 mutation,err:=legacyMemberSourceMutation(ctx,tx,c,current);if err!=nil{return nil,err}
 c.memberReferenceMutation=&mutation
 virtual:=original;virtual.Revision=revision;virtual.EntityDigest=entityDigest;virtual.Confirmed=current
 return &importMemberActivation{ordinary:&membershipActivation{proof:virtual,entity:entity,key:config.key},reference:reference,original:original,mutation:mutation},nil
}

func finishLegacyImportMembershipActivation(ctx context.Context,tx *sql.Tx,c *importCapability,activation *importMemberActivation) error {
 if activation==nil{return nil};if activation.reference==nil{return finishMembership(ctx,tx,activation.ordinary)}
 if c==nil||c.Succession==nil||activation.ordinary==nil{return ErrReview}
 a:=activation.ordinary;proof:=a.proof
 var entity string;if err:=tx.QueryRowContext(ctx,`SELECT email FROM users WHERE id=? FOR UPDATE`,proof.CustomerID).Scan(&entity);err!=nil{return err};if entity!=a.entity{return ErrReview}
 current,err:=memberStates(ctx,tx,entity);if err!=nil{return err}
 if !sameTransferredActivation(activation.reference.Data.CurrentRows,current,activation.mutation){return ErrReview}
 if _,err=tx.ExecContext(ctx,`UPDATE pos_rewrite_membership_versions SET revision=revision+1 WHERE customer_id=?`,proof.CustomerID);err!=nil{return err}
 if err=tx.QueryRowContext(ctx,`SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=? FOR UPDATE`,proof.CustomerID).Scan(&proof.Revision);err!=nil{return err}
 proof.Confirmed=current;proof.Contract=MembershipContract;proof.ProofHash,err=membershipMAC(proof,a.key);if err!=nil{return err}
 raw,err:=json.Marshal(current);if err!=nil{return err}
 result,err:=tx.ExecContext(ctx,`UPDATE pos_rewrite_cancellation_membership_provenance SET revision=?,confirmed_state=?,contract_version=?,proof_hash=?,entity_digest=? WHERE order_id=? AND contract_version=? AND proof_hash=?`,proof.Revision,string(raw),proof.Contract,proof.ProofHash,proof.EntityDigest,proof.OrderID,MembershipStagedContract,activation.original.ProofHash)
 if err!=nil{return err};changed,err:=result.RowsAffected();if err!=nil{return err};if changed!=1{return ErrReview};return nil
}
// Literal juspay/model.go:1994 getExpiryDelta and :2355/:2378 branches.
// Freeze source settings before Apply; the emitter cannot choose a new policy.
func legacyMemberSourceMutation(ctx context.Context,tx *sql.Tx,c *importCapability,before []MembershipState) (importMemberSourceMutation,error) {
 var mutation importMemberSourceMutation;var raw []byte
 if err:=tx.QueryRowContext(ctx,`SELECT proof FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='membership' AND status='completed' AND OCTET_LENGTH(proof)<=262144 FOR SHARE`,c.OperationID).Scan(&raw);err!=nil{return mutation,err}
 var proof importMembershipReceipt;if json.Unmarshal(raw,&proof)!=nil||len(proof.MemberLines)!=1{return mutation,ErrReview}
 product:=proof.MemberLines[0].ProductID;normal:=false
 for _,name:=range []string{"EXCLUSIVE_PRODUCT_ID","EXCLUSIVE_99_PRODUCT_ID","EXCLUSIVE_QUARTERLY_ID","EXCLUSIVE_QUARTERLY_ID_FREE"}{if os.Getenv(name)==product{normal=true}}
 upgrade:=false;for _,id:=range strings.Split(os.Getenv("EXCLUSIVE_UPGRADE_IDS"),","){if id==product{upgrade=true}}
 if normal==upgrade||(proof.Kind=="upgrade")!=upgrade{return mutation,ErrReview}
 mutation.Kind="activate";mutation.ProductID=product
 for _,value:=range before{if value.Attribute=="EXCLUSIVE_EXPIRY"{mutation.ExpiryBefore=value.Value;mutation.ExpiryAfter=value.Value};if value.Attribute=="EXCLUSIVE_MEMBER"{mutation.MemberValue=value.Value}}
 if upgrade{
  mutation.Kind="upgrade"
  deltas:=map[string]int{};deltas[os.Getenv("EXCLUSIVE_UPGRADE_365")]=365;deltas[os.Getenv("EXCLUSIVE_UPGRADE_330")]=330;deltas[os.Getenv("EXCLUSIVE_UPGRADE_270")]=270
  mutation.Delta=deltas[product]
  point,err:=time.Parse("2006-01-02 15:04:05",strings.Replace(mutation.ExpiryBefore,"T"," ",1));if err!=nil{return mutation,ErrReview}
  mutation.ExpiryAfter=point.AddDate(0,0,mutation.Delta).Format("2006-01-02T15:04:05.000000")
  mutation.MemberValue="1";switch mutation.Delta{case 330:mutation.MemberValue="4";case 270:mutation.MemberValue="5";case 365:mutation.MemberValue="6"}
 }
 return mutation,nil
}
func sameTransferredActivation(before,after []MembershipState,mutation importMemberSourceMutation) bool {
 if len(before)!=2||len(after)!=2||(mutation.Kind!="activate"&&mutation.Kind!="upgrade"){return false}
 for index,value:=range before{
  actual:=after[index];expected:=mutation.MemberValue;if value.Attribute=="EXCLUSIVE_EXPIRY"{expected=mutation.ExpiryAfter}
  active:=value.Active;if mutation.Kind=="activate"{active=1}
  if value.Attribute!=actual.Attribute||expected!=actual.Value||value.CreatedAt!=actual.CreatedAt||actual.Active!=active||actual.Active!=1{return false}
 }
 return true
}

func recordLegacyMembershipReferenceActivation(ctx context.Context,tx *sql.Tx,c *importCapability,confirmationHash string) error {
 if c==nil||c.Succession==nil{return nil}
 var raw []byte;var sourceHash string
 err:=tx.QueryRowContext(ctx,`SELECT proof,proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='membership' AND status='completed' AND OCTET_LENGTH(proof)<=262144 FOR SHARE`,c.OperationID).Scan(&raw,&sourceHash)
 if err==sql.ErrNoRows{return nil};if err!=nil{return err}
 var staged importMembershipReceipt;if json.Unmarshal(raw,&staged)!=nil{return ErrReview}
 orderID,err:=strconv.ParseInt(c.OrderID,10,64);if err!=nil{return ErrReview}
 current,err:=readMembershipProof(ctx,tx,orderID);if err!=nil{return err}
 if current.EntityDigest==staged.Provenance.EntityDigest{return nil}
 reference,err:=readLegacyMemberReference(ctx,tx,c,"");if err!=nil{return err}
 key:=os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY");config,err:=configuredMembership();if err!=nil{return err}
 if c.memberReferenceMutation==nil||current.Contract!=MembershipContract||!validMemberMAC(current,config.key)||
  !importEqualJSON(reference.Data.Original,staged.Provenance)||reference.Data.SourceReceiptHash!=sourceHash||
  current.EntityDigest!=reference.Data.CurrentEntity||!sameMemberStates(current.Before,staged.Provenance.Before)||
  !sameTransferredActivation(reference.Data.CurrentRows,current.Confirmed,*c.memberReferenceMutation){return ErrReview}
 proof:=importMemberReferenceActivation{Contract:LegacyMembershipReferenceActivationContract,OperationID:c.OperationID,
  RequestHash:c.RequestHash,PlanHash:c.PlanHash,OrderID:c.OrderID,CustomerID:c.Authority.CustomerID,Nonce:c.Nonce,
  SourceReceiptHash:sourceHash,ReferenceHash:reference.SourceHash,OriginalStageHash:staged.Provenance.ProofHash,
  ConfirmationHash:confirmationHash,SourceMutation:*c.memberReferenceMutation,Activation:importMemberRecord(current),ConfirmedAt:time.Now().UnixMilli()}
 body,err:=json.Marshal(proof);if err!=nil{return err};seal,err:=importMemberReferenceMAC(key,"legacy-order-imports.source.membership-reference-activation.v1",proof);if err!=nil{return err}
 _,err=tx.ExecContext(ctx,`INSERT INTO pos_rewrite_import_financial_source_receipts(id,operation_id,kind,request_hash,status,proof,proof_hash,created_at_ms) VALUES(?,?,'member-reference',?,'completed',?,?,?)`,c.OperationID+":member-reference",c.OperationID,c.RequestHash,body,seal,proof.ConfirmedAt)
 return err
}

func verifyLegacyMembershipReferenceApplied(ctx context.Context,tx *sql.Tx,c *importCapability,staged importMembershipRecord,current membershipProof) error {
 var raw []byte;var seal,status,request string
 if err:=tx.QueryRowContext(ctx,`SELECT proof,proof_hash,status,request_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='member-reference' AND OCTET_LENGTH(proof)<=262144 FOR SHARE`,c.OperationID).Scan(&raw,&seal,&status,&request);err!=nil{return err}
 var proof importMemberReferenceActivation;decoder:=json.NewDecoder(bytes.NewReader(raw));decoder.DisallowUnknownFields();if decoder.Decode(&proof)!=nil{return ErrReview}
 key:=os.Getenv("POS_LEGACY_IMPORT_PROOF_KEY");expected,err:=importMemberReferenceMAC(key,"legacy-order-imports.source.membership-reference-activation.v1",proof)
 if !ProjectionKeyValid(key,key)||err!=nil||status!="completed"||request!=c.RequestHash||!hmac.Equal([]byte(expected),[]byte(seal))||
  proof.Contract!=LegacyMembershipReferenceActivationContract||proof.OperationID!=c.OperationID||proof.RequestHash!=c.RequestHash||
  proof.PlanHash!=c.PlanHash||proof.OrderID!=c.OrderID||proof.CustomerID!=c.Authority.CustomerID||proof.Nonce!=c.Nonce||
  proof.OriginalStageHash!=staged.ProofHash||!importEqualJSON(proof.Activation,importMemberRecord(current)){return ErrReview}
 reference,err:=readLegacyMemberReference(ctx,tx,c,proof.ReferenceHash);if err!=nil{return err}
 if reference.SourceHash!=proof.ReferenceHash||reference.Data.SourceReceiptHash!=proof.SourceReceiptHash||
  !importEqualJSON(reference.Data.Original,staged)||current.EntityDigest!=reference.Data.CurrentEntity||
  !sameTransferredActivation(reference.Data.CurrentRows,current.Confirmed,proof.SourceMutation){return ErrReview};return nil
}
