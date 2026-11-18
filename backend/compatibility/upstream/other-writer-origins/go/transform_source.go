// Reads pinned Go AST only. Never imports/starts the payments application.
// Unlike the POS transformer, this preserves online/store/hold branches.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
)

var fs=token.NewFileSet()
func privacyBlock(b *ast.BlockStmt){if b==nil{return};var out []ast.Stmt
	for _,s:=range b.List{
		if e,ok:=s.(*ast.ExprStmt);ok{if call,ok:=e.X.(*ast.CallExpr);ok{callee:=render(call.Fun);if callee=="utils.Debugf"||callee=="utils.Infof"||callee=="utils.Warnf"||callee=="utils.Errorf"||callee=="utils.Error"||callee=="utils.LogRequestError"{continue}}}
		switch v:=s.(type){case *ast.IfStmt:privacyBlock(v.Body);if e,ok:=v.Else.(*ast.BlockStmt);ok{privacyBlock(e)};if len(v.Body.List)==0&&v.Else==nil{continue};case *ast.ForStmt:privacyBlock(v.Body);case *ast.RangeStmt:privacyBlock(v.Body);case *ast.GoStmt:ast.Inspect(v,func(n ast.Node)bool{if f,ok:=n.(*ast.FuncLit);ok{privacyBlock(f.Body);return false};return true})}
		out=append(out,s)
	};b.List=out
}
func prunePrivacyLocals(fn *ast.FuncDecl){
	counts:=map[string]int{};ast.Inspect(fn.Body,func(n ast.Node)bool{if id,ok:=n.(*ast.Ident);ok{counts[id.Name]++};return true})
	ast.Inspect(fn.Body,func(n ast.Node)bool{block,ok:=n.(*ast.BlockStmt);if !ok{return true};var kept []ast.Stmt
		for _,s:=range block.List{if a,ok:=s.(*ast.AssignStmt);ok&&a.Tok==token.DEFINE{allBlank:=true;for i,lhs:=range a.Lhs{if id,ok:=lhs.(*ast.Ident);ok{if counts[id.Name]==1{a.Lhs[i]=ast.NewIdent("_")}else{allBlank=false}}else{allBlank=false}};if allBlank{a.Tok=token.ASSIGN}};kept=append(kept,s)};block.List=kept;return true})
}
func sanitize(path string){raw,e:=os.ReadFile(path);if e!=nil{panic("owned privacy source missing")};f,e:=parser.ParseFile(fs,path,raw,parser.ParseComments);if e!=nil{panic("owned privacy source invalid")};names:=map[string]bool{"ProcessOrder":true,"GokwikProcessOrder":true,"GokwikWebhookUpdate":true,"GokwikPaymentVerifyCron":true,"GokwikPaymentVerify":true,"GokwikPaymentUpdate":true,"WebhookUpdate":true,"VerifyPayment":true,"VerifyPaymentWWE":true,"OrderPaymentStatusUpdate":true}
	for _,d:=range f.Decls{if fn,ok:=d.(*ast.FuncDecl);ok&&names[fn.Name.Name]{privacyBlock(fn.Body);prunePrivacyLocals(fn)}};if format.Node(os.Stdout,fs,f)!=nil{panic("owned privacy formatting failed")}
}
func render(n interface{})string{var b bytes.Buffer;if printer.Fprint(&b,fs,n)!=nil{panic("source AST cannot be rendered")};return b.String()}
func stmt(s string)ast.Stmt{f,e:=parser.ParseFile(token.NewFileSet(),"owned.go","package p;func f(){"+s+"}",0);if e!=nil{panic("invalid owned source substitution")};return f.Decls[0].(*ast.FuncDecl).Body.List[0]}
func stmts(s string)[]ast.Stmt{f,e:=parser.ParseFile(token.NewFileSet(),"owned.go","package p;func f(){"+s+"}",0);if e!=nil{panic("invalid owned source substitutions")};return f.Decls[0].(*ast.FuncDecl).Body.List}
func expr(s string)ast.Expr{x,e:=parser.ParseExpr(s);if e!=nil{panic("invalid owned expression")};return x}
func database(n ast.Expr)bool{switch v:=n.(type){case *ast.Ident:return v.Name=="Db";case *ast.SelectorExpr:return database(v.X);case *ast.CallExpr:return database(v.Fun)};return false}
func bind(n ast.Node){ast.Inspect(n,func(n ast.Node)bool{v,ok:=n.(*ast.SelectorExpr);if !ok{return true};if x,ok:=v.X.(*ast.SelectorExpr);ok&&render(x)=="utils.Db"{v.X=ast.NewIdent("Db")};return true})}
func add(kind,product,line,quantity,location,gateway string)ast.Stmt{return stmt(`if err:=effects.Add("`+kind+`",`+product+`,`+line+`,`+quantity+`,`+location+`,`+gateway+`);err!=nil{return err}`)}
var asyncEffects=map[string]string{"WELCOME_EXCLUSIVE":"welcome-exclusive","ORDER_PRODUCER_URL":"order-producer","ORDER_EM_CHK_URL":"order-engagement","ORDER_GV_CHK_URL":"gift-voucher-check","AUTODELIVER_URL":"auto-deliver","ORDER_EMAIL":"order-email","GIFTVOUCHER_EMAILS":"gift-voucher-emails","STORE_UTM":"store-utm","FREEBIE_COUNT":"freebie-count","POS_ADMIN_URL":"hyperlocal"}

