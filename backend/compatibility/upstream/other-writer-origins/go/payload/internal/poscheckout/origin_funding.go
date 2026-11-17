package poscheckout

import (
	"context"
	"database/sql"
	"time"
)

// This is the ORIGINAL CSK trust boundary, not a fabricated PSP receipt.
// OrderPlacement forces prepaid under its validated secret/strict pricelist;
// OrderHelper explicitly permits that external_api positive-payable branch.
type OriginFundingDeclaration struct {
	Contract string `json:"contract"`;CommandID string `json:"commandId"`;OrderID string `json:"orderId"`;CustomerID string `json:"customerId"`
	CreationHash string `json:"creationHash"`;SystemAuthorityHash string `json:"systemAuthorityHash"`;AuthorityHash string `json:"authorityHash"`
	RequestHash string `json:"requestHash"`;ReferenceHash string `json:"referenceHash"`;CartHash string `json:"cartHash"`;HeaderHash string `json:"headerHash"`;PayableHash string `json:"payableHash"`
	ServiceID string `json:"serviceId"`;ServiceRevision string `json:"serviceRevision"`;CredentialHash string `json:"credentialHash"`;ConfigurationHash string `json:"configurationHash"`
	Declaration string `json:"declaration"`;SourceCommit string `json:"sourceCommit"`;CreatedAt int64 `json:"createdAt"`
}
func(e *OriginEngine)funding(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,o OriginProviderResponse)(string,*string,error){
	if o.Status=="CHARGED"{return "provider-charged",nil,nil}
	if o.Status!="DIRECT"{return "not-confirmed",nil,nil}
	if e.ExchangeFunding!=nil{selection,err:=e.ExchangeFunding(ctx,tx,c,creation);if err!=nil{return "",nil,err};if selection!=nil{return e.exchangeFunding(ctx,tx,c,creation,*selection)}}
	var zero bool;if tx.QueryRowContext(ctx,`SELECT pay_amt=0 FROM orders WHERE id=?`,creation.OrderID).Scan(&zero)!=nil{return "",nil,ErrReview}
	if creation.Method==1{return "source-cod",nil,nil};if creation.Method==14{return "source-coc",nil,nil}
	if zero{return "source-zero-payable",nil,nil}
	// Customer/staff ordinary prepaid still obeys OrderHelper's zero-payable
	// rule. Only genuine CSK can declare external prepaid positive value.
	if creation.Method!=3||c.Origin!="external-system"||!originHash.MatchString(creation.SystemAuthorityHash)||originSystem(ctx,tx,c,e.Key,e.CSKAPIKey)!=nil{return "",nil,ErrReview}
	var raw []byte;var seal string;var authority map[string]interface{}
	if tx.QueryRowContext(ctx,`SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_authorities WHERE command_id=? FOR SHARE`,c.ID).Scan(&raw,&seal)!=nil||seal!=creation.SystemAuthorityHash||originVerify(e.Key,"system-authority",raw,seal,&authority,16000)!=nil{return "",nil,ErrReview}
	var payable string;if tx.QueryRowContext(ctx,`SELECT LOWER(SHA2(CAST(JSON_OBJECT('orderId',id,'customerId',user_id,'method',payment_method,'currency',currency,'payable',pay_amt) AS CHAR CHARACTER SET utf8mb4),256)) FROM orders WHERE id=?`,creation.OrderID).Scan(&payable)!=nil||!originHash.MatchString(payable){return "",nil,ErrReview}
	declaration:=OriginFundingDeclaration{Contract:"pos-screening-origin-csk-prepaid-v1",CommandID:c.ID,OrderID:creation.OrderID,CustomerID:c.CustomerID,CreationHash:*c.CreationHash,SystemAuthorityHash:seal,AuthorityHash:c.AuthorityHash,RequestHash:c.RequestHash,ReferenceHash:c.ReferenceHash,CartHash:c.CartHash,HeaderHash:creation.HeaderHash,PayableHash:payable,ServiceID:"csk",ServiceRevision:originString(authority["serviceRevision"]),CredentialHash:originString(authority["credentialHash"]),ConfigurationHash:originString(authority["configurationHash"]),Declaration:"externally-prepaid",SourceCommit:OriginSourceCommit,CreatedAt:e.now()}
	data,err:=originCanonical(declaration);if err!=nil{return "",nil,err};hash,err:=OriginMAC(e.Key,"funding-declaration",declaration);if err!=nil{return "",nil,err}
	if _,err=tx.ExecContext(ctx,`INSERT INTO pos_rewrite_screening_origin_funding_declarations(command_id,order_id,data,proof_hash) VALUES(?,?,?,?)`,c.ID,creation.OrderID,string(data),hash);err!=nil{return "",nil,err};return "external-system-csk-prepaid",&hash,nil
}

// Retained declarations remain readable after service rotation; the genuine
// authority was checked before the original commit. New work rechecks current
// service authority separately and cannot recycle this seal for another order.
func verifyOriginFunding(ctx context.Context,tx *sql.Tx,c OriginCommand,creation OriginCreation,p OriginPayment,key string)error{
	if p.FundingBasis=="source-exchange"{return verifyOriginExchangeFunding(ctx,tx,c,creation,p,key)}
	if p.FundingBasis!="external-system-csk-prepaid"{if p.FundingHash!=nil{return ErrReview};switch p.FundingBasis{case "provider-charged","source-zero-payable","source-cod","source-coc":return nil;default:return ErrReview}}
	var value OriginFundingDeclaration;var raw []byte;var seal,order string
	if p.FundingHash==nil||c.Origin!="external-system"||creation.Method!=3||tx.QueryRowContext(ctx,`SELECT CAST(order_id AS CHAR),CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash FROM pos_rewrite_screening_origin_funding_declarations WHERE command_id=? FOR SHARE`,c.ID).Scan(&order,&raw,&seal)!=nil||seal!=*p.FundingHash||originVerify(key,"funding-declaration",raw,seal,&value,16000)!=nil||value.Contract!="pos-screening-origin-csk-prepaid-v1"||value.CommandID!=c.ID||value.OrderID!=creation.OrderID||order!=value.OrderID||value.CustomerID!=c.CustomerID||value.CreationHash!=*c.CreationHash||value.SystemAuthorityHash!=creation.SystemAuthorityHash||value.AuthorityHash!=c.AuthorityHash||value.RequestHash!=c.RequestHash||value.ReferenceHash!=c.ReferenceHash||value.CartHash!=c.CartHash||value.HeaderHash!=creation.HeaderHash||value.ServiceID!="csk"||value.Declaration!="externally-prepaid"||value.SourceCommit!=OriginSourceCommit||!originPoint(value.CreatedAt)||time.UnixMilli(value.CreatedAt).After(time.UnixMilli(p.CreatedAt)){return ErrReview}
	return nil
}
