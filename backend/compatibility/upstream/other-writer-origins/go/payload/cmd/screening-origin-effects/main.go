// Separate supervised effects process. Disabled/DEMO returns before opening
// a DB/Redis/HTTP connection; utils and the source application's init are not
// imported into this command.
package main

import (
	"context"
	"database/sql"
	"os"
	"os/signal"
	"syscall"
	"time"

	"backend-tss-domestic_payments_api/internal/poscheckout"
	_ "github.com/go-sql-driver/mysql"
)

func main(){
	if os.Getenv("POS_SCREENING_ORIGIN_GO_EFFECTS_CONTRACT")==""||os.Getenv("DEMO_MODE")=="true"{return}
	if os.Getenv("POS_SCREENING_ORIGIN_GO_EFFECTS_CONTRACT")!="pos-screening-origin-go-effects-v1"{poscheckout.OriginLogEvent(os.Stderr,"startup-refused","",nil);os.Exit(1)}
	key:=os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY");if _,e:=poscheckout.OriginMAC(key,"ready",nil);e!=nil{poscheckout.OriginLogEvent(os.Stderr,"startup-refused","",nil);os.Exit(1)}
	// Validate all integration identities before any network connection.
	handlers,e:=poscheckout.OriginHTTPHandlers(os.Getenv,nil);if e!=nil||os.Getenv("POS_SCREENING_ORIGIN_DATABASE_DSN")==""{poscheckout.OriginLogEvent(os.Stderr,"startup-refused","",nil);os.Exit(1)}
	db,e:=sql.Open("mysql",os.Getenv("POS_SCREENING_ORIGIN_DATABASE_DSN"));if e!=nil{poscheckout.OriginLogEvent(os.Stderr,"startup-refused","",nil);os.Exit(1)};defer db.Close();db.SetMaxOpenConns(4);db.SetMaxIdleConns(2)
	redisHandlers,e:=poscheckout.OriginRedisHandlers(db,key,os.Getenv);if e!=nil{poscheckout.OriginLogEvent(os.Stderr,"startup-refused","",nil);os.Exit(1)};for kind,handler:=range redisHandlers{handlers[kind]=handler}
	ctx,stop:=signal.NotifyContext(context.Background(),syscall.SIGTERM,syscall.SIGINT);defer stop()
	for{e=poscheckout.DispatchOriginEffects(ctx,db,key,handlers,25,func(effect poscheckout.OriginEffect,phase string){event:="effect-uncertain";if phase=="ACCEPTED"{event="effect-accepted"};poscheckout.OriginLogEvent(os.Stdout,event,effect.RequestID,effect.ActorID)});if e!=nil&&ctx.Err()==nil{poscheckout.OriginLogEvent(os.Stderr,"uncertain","",nil)}
		timer:=time.NewTimer(5*time.Second);select{case<-ctx.Done():timer.Stop();return;case<-timer.C:}
	}
}
