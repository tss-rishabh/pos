package juspay

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"backend-tss-domestic_payments_api/internal/poscheckout"
	"github.com/go-sql-driver/mysql"
	"github.com/jinzhu/gorm"
)

func originGatewayDB(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv("POS_ORIGIN_MYSQL_DSN")
	c, e := mysql.ParseDSN(raw)
	if e != nil || c.Net != "tcp" || c.Addr != "mysql:3306" || c.DBName != "pos_origin_contract_test" {
		t.Fatal("refusing non-isolated origin gateway database")
	}
	db, e := sql.Open("mysql", raw)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	orm, e := gorm.Open("mysql", db)
	if e != nil {
		t.Fatal(e)
	}
	orm.LogMode(false)
	for _, model := range []interface{}{&User{}, &JpCustomer{}, &JpOrder{}, &GokwikOrder{}} {
		if e = orm.DropTableIfExists(model).Error; e != nil {
			t.Fatal(e)
		}
		if e = orm.AutoMigrate(model).Error; e != nil {
			t.Fatal(e)
		}
	}
	if e = orm.Create(&User{Id: 77, Email: "fixture@example.test", Telephone: "9000000000"}).Error; e != nil {
		t.Fatal(e)
	}
	return db
}
func TestOriginGatewayLostOrderACKRecoversOnlyGET(t *testing.T) {
	db := originGatewayDB(t)
	var creates, customerWrites, orderReads atomic.Int64
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/customers/") {
			json.NewEncoder(w).Encode(map[string]interface{}{"id": "cust-real", "object_reference_id": "00000077", "email_address": "fixture@example.test", "mobile_number": "9000000000", "juspay": map[string]string{"client_auth_token": "retained-access"}})
			return
		}
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/customers") {
			customerWrites.Add(1)
			w.WriteHeader(500)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/orders" {
			creates.Add(1)
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/orders/700" {
			orderReads.Add(1)
			json.NewEncoder(w).Encode(map[string]interface{}{"id": "jp-existing", "order_id": "700", "customer_id": "cust-real", "status": "PENDING", "amount": 500})
			return
		}
		w.WriteHeader(400)
	}))
	defer server.Close()
	env := func(name string) string {
		switch name {
		case "JUSPAY_URL":
			return server.URL
		case "BASIC_AUTH":
			return "fixture-only"
		default:
			return ""
		}
	}
	g := &originGateway{db: db, env: env, client: server.Client()}
	request := poscheckout.OriginProviderRequest{Provider: "juspay", OrderID: "700", CustomerID: "77", CustomerFields: map[string]string{"email_address": "fixture@example.test", "mobile_number": "9000000000", "object_reference_id": "00000077"}, OrderFields: map[string]string{"order_id": "700", "amount": "500"}}
	if _, err := g.Start(context.Background(), request); err == nil {
		t.Fatal("lost create ACK was treated as successful")
	}
	recovered, err := g.Recover(context.Background(), request)
	if err != nil || recovered.Status != "PENDING" || recovered.ClientAuthToken != "retained-access" || recovered.ProviderReference != "jp-existing" {
		t.Fatalf("recovery %#v %v", recovered, err)
	}
	if creates.Load() != 1 || customerWrites.Load() != 0 || orderReads.Load() != 1 {
		t.Fatalf("provider requests creates=%d customerWrites=%d reads=%d", creates.Load(), customerWrites.Load(), orderReads.Load())
	}
	var count int
	if err = db.QueryRow(`SELECT COUNT(*) FROM jp_orders WHERE juspay_order='jp-existing'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("retained native order ACK: %d %v", count, err)
	}
}
func TestOriginGatewayDirectRecoveryCannotCreateCustomer(t *testing.T) {
	var reads, writes atomic.Int64
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			reads.Add(1)
		} else {
			writes.Add(1)
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	g := &originGateway{env: func(name string) string {
		if name == "JUSPAY_URL" {
			return server.URL
		}
		return "fixture-only"
	}, client: server.Client()}
	if _, err := g.Recover(context.Background(), poscheckout.OriginProviderRequest{Provider: "none", OrderID: "700", CustomerID: "77"}); err == nil {
		t.Fatal("missing provider customer recovered as DIRECT")
	}
	if reads.Load() != 1 || writes.Load() != 0 {
		t.Fatal("direct recovery created/updated a provider customer")
	}
}
