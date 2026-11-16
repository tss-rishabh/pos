// This tool reads the pinned allocation AST. It never imports or starts the
// payments application. Output is written only to stdout for explicit review.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

var fileset = token.NewFileSet()
var oracle bool

func rendered(node interface{}) string {
	var output bytes.Buffer
	if err := printer.Fprint(&output, fileset, node); err != nil {
		panic(err)
	}
	return output.String()
}
func statement(source string) ast.Stmt {
	file, err := parser.ParseFile(token.NewFileSet(), "statement.go", "package p;func f(){"+source+"}", 0)
	if err != nil {
		panic(err)
	}
	return file.Decls[0].(*ast.FuncDecl).Body.List[0]
}
func isDatabase(expr ast.Expr) bool {
	switch value := expr.(type) {
	case *ast.Ident:
		return value.Name == "Db"
	case *ast.SelectorExpr:
		return isDatabase(value.X)
	case *ast.CallExpr:
		return isDatabase(value.Fun)
	}
	return false
}
func bindTransaction(node ast.Node) {
	ast.Inspect(node, func(node ast.Node) bool {
		selector, ok := node.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		global, ok := selector.X.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		identifier, ok := global.X.(*ast.Ident)
		if ok && identifier.Name == "utils" && global.Sel.Name == "Db" {
			selector.X = ast.NewIdent("Db")
		}
		return true
	})
}
func stripLogging(node ast.Node) {
	ast.Inspect(node, func(node ast.Node) bool {
		block, ok := node.(*ast.BlockStmt)
		if !ok {
			return true
		}
		var kept []ast.Stmt
		for _, stmt := range block.List {
			if expr, ok := stmt.(*ast.ExprStmt); ok {
				if call, ok := expr.X.(*ast.CallExpr); ok && strings.HasPrefix(rendered(call.Fun), "utils.") {
					continue
				}
			}
			kept = append(kept, stmt)
		}
		block.List = kept
		return true
	})
}
func rewriteBlock(block *ast.BlockStmt) {
	if block == nil {
		return
	}
	var result []ast.Stmt
	for _, original := range block.List {
		bindTransaction(original)
		switch value := original.(type) {
		case *ast.GoStmt:
			continue // Source effects are enqueued only after the transaction succeeds.
		case *ast.AssignStmt:
			if len(value.Lhs) == 1 {
				name := rendered(value.Lhs[0])
				if name == "shouldReduceStock" || name == "legacyDecrement" || name == "excludedAutoDeliverPM" {
					continue
				}
				if len(value.Rhs) == 1 && isDatabase(value.Rhs[0]) && !oracle {
					result = append(result, value, statement("if "+name+".Error != nil && !gorm.IsRecordNotFoundError("+name+".Error) { return "+name+".Error }"))
					continue
				}
			}
		case *ast.IfStmt:
			condition := rendered(value.Cond)
			if strings.Contains(condition, "len(reduceStock)") || strings.Contains(condition, "TRANS_LOCK_FEATURE") || strings.Contains(condition, "o.LocationID > 0") || strings.Contains(condition, "excludedAutoDeliverPM") || strings.HasPrefix(condition, "orderStore.StoreID == 0 &&") {
				continue
			}
			if strings.HasPrefix(condition, "orderStore.StoreID == 0 &&") {
				panic("online-only inventory branch must be removed")
			}
			// The only stock branch valid in this adapter is the receiving store.
			if strings.Contains(condition, "cartItem.OrderPlatform != 4") {
				if branch, ok := value.Else.(*ast.IfStmt); ok {
					rewriteBlock(branch.Body)
					result = append(result, branch.Body.List...)
					continue
				}
				panic("pinned POS inventory branch changed")
			}
			rewriteBlock(value.Body)
			if alternative, ok := value.Else.(*ast.BlockStmt); ok {
				rewriteBlock(alternative)
			}
			if alternative, ok := value.Else.(*ast.IfStmt); ok {
				container := &ast.BlockStmt{List: []ast.Stmt{alternative}}
				rewriteBlock(container)
				if len(container.List) == 1 {
					value.Else = container.List[0]
				} else {
					value.Else = &ast.BlockStmt{List: container.List}
				}
			}
			if condition == "err != nil" && len(value.Body.List) == 0 {
				value.Body.List = []ast.Stmt{statement("return err")}
			}
			if len(value.Body.List) == 0 && value.Else == nil {
				continue
			}
		case *ast.RangeStmt:
			rewriteBlock(value.Body)
		case *ast.ForStmt:
			rewriteBlock(value.Body)
		case *ast.BlockStmt:
			rewriteBlock(value)
		case *ast.ReturnStmt:
			if len(value.Results) == 1 {
				if rendered(value.Results[0]) == "false" {
					value.Results = []ast.Expr{ast.NewIdent("errPOSCheckoutReview")}
				}
				if rendered(value.Results[0]) == "true" {
					value.Results = []ast.Expr{ast.NewIdent("nil")}
				}
			}
		case *ast.ExprStmt:
			call, ok := value.X.(*ast.CallExpr)
			if !ok {
				break
			}
			function := rendered(call.Fun)
			wasDatabase := isDatabase(call)
			if strings.HasPrefix(function, "utils.") {
				continue
			}
			if function == "productStore.ReduceStoreStock" {
				result = append(result, statement("if err := reducePOSCheckoutStock(Db, &productStore, cartItem.Quantity); err != nil { return err }"))
				continue
			}
			if selector, ok := call.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "Create" && len(call.Args) == 1 {
				if root, ok := selector.X.(*ast.Ident); ok && root.Name == "Db" {
					call.Fun = ast.NewIdent("createPOSCheckoutRecord")
					call.Args = append([]ast.Expr{ast.NewIdent("Db")}, call.Args...)
				}
			}
			if wasDatabase && !oracle {
				// Preserve all source expressions and argument evaluation. Only
				// add the missing error check around the exact database call.
				result = append(result, statement("if result := "+rendered(call)+"; result.Error != nil { return result.Error }"))
				continue
			}
		}
		result = append(result, original)
	}
	block.List = result
}