func rewrite(b *ast.BlockStmt,method string){if b==nil{return};var out []ast.Stmt
	for _,n:=range b.List{bind(n);text:=render(n)
		if method=="RevertTssMoney"{
			// Remove only the mirror declaration/write, never an enclosing
			// conditional containing the real money restoration as well.
			if _,ok:=n.(*ast.AssignStmt);ok&&strings.HasPrefix(text,"rh := RewardPointHistory"){continue}
			if e,ok:=n.(*ast.ExprStmt);ok{if call,ok:=e.X.(*ast.CallExpr);ok&&len(call.Args)==1{if method,ok:=call.Fun.(*ast.SelectorExpr);ok&&method.Sel.Name=="Create"{if db,ok:=method.X.(*ast.Ident);ok&&db.Name=="Db"{if address,ok:=call.Args[0].(*ast.UnaryExpr);ok&&address.Op==token.AND{if target,ok:=address.X.(*ast.Ident);ok&&target.Name=="rh"{continue}}}}}}
		}
		switch v:=n.(type){
		case *ast.GoStmt:
			matched:="";for env,kind:=range asyncEffects{if strings.Contains(text,`"`+env+`"`){if matched!=""{panic("ambiguous pinned asynchronous effect")};matched=kind}}
			if matched==""{panic("new uncaptured pinned source goroutine")}
			if matched=="hyperlocal"{out=append(out,stmt(`if result:=Db.Exec("INSERT INTO order_addons (order_id, order_success_timestamp, created_at, updated_at) VALUES(?, ?, ?, ?) ON DUPLICATE KEY UPDATE order_success_timestamp=?, updated_at=?",o.ID,FetchCurrentTime(),FetchCurrentTime(),FetchCurrentTime(),FetchCurrentTime(),FetchCurrentTime());result.Error!=nil{return result.Error}`),add(matched,`""`,`""`,`0`,`int64(o.LocationID)`,`false`))}else{out=append(out,add(matched,`""`,`""`,`0`,`0`,`false`))};continue
		case *ast.AssignStmt:
			left:=render(v.Lhs[0])
			if left=="request"||left=="inv"{continue}
			if left=="resp"&&strings.Contains(text,`"INVENTORY"`){out=append(out,add("inventory",`fmt.Sprint(cartItem.Product)`,`fmt.Sprint(cartItem.Id)`,`int64(cartItem.Quantity)`,`0`,`false`));continue}
			if left=="legacyDecrement"{v.Rhs[0]=expr(`stockMode!="reserve"`)}
			if len(v.Rhs)==1&&database(v.Rhs[0]){prefix:="";if method=="CreateOrder"||method=="CreateOrderGokwik"{prefix="nil,"};out=append(out,v,stmt(`if `+left+`.Error!=nil&&!gorm.IsRecordNotFoundError(`+left+`.Error){return `+prefix+left+`.Error}`));continue}
		case *ast.IfStmt:
			condition:=render(v.Cond)
			if condition=="errs != nil"{continue}
			if strings.Contains(condition,`"TRANS_LOCK_FEATURE"`){out=append(out,stmt(`if os.Getenv("TRANS_LOCK_FEATURE")=="1"{if err:=effects.Add("wallet-unlock","","",10,0,false);err!=nil{return err}}`));continue}
			rewrite(v.Body,method);if branch,ok:=v.Else.(*ast.BlockStmt);ok{rewrite(branch,method)};if branch,ok:=v.Else.(*ast.IfStmt);ok{w:=&ast.BlockStmt{List:[]ast.Stmt{branch}};rewrite(w,method);if len(w.List)==1{v.Else=w.List[0]}else{v.Else=&ast.BlockStmt{List:w.List}}}
			if len(v.Body.List)==0{if condition=="err != nil"{if method=="CreateOrder"||method=="CreateOrderGokwik"{v.Body.List=stmts(`return nil,err`)}else{v.Body.List=stmts(`return err`)}}else if v.Else==nil{continue}}
		case *ast.RangeStmt:rewrite(v.Body,method)
		case *ast.ForStmt:rewrite(v.Body,method)
		case *ast.ExprStmt:
			call,ok:=v.X.(*ast.CallExpr);if !ok{break};name:=render(call.Fun)
			if strings.HasPrefix(name,"utils."){
				if name=="utils.ReDecrementOrderHold"{out=append(out,stmt(`if stockMode!="legacy"{if err:=effects.Add("hold-reconcile","","",0,0,contains(paymentMethods,o.PaymentMethod));err!=nil{return err}}`));continue}
				if strings.Contains(name,"Debug")||strings.Contains(name,"Info")||strings.Contains(name,"Error")||strings.Contains(name,"Warn")||name=="utils.LogRequestError"{continue};panic("uncaptured pinned utility in owned transaction")
			}
			if name=="prod.ReduceStock"{out=append(out,stmt(`if err:=reduceOtherOriginOnline(Db,&prod,cartItem.Quantity,o,effects);err!=nil{return err}`));continue}
			if name=="productStore.ReduceStoreStock"{out=append(out,stmt(`if err:=reduceOtherOriginStore(Db,&productStore,cartItem.Quantity,o,effects);err!=nil{return err}`));continue}
			if database(call){
				if selector,ok:=call.Fun.(*ast.SelectorExpr);ok&&selector.Sel.Name=="Create"{call.Fun=ast.NewIdent("createOtherOriginRecord");call.Args=append([]ast.Expr{ast.NewIdent("Db")},call.Args...)}
				// Fund only actually paid gifts. A placed COD/COC order is not cash.
				if strings.Contains(text,`"UPDATE gift_vouchers SET status = 1 WHERE order_id = ?"`){call.Args=[]ast.Expr{expr(`"UPDATE gift_vouchers SET status=CASE WHEN ?=4 THEN 1 ELSE 0 END WHERE order_id=?"`),ast.NewIdent("payment_status"),expr("o.ID")}}
				if method=="RevertTssMoney"&&strings.Contains(text,`"UPDATE users SET cashback = ?, tss_money = ? WHERE id = ? LIMIT 1"`){call.Args=[]ast.Expr{expr(`"UPDATE users SET tss_money=? WHERE id=? LIMIT 1"`),ast.NewIdent("finalTSSMoneyToUpdate"),expr("o.User")}}
				if method=="CreateOrder"&&strings.Contains(text,"&cust"){out=append(out,stmt(`if result:=`+render(call)+`;result.Error!=nil&&!gorm.IsRecordNotFoundError(result.Error){return nil,result.Error}`));continue}
				if method=="CreateOrder"||method=="CreateOrderGokwik"{out=append(out,stmt(`if result:=`+render(call)+`;result.Error!=nil{return nil,result.Error}`));continue}
				if selector,ok:=call.Fun.(*ast.SelectorExpr);ok&&selector.Sel.Name=="First"&&strings.Contains(text,"&orderStore"){out=append(out,stmt(`if result:=`+render(call)+`;result.Error!=nil&&!gorm.IsRecordNotFoundError(result.Error){return result.Error}`))}else{out=append(out,stmt(`if result:=`+render(call)+`;result.Error!=nil{return result.Error}`))};continue
			}
		case *ast.ReturnStmt:
			if len(v.Results)==1{if render(v.Results[0])=="true"{v.Results=[]ast.Expr{ast.NewIdent("nil")}}else if render(v.Results[0])=="false"{v.Results=[]ast.Expr{expr("poscheckout.ErrReview")}}};if len(v.Results)==0{v.Results=[]ast.Expr{ast.NewIdent("nil")}}
		}
		// Source reward-history mirrors of a money reversal are not a genuine
		// cashback credit. Correct only this approved wallet-clobber branch.
		out=append(out,n)
	};b.List=out
}
func main(){input:=flag.String("input","","pinned model.go");expected:=flag.String("sha256","","required pinned source hash");orderInput:=flag.String("orders","","pinned Order.go");orderExpected:=flag.String("orders-sha256","","required pinned Order.go hash");privacy:=flag.String("sanitize","","owned composed callback file");flag.Parse();if *privacy!=""{sanitize(*privacy);return};raw,e:=os.ReadFile(*input);if e!=nil{panic("pinned source missing")};sum:=sha256.Sum256(raw);if *expected==""||hex.EncodeToString(sum[:])!=*expected{panic("pinned source hash mismatch")};file,e:=parser.ParseFile(fs,*input,raw,0);if e!=nil{panic("pinned source invalid")}
	wanted:=map[string]string{"OrderAndStockConfirmed":"applyOtherOriginSource","ExchangeOrderAndStockConfirmed":"applyOtherOriginExchange","RevertTssMoney":"revertOtherOriginMoney","RevertTssPoints":"revertOtherOriginPoints","RevertGiftVoucher":"revertOtherOriginVoucher","RevertCouponAmtUsed":"revertOtherOriginCoupon","RevertTssPointsSaveTheSoul":"revertOtherOriginDonation"};var declarations []ast.Decl
	for _,d:=range file.Decls{fn,ok:=d.(*ast.FuncDecl);if !ok||wanted[fn.Name.Name]==""{continue};name:=fn.Name.Name;fn.Name.Name=wanted[name];if name=="OrderAndStockConfirmed"{
		ast.Inspect(fn.Body,func(n ast.Node)bool{branch,ok:=n.(*ast.IfStmt);if !ok||render(branch.Cond)!="o.CashbackUsed > 0"{return true};ast.Inspect(branch.Body,func(n ast.Node)bool{if literal,ok:=n.(*ast.BasicLit);ok&&literal.Kind==token.STRING{value,_:=strconv.Unquote(literal.Value);if value=="SELECT tss_money FROM users WHERE id = ?"{literal.Value=strconv.Quote("SELECT cashback FROM users WHERE id = ?")}};if field,ok:=n.(*ast.SelectorExpr);ok&&render(field)=="user.TssMoney"{field.Sel.Name="Cashback"};return true});return true})
		fn.Type.Params.List=append(fn.Type.Params.List[:1],&ast.Field{Names:[]*ast.Ident{ast.NewIdent("effects")},Type:expr("*poscheckout.OriginEffectCollector")},&ast.Field{Names:[]*ast.Ident{ast.NewIdent("stockMode")},Type:ast.NewIdent("string")},fn.Type.Params.List[1])};if name=="ExchangeOrderAndStockConfirmed"{fn.Type.Params.List=append(fn.Type.Params.List,&ast.Field{Names:[]*ast.Ident{ast.NewIdent("effects")},Type:expr("*poscheckout.OriginEffectCollector")},&ast.Field{Names:[]*ast.Ident{ast.NewIdent("stockMode")},Type:ast.NewIdent("string")})};fn.Type.Results=&ast.FieldList{List:[]*ast.Field{{Type:ast.NewIdent("error")}}};if name=="RevertTssMoney"||name=="RevertTssPoints"{count:=0;ast.Inspect(fn.Body,func(n ast.Node)bool{literal,ok:=n.(*ast.BasicLit);if ok&&literal.Kind==token.STRING&&literal.Value==strconv.Quote("2006-02-01"){literal.Value=strconv.Quote("2006-01-02");count++};return true});if count!=2{panic("pinned wallet expiry boundary changed")}};rewrite(fn.Body,name);if name!="OrderAndStockConfirmed"&&name!="ExchangeOrderAndStockConfirmed"{fn.Body.List=append(fn.Body.List,stmt("return nil"))};declarations=append(declarations,fn)}
	if len(declarations)!=len(wanted){panic("pinned source function missing")}
	orderRaw,e:=os.ReadFile(*orderInput);if e!=nil{panic("pinned order source missing")};orderSum:=sha256.Sum256(orderRaw);if *orderExpected==""||hex.EncodeToString(orderSum[:])!=*orderExpected{panic("pinned order source hash mismatch")};orders,e:=parser.ParseFile(fs,*orderInput,orderRaw,0);if e!=nil{panic("pinned order source invalid")}
	builders:=0;for _,d:=range orders.Decls{fn,ok:=d.(*ast.FuncDecl);if !ok||fn.Name.Name!="CreateOrder"&&fn.Name.Name!="CreateOrderGokwik"{continue};name:=fn.Name.Name
		var body []ast.Stmt;for _,s:=range fn.Body.List{text:=render(s);if strings.HasPrefix(text,"resp, body, errs :=")||strings.HasPrefix(text,"jsonDataPost,")||strings.HasPrefix(text,"b, err := json.Marshal(order)"){break};if strings.HasPrefix(text,"request :="){continue};body=append(body,s)}
		fn.Body.List=body;rewrite(fn.Body,name);fn.Name.Name="buildOtherOrigin"+name;fn.Type.Params.List=append([]*ast.Field{{Names:[]*ast.Ident{ast.NewIdent("Db")},Type:expr("*gorm.DB")}},fn.Type.Params.List...)
		resultType:="map[string]string";returned:="post";if name=="CreateOrderGokwik"{resultType="map[string]interface{}";returned="order"};fn.Type.Results=&ast.FieldList{List:[]*ast.Field{{Type:expr(resultType)},{Type:ast.NewIdent("error")}}};fn.Body.List=append(fn.Body.List,stmt("return "+returned+",nil"));declarations=append(declarations,fn);builders++
	};if builders!=2{panic("pinned provider builders missing")}
	// A source gift-card status is provenance, never inferred exhaustion.
	for _,d:=range declarations{ast.Inspect(d,func(n ast.Node)bool{call,ok:=n.(*ast.CallExpr);if !ok{return true};if strings.Contains(render(call),`Db.Model(&gf).Limit(1).Update("status", 1)`){call.Args[1]=expr("gf.Status")};return true})}
	used:=map[string]bool{};for _,d:=range declarations{ast.Inspect(d,func(n ast.Node)bool{if s,ok:=n.(*ast.SelectorExpr);ok{if x,ok:=s.X.(*ast.Ident);ok{used[x.Name]=true}};if _,ok:=n.(*ast.GoStmt);ok{panic("uncaptured goroutine")};return true})};paths:=map[string]string{"fmt":"fmt","math":"math","os":"os","strings":"strings","strconv":"strconv","time":"time","json":"encoding/json","gorm":"github.com/jinzhu/gorm","poscheckout":"backend-tss-domestic_payments_api/internal/poscheckout"};var names []string;for n:=range paths{if used[n]{names=append(names,n)}};sort.Strings(names);var imports []ast.Spec;for _,n:=range names{imports=append(imports,&ast.ImportSpec{Path:&ast.BasicLit{Kind:token.STRING,Value:strconv.Quote(paths[n])}})}
	declarations=append([]ast.Decl{&ast.GenDecl{Tok:token.IMPORT,Specs:imports}},declarations...);var out bytes.Buffer;if format.Node(&out,token.NewFileSet(),&ast.File{Name:ast.NewIdent("juspay"),Decls:declarations})!=nil{panic("owned output formatting failed")};fmt.Println("// Generated from pinned payments 434f3e438d1cb48c64e5723222c6efda506db571. Online branches retained.");os.Stdout.Write(out.Bytes())
}
