package poscheckout

// These contracts authenticate the genuine customer/staff/system source frame.
// They deliberately do not decode a Node POS or CSV order capability.
import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const OriginPaymentsContract = "pos-screening-origin-payments-v1"
const OriginSourceCommit = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"
const OriginPaymentsSourceCommit = "434f3e438d1cb48c64e5723222c6efda506db571"

var originUUID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var originHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var originID = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
var originKey = regexp.MustCompile(`^[!-~]{32,4096}$`)

type OriginLine struct {
	ID string `json:"id"`
	ProductID string `json:"productId"`
	Quantity int64 `json:"quantity"`
	InputHash string `json:"inputHash"`
}
type OriginTicketLine struct { ID string `json:"id"`; Quantity int64 `json:"quantity"` }
type OriginMarker struct { ID string `json:"id"`; LineID string `json:"lineId"` }
type OriginCommand struct {
	Contract string `json:"contract"`; ID string `json:"id"`; Origin string `json:"origin"`
	CustomerID string `json:"customerId"`; ActorID *string `json:"actorId"`; StoreID *string `json:"storeId"`; CounterID *string `json:"counterId"`
	NamespaceHash string `json:"namespaceHash"`; RequestHash string `json:"requestHash"`; CartHash string `json:"cartHash"`; ReferenceHash string `json:"referenceHash"`; AuthorityHash string `json:"authorityHash"`
	Quantity int64 `json:"quantity"`; MarkerRows int64 `json:"markerRows"`; LineItemsEnabled bool `json:"lineItemsEnabled"`
	Phase string `json:"phase"`; OrderID *string `json:"orderId"`; Lines []OriginTicketLine `json:"lines"`; Markers []OriginMarker `json:"markers"`
	CreationHash *string `json:"creationHash"`; ClosureHash *string `json:"closureHash"`
	Version int64 `json:"version"`; CreatedAt int64 `json:"createdAt"`; UpdatedAt int64 `json:"updatedAt"`; ExpiresAt int64 `json:"expiresAt"`
}
type OriginCreation struct {
	Contract string `json:"contract"`; CommandID string `json:"commandId"`; Origin string `json:"origin"`; CustomerID string `json:"customerId"`
	ActorID *string `json:"actorId"`; StoreID *string `json:"storeId"`; CounterID *string `json:"counterId"`
	AuthorityHash string `json:"authorityHash"`; RequestHash string `json:"requestHash"`; CartHash string `json:"cartHash"`; ReferenceHash string `json:"referenceHash"`
	OrderID string `json:"orderId"`; Method int64 `json:"method"`; HeaderHash string `json:"headerHash"`
	AllocationHash string `json:"allocationHash"`
	Lines []OriginLine `json:"lines"`; TicketLines []OriginTicketLine `json:"ticketLines"`; Markers []OriginMarker `json:"markers"`
	LineItemsEnabled bool `json:"lineItemsEnabled"`; EffectsHash string `json:"effectsHash"`; SourceCommit string `json:"sourceCommit"`; CreatedAt int64 `json:"createdAt"`
	SystemAuthorityHash string `json:"systemAuthorityHash,omitempty"`
}
type OriginPaymentAuthorization struct {
	Contract string `json:"contract"`; CommandID string `json:"commandId"`; OrderID string `json:"orderId"`; CustomerID string `json:"customerId"`
	CreationHash string `json:"creationHash"`; RequestHash string `json:"requestHash"`; ReferenceHash string `json:"referenceHash"`; AuthorityHash string `json:"authorityHash"`
	PaymentRequestHash string `json:"paymentRequestHash"`; IssuedAt int64 `json:"issuedAt"`; ExpiresAt int64 `json:"expiresAt"`
}
type OriginEnvelope struct { Data json.RawMessage `json:"data"`; ProofHash string `json:"proofHash"` }