func main() {
	input := flag.String("input", "", "pinned model.go path")
	models := flag.Bool("models", false, "emit isolated source models/helpers too")
	flag.BoolVar(&oracle, "oracle", false, "preserve original unchecked successful-case database calls")
	flag.Parse()
	file, err := parser.ParseFile(fileset, *input, nil, 0)
	if err != nil {
		panic(err)
	}
	var method *ast.FuncDecl
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Name.Name == "OrderAndStockConfirmed" {
			method = fn
			break
		}
	}
	if method == nil {
		panic("pinned source allocation method missing")
	}
	method.Name.Name = "applyPOSCheckoutSource"
	if oracle {
		method.Name.Name = "applyPOSCheckoutOracle"
	}
	method.Type.Params.List = method.Type.Params.List[:1]
	method.Type.Results.List[0].Type = ast.NewIdent("error")
	// Resolve the POS stock branch before dropping other online-only branches.
	ast.Inspect(method.Body, func(node ast.Node) bool {
		block, ok := node.(*ast.BlockStmt)
		if !ok {
			return true
		}
		for index, stmt := range block.List {
			branch, ok := stmt.(*ast.IfStmt)
			if !ok || !strings.Contains(rendered(branch.Cond), "cartItem.OrderPlatform != 4") {
				continue
			}
			pos, ok := branch.Else.(*ast.IfStmt)
			if !ok {
				panic("pinned POS branch missing")
			}
			block.List[index] = pos.Body
		}
		return true
	})
	rewriteBlock(method.Body)
	// Source temporarily activates purchased cards for unpaid COC. The old POS
	// application immediately disables them; keep them disabled in the atomic
	// adapter itself until the actual paid/delivered settlement.
	ast.Inspect(method.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) < 2 {
			return true
		}
		literal, ok := call.Args[0].(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		value, _ := strconv.Unquote(literal.Value)
		if value == "UPDATE gift_vouchers SET status = 1 WHERE order_id = ?" && !oracle {
			literal.Value = strconv.Quote("UPDATE gift_vouchers SET status = CASE WHEN ?=4 AND ?=3 THEN 1 ELSE 0 END WHERE order_id = ?")
			call.Args = []ast.Expr{literal, ast.NewIdent("payment_status"), ast.NewIdent("order_status"), call.Args[1]}
		}
		return true
	})
	declarations := []ast.Decl{method}
	if *models {
		wanted := map[string]bool{"Order": true, "OrderStore": true, "User": true, "RewardPointHistory": true, "TssMoneyHistory": true, "OrderTssMoney": true, "TssPointHistory": true, "OrderTssPoint": true, "GiftVoucher": true, "GiftVoucherHistory": true, "OrderCouponLog": true, "HasProduct": true, "Product": true, "ProductStore": true, "UserEAV": true, "Comment": true}
		var selected []ast.Decl
		for _, decl := range file.Decls {
			switch value := decl.(type) {
			case *ast.GenDecl:
				var specs []ast.Spec
				for _, spec := range value.Specs {
					if item, ok := spec.(*ast.TypeSpec); ok && wanted[item.Name.Name] {
						specs = append(specs, item)
					}
					if item, ok := spec.(*ast.ValueSpec); ok && len(item.Names) > 0 && strings.HasPrefix(item.Names[0].Name, "PaymentMethod") {
						specs = append(specs, item)
					}
				}
				if len(specs) > 0 {
					selected = append(selected, &ast.GenDecl{Tok: value.Tok, Specs: specs})
				}
			case *ast.FuncDecl:
				if value.Recv == nil && (value.Name.Name == "contains" || value.Name.Name == "listContains" || value.Name.Name == "getExpiryDelta") {
					stripLogging(value.Body)
					selected = append(selected, value)
				}
				if value.Recv != nil && value.Name.Name == "TableName" {
					typeName := strings.TrimPrefix(rendered(value.Recv.List[0].Type), "*")
					if wanted[typeName] {
						selected = append(selected, value)
					}
				}
			}
		}
		declarations = append(selected, declarations...)
	}
	used := map[string]bool{}
	for _, decl := range declarations {
		ast.Inspect(decl, func(node ast.Node) bool {
			if selector, ok := node.(*ast.SelectorExpr); ok {
				if name, ok := selector.X.(*ast.Ident); ok {
					used[name.Name] = true
				}
			}
			return true
		})
	}
	paths := map[string]string{"fmt": "fmt", "math": "math", "os": "os", "strings": "strings", "time": "time", "gorm": "github.com/jinzhu/gorm"}
	var names []string
	for name := range paths {
		if used[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	var imports []ast.Spec
	for _, name := range names {
		imports = append(imports, &ast.ImportSpec{Path: &ast.BasicLit{Kind: token.STRING, Value: strconv.Quote(paths[name])}})
	}
	if len(imports) > 0 {
		declarations = append([]ast.Decl{&ast.GenDecl{Tok: token.IMPORT, Specs: imports}}, declarations...)
	}
	packageName := "juspay"
	if *models {
		packageName = "sourcefixture"
	}
	output := &ast.File{Name: ast.NewIdent(packageName), Decls: declarations}
	positionType := reflect.TypeOf(token.NoPos)
	ast.Inspect(output, func(node ast.Node) bool {
		if node == nil {
			return true
		}
		value := reflect.ValueOf(node).Elem()
		for index := 0; index < value.NumField(); index++ {
			field := value.Field(index)
			if field.CanSet() && field.Type() == positionType {
				field.SetInt(0)
			}
		}
		return true
	})
	var buffer bytes.Buffer
	if err = format.Node(&buffer, token.NewFileSet(), output); err != nil {
		panic(err)
	}
	fmt.Println("// Generated from payments 434f3e438d1cb48c64e5723222c6efda506db571. Allocation expressions are source-owned.")
	os.Stdout.Write(buffer.Bytes())
}
