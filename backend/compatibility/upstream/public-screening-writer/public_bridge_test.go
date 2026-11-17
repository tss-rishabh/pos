package sourcefixture

import (
 "backend-tss-domestic_payments_api/internal/poscheckout"
 "context"
 "database/sql"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net"
 "net/url"
 "os"
 "regexp"
 "strings"
 "testing"
 "time"
 mysql "github.com/go-sql-driver/mysql"
)

func TestPublicScreeningExistingSource(t *testing.T){
 if os.Getenv("POS_PUBLIC_SCREENING_FIXTURE")!="1"{t.Skip("explicit disposable local bridge")}
 var input struct{ URL string `json:"url"`; ProofKey string `json:"proofKey"`;OrderID int64 `json:"orderId"`; ExpectRejected bool `json:"expectRejected"` }
 decoder:=json.NewDecoder(io.LimitReader(os.Stdin,16000));decoder.DisallowUnknownFields()
 if decoder.Decode(&input)!=nil || decoder.Decode(&struct{}{})!=io.EOF || input.OrderID<1 {t.Fatal("invalid local screening input")}
 u,err:=url.Parse(input.URL)
 if err!=nil || u.Scheme!="mysql" || (u.Hostname()!="localhost" && u.Hostname()!="127.0.0.1") || u.User==nil || u.RawQuery!="" || u.Fragment!="" || !regexp.MustCompile(`^/pos_rewrite_import_runtime_[a-f0-9]{12}$`).MatchString(u.Path){t.Fatal("disposable localhost screening schema required")}
 port:=u.Port();if port==""{port="3306"};password,_:=u.User.Password()
 config:=mysql.NewConfig();config.User=u.User.Username();config.Passwd=password;config.Net="tcp";config.Addr=net.JoinHostPort(u.Hostname(),port)
 config.DBName=strings.TrimPrefix(u.Path,"/");config.ParseTime=true;config.Loc=time.UTC;config.Timeout=5*time.Second;config.ReadTimeout=20*time.Second;config.WriteTimeout=20*time.Second
 db,err:=sql.Open("mysql",config.FormatDSN());if err!=nil{t.Fatal("local screening connection unavailable")};defer db.Close()
 t.Setenv("POS_LEGACY_IMPORT_PROOF_KEY",input.ProofKey)
 t.Setenv("POS_LEGACY_IMPORT_SCREENING_CONTRACT",poscheckout.ImportScreeningContract)
 t.Setenv("POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT",poscheckout.ImportScreeningSchemaContract)
 t.Setenv("POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT",poscheckout.ImportScreeningWriterContract)
 t.Setenv("POS_MEMBERSHIP_PRODUCT_IDS","[]");t.Setenv("POS_MEMBERSHIP_PROOF_KEY",strings.Repeat("fixture-member-proof-",3));t.Setenv("POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT","pos-membership-native-revision-v1")
 for _,name:=range []string{"EXCLUSIVE_PRODUCT_ID","EXCLUSIVE_99_PRODUCT_ID","EXCLUSIVE_QUARTERLY_ID","EXCLUSIVE_QUARTERLY_ID_FREE","EXCLUSIVE_UPGRADE_IDS"}{t.Setenv(name,"")}
 called:=0
 for attempt:=0;attempt<2;attempt++ {
  result,e:=poscheckout.Confirm(context.Background(),db,input.OrderID,poscheckout.DefaultHashes,func(tx *sql.Tx)error{called++;return sourceApply(tx,int(input.OrderID),false)})
  if input.ExpectRejected {if !errors.Is(e,poscheckout.ErrReview) || called!=0{t.Fatal("fenced screening order reached source or failed outside its proof guard")};return}
  if e!=nil {if native,ok:=e.(*mysql.MySQLError);ok{
   missing:=regexp.MustCompile(`(?i)Table '[a-z0-9_]+\.([a-z0-9_]+)' doesn't exist`).FindStringSubmatch(native.Message)
   if len(missing)==2{t.Fatalf("local screening SQL code %d table %s",native.Number,missing[1])}
   column:=regexp.MustCompile(`(?i)Unknown column '([a-z0-9_.]+)'`).FindStringSubmatch(native.Message)
   if len(column)==2{t.Fatalf("local screening SQL code %d column %s, callbacks %d",native.Number,column[1],called)}
   t.Fatalf("local screening SQL code %d, callbacks %d",native.Number,called)
  };t.Fatalf("local screening confirmation refused (%T), callbacks %d",e,called)}
  if result.Created!=(attempt==0){t.Fatal("local screening proof replay changed")}
 }
 if called!=1{t.Fatal("original source was not applied once")}
 fmt.Println("PUBLIC_SCREENING_CONFIRMED")
}