// Decoding rejects duplicates, unknown fields, trailing values and non-integer
// proof numbers. Python's canonical bytes remain the only HMAC representation.
func OriginDecode(raw []byte, value interface{}, maximum int) error {
	if len(raw)==0 || len(raw)>maximum { return ErrReview }
	var decoded interface{}
	d:=json.NewDecoder(bytes.NewReader(raw)); d.UseNumber()
	var parse func() (interface{},error)
	parse=func()(interface{},error){
		t,err:=d.Token(); if err!=nil{return nil,ErrReview}
		switch v:=t.(type){
		case json.Delim:
			if v=='{' {m:=map[string]interface{}{}; for d.More(){k,e:=d.Token(); key,ok:=k.(string);if e!=nil||!ok{return nil,ErrReview};if _,present:=m[key];present{return nil,ErrReview};n,e:=parse();if e!=nil{return nil,e};m[key]=n};end,e:=d.Token();if e!=nil||end!=json.Delim('}'){return nil,ErrReview};return m,nil}
			if v=='[' {a:=[]interface{}{};for d.More(){n,e:=parse();if e!=nil{return nil,e};a=append(a,n)};end,e:=d.Token();if e!=nil||end!=json.Delim(']'){return nil,ErrReview};return a,nil};return nil,ErrReview
		case json.Number: if _,e:=v.Int64();e!=nil{return nil,ErrReview};return v,nil
		case nil,bool,string:return v,nil
		default:return nil,ErrReview
		}
	}
	var err error;decoded,err=parse();if err!=nil{return err};if _,err=d.Token();err!=io.EOF{return ErrReview}
	plain,err:=json.Marshal(decoded);if err!=nil{return ErrReview}
	d=json.NewDecoder(bytes.NewReader(plain));d.DisallowUnknownFields();d.UseNumber();if d.Decode(value)!=nil{return ErrReview};return nil
}
func originCanonical(value interface{}) ([]byte,error) {
	raw,err:=json.Marshal(value);if err!=nil{return nil,ErrReview}
	d:=json.NewDecoder(bytes.NewReader(raw));d.UseNumber();var v interface{};if d.Decode(&v)!=nil{return nil,ErrReview}
	var out bytes.Buffer
	var encode func(interface{}) error
	quote:=func(s string){out.WriteByte('"');for _,r:=range s{switch r{case '"','\\':out.WriteByte('\\');out.WriteRune(r);case '\b':out.WriteString(`\b`);case '\f':out.WriteString(`\f`);case '\n':out.WriteString(`\n`);case '\r':out.WriteString(`\r`);case '\t':out.WriteString(`\t`);default:if r<32{out.WriteString(`\u00`);out.WriteString(hex.EncodeToString([]byte{byte(r)}))}else{out.WriteRune(r)}}};out.WriteByte('"')}
	encode=func(x interface{})error{switch n:=x.(type){case nil:out.WriteString("null");case bool:out.WriteString(strconv.FormatBool(n));case string:quote(n);case json.Number:if _,e:=n.Int64();e!=nil{return ErrReview};out.WriteString(n.String());case []interface{}:out.WriteByte('[');for i,e:=range n{if i>0{out.WriteByte(',')};if encode(e)!=nil{return ErrReview}};out.WriteByte(']');case map[string]interface{}:keys:=make([]string,0,len(n));for k:=range n{keys=append(keys,k)};sort.Strings(keys);out.WriteByte('{');for i,k:=range keys{if i>0{out.WriteByte(',')};quote(k);out.WriteByte(':');if encode(n[k])!=nil{return ErrReview}};out.WriteByte('}');default:return ErrReview};return nil}
	if encode(v)!=nil{return nil,ErrReview};return out.Bytes(),nil
}
func OriginMAC(key,purpose string,value interface{})(string,error){
	if !originKey.MatchString(key)||!regexp.MustCompile(`^[a-z][a-z-]{0,63}$`).MatchString(purpose){return "",ErrReview};raw,e:=originCanonical(value);if e!=nil{return "",e}
	h:=hmac.New(sha256.New,[]byte(key));h.Write([]byte(`{"kind":"screening-origin.`+purpose+`.v1","input":`));h.Write(raw);h.Write([]byte(`}`));return hex.EncodeToString(h.Sum(nil)),nil
}
func originVerify(key,purpose string,raw []byte,seal string,value interface{},limit int)error{if !originHash.MatchString(seal)||OriginDecode(raw,value,limit)!=nil{return ErrReview};var generic interface{};d:=json.NewDecoder(bytes.NewReader(raw));d.UseNumber();if d.Decode(&generic)!=nil{return ErrReview};expected,e:=OriginMAC(key,purpose,generic);if e!=nil||!hmac.Equal([]byte(expected),[]byte(seal)){return ErrReview};return nil}
func originIdentifier(s string)bool{n,e:=strconv.ParseInt(s,10,64);return originID.MatchString(s)&&e==nil&&n>0}
func originPoint(n int64)bool{return n>0&&n<=9007199254740991}
func originEqual(a,b interface{})bool{x,e:=originCanonical(a);y,f:=originCanonical(b);return e==nil&&f==nil&&bytes.Equal(x,y)}
func originSame(a,b *string)bool{return a==nil&&b==nil||a!=nil&&b!=nil&&*a==*b}
func (v *OriginCommand) validate()error{
	if v.Contract!="pos-screening-origin-command-v1"||!originUUID.MatchString(v.ID)||!originIdentifier(v.CustomerID){return ErrReview}
	staff:=v.Origin=="legacy-django"||v.Origin=="mpos";if !staff&&v.Origin!="customer"&&v.Origin!="external-system"{return ErrReview}
	for _,id:=range []*string{v.ActorID,v.StoreID,v.CounterID}{if staff&&(id==nil||!originIdentifier(*id))||!staff&&id!=nil{return ErrReview}}
	for _,h:=range []string{v.NamespaceHash,v.RequestHash,v.CartHash,v.ReferenceHash,v.AuthorityHash}{if !originHash.MatchString(h){return ErrReview}}
	for _,n:=range []int64{v.Version,v.CreatedAt,v.UpdatedAt,v.ExpiresAt}{if !originPoint(n){return ErrReview}}
	if v.Quantity<1||v.Quantity>2||v.MarkerRows<1||v.MarkerRows>2||v.UpdatedAt<v.CreatedAt||v.ExpiresAt<=v.CreatedAt||v.ExpiresAt>v.CreatedAt+600000||v.LineItemsEnabled&&v.MarkerRows!=v.Quantity||!v.LineItemsEnabled&&v.MarkerRows!=1{return ErrReview}
	bound:=v.Phase=="BOUND"||v.Phase=="COUNTED";if !bound&&v.Phase!="PREPARED"&&v.Phase!="RESERVED"&&v.Phase!="REJECTED"{return ErrReview}
	if bound!=(v.OrderID!=nil)||bound!=(v.CreationHash!=nil)||(v.Phase=="REJECTED")!=(v.ClosureHash!=nil){return ErrReview}
	if bound&&(!originIdentifier(*v.OrderID)||!originHash.MatchString(*v.CreationHash)||len(v.Lines)!=int(v.MarkerRows)||len(v.Markers)!=len(v.Lines)){return ErrReview}
	if !bound&&(len(v.Lines)!=0||len(v.Markers)!=0){return ErrReview};if v.ClosureHash!=nil&&!originHash.MatchString(*v.ClosureHash){return ErrReview}
	seen:=map[string]bool{};total:=int64(0);for _,l:=range v.Lines{if !originIdentifier(l.ID)||seen[l.ID]||l.Quantity<1||l.Quantity>2{return ErrReview};seen[l.ID]=true;total+=l.Quantity}
	markers:=map[string]bool{};children:=map[string]bool{};for _,m:=range v.Markers{if !originIdentifier(m.ID)||!seen[m.LineID]||markers[m.ID]||children[m.LineID]{return ErrReview};markers[m.ID]=true;children[m.LineID]=true};if bound&&total!=v.Quantity{return ErrReview};return nil
}
func (v *OriginCreation) validate(c OriginCommand)error{
	if v.Contract!="pos-screening-origin-creation-v1"||v.SourceCommit!=OriginSourceCommit||v.CommandID!=c.ID||v.Origin!=c.Origin||v.CustomerID!=c.CustomerID||c.OrderID==nil||v.OrderID!=*c.OrderID||!originSame(v.ActorID,c.ActorID)||!originSame(v.StoreID,c.StoreID)||!originSame(v.CounterID,c.CounterID)||v.AuthorityHash!=c.AuthorityHash||v.RequestHash!=c.RequestHash||v.CartHash!=c.CartHash||v.ReferenceHash!=c.ReferenceHash||v.LineItemsEnabled!=c.LineItemsEnabled||!originEqual(v.TicketLines,c.Lines)||!originEqual(v.Markers,c.Markers)||v.Method<1||v.Method>math.MaxInt32||!originHash.MatchString(v.HeaderHash)||!originHash.MatchString(v.AllocationHash)||!originHash.MatchString(v.EffectsHash)||len(v.Lines)<1||len(v.Lines)>1000||!originPoint(v.CreatedAt){return ErrReview}
	if (v.Origin=="external-system")!=originHash.MatchString(v.SystemAuthorityHash){return ErrReview}
	seen:=map[string]bool{};for _,l:=range v.Lines{if !originIdentifier(l.ID)||!originIdentifier(l.ProductID)||l.Quantity<1||l.Quantity>999||!originHash.MatchString(l.InputHash)||seen[l.ID]{return ErrReview};seen[l.ID]=true};return nil
}
func OriginAuthorization(raw,key,purpose string,now int64)(OriginPaymentAuthorization,error){
	var env OriginEnvelope;var cap OriginPaymentAuthorization
	decoded,e:=base64.RawURLEncoding.DecodeString(raw);if e!=nil||OriginDecode(decoded,&env,6000)!=nil||originVerify(key,purpose,env.Data,env.ProofHash,&cap,4000)!=nil{return cap,ErrReview}
	if cap.Contract!="pos-screening-origin-payment-submission-v1"||!originUUID.MatchString(cap.CommandID)||!originIdentifier(cap.OrderID)||!originIdentifier(cap.CustomerID)||!originPoint(cap.IssuedAt)||!originPoint(cap.ExpiresAt)||cap.IssuedAt>now||cap.ExpiresAt<=now||cap.ExpiresAt>cap.IssuedAt+60000{return cap,ErrReview}
	for _,h:=range []string{cap.CreationHash,cap.RequestHash,cap.ReferenceHash,cap.AuthorityHash,cap.PaymentRequestHash}{if !originHash.MatchString(h){return cap,ErrReview}};return cap,nil
}
func originSeal(key,id string,value interface{})(string,string,error){
	raw,e:=originCanonical(value);if e!=nil||len(raw)>1048576{return "","",ErrReview};sum:=sha256.Sum256(raw);secret:=sha256.Sum256([]byte("screening-origin-go-private.v1:"+key));block,e:=aes.NewCipher(secret[:]);if e!=nil{return "","",e};aead,e:=cipher.NewGCM(block);if e!=nil{return "","",e};nonce:=make([]byte,aead.NonceSize());if _,e=io.ReadFull(rand.Reader,nonce);e!=nil{return "","",e};sealed:=aead.Seal(nonce,nonce,raw,[]byte(id));return base64.RawURLEncoding.EncodeToString(sealed),hex.EncodeToString(sum[:]),nil
}
func originOpen(key,id,payload,checksum string,value interface{})error{
	raw,e:=base64.RawURLEncoding.DecodeString(payload);secret:=sha256.Sum256([]byte("screening-origin-go-private.v1:"+key));block,err:=aes.NewCipher(secret[:]);if e!=nil||err!=nil||len(raw)>1400000{return ErrReview};aead,err:=cipher.NewGCM(block);if err!=nil||len(raw)<aead.NonceSize(){return ErrReview};clear,e:=aead.Open(nil,raw[:aead.NonceSize()],raw[aead.NonceSize():],[]byte(id));sum:=sha256.Sum256(clear);if e!=nil||!hmac.Equal([]byte(hex.EncodeToString(sum[:])),[]byte(checksum)){return ErrReview};return OriginDecode(clear,value,1048576)
}
func originSafeRequestID(value string)string{if regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`).MatchString(value){return value};var id [16]byte;if _,e:=io.ReadFull(rand.Reader,id[:]);e!=nil{return "origin-payment"};return hex.EncodeToString(id[:])}
func originMethodGateway(method int64)bool{return method==10||method==11||method==12||method==13||method==17||method==18}
func originCleanHeader(value string)bool{return value!=""&&len(value)<=128&&!strings.ContainsAny(value,"\r\n\x00")}
