package poscheckout

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInternalProjectionKey(t *testing.T) {
	key := strings.Repeat("fixture-pos-projection-key", 2)
	if !ProjectionKeyValid(key, key) {
		t.Fatal("valid private app key rejected")
	}
	for _, provided := range []string{"", key + "x", strings.Repeat("x", len(key)), key[:len(key)-1]} {
		if ProjectionKeyValid(key, provided) {
			t.Fatal("invalid app key accepted")
		}
	}
	if ProjectionKeyValid("short", "short") {
		t.Fatal("short configured key accepted")
	}
}
func TestSourcePostcommitPayloadsAndRequestCorrelation(t *testing.T) {
	var requests []map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Request-ID") != "request-fixture" || request.Header.Get("Idempotency-Key") != "job-fixture" {
			t.Error("delivery correlation was lost")
		}
		if request.Method == "POST" {
			var value map[string]interface{}
			if err := json.NewDecoder(request.Body).Decode(&value); err != nil {
				t.Error(err)
			}
			requests = append(requests, value)
		} else {
			requests = append(requests, map[string]interface{}{"path": request.URL.Path})
		}
		writer.WriteHeader(204)
	}))
	defer server.Close()
	env := func(name string) string {
		if name == "POST_ORDER_APP_ID" {
			return "fixture-app"
		}
		if name == "POST_ORDER_APP_KEY" {
			return "fixture-secret"
		}
		return server.URL + "/"
	}
	handlers, err := HTTPHandlers(env, true)
	if err != nil {
		t.Fatal(err)
	}
	effect := Effect{ID: "job-fixture", OrderID: 5001, UserID: 77, Resource: "order-engagement", Payload: EffectPayload{ProductID: 10}, RequestID: "request-fixture"}
	for _, name := range []string{"order-engagement", "order-producer", "order-email", "freebie-count", "inventory-sync", "store-utm"} {
		if err = handlers[name](context.Background(), effect); err != nil {
			t.Fatal(err)
		}
	}
	expected := []map[string]interface{}{{"order_id": float64(5001)}, {"payload": float64(5001)}, {"orderId": float64(5001)}, {"order_id": float64(5001), "change_type": "incr"}, {"path": "/10"}, {"path": "/5001"}}
	left, _ := json.Marshal(requests)
	right, _ := json.Marshal(expected)
	if string(left) != string(right) {
		t.Fatalf("source notification payloads changed: %s", left)
	}
}
func TestDeliveryURLsAndRedirectsNeverLeakCredentials(t *testing.T) {
	for _, raw := range []string{"http://external.example.test/", "https://user:secret@example.test/", "file:///tmp/target"} {
		if _, err := HTTPHandlers(func(string) string { return raw }, false); err == nil {
			t.Fatal("unsafe URL accepted")
		}
	}
	called := false
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, destination.URL, 302)
	}))
	defer redirect.Close()
	handlers, err := HTTPHandlers(func(string) string { return redirect.URL }, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = handlers["order-engagement"](context.Background(), Effect{ID: "fixture", OrderID: 5001, UserID: 77}); err == nil || called {
		t.Fatal("redirect was followed")
	}
}
func TestDeliveryLogsHaveSafeActorResourceAndRequestFields(t *testing.T) {
	var buffer bytes.Buffer
	actor := int64(44)
	LogOutcome(&buffer, Outcome{Effect: Effect{ID: "fixture", OrderID: 5001, UserID: 77, OperatorID: &actor, Resource: "order-engagement", RequestID: "request-fixture"}, Status: "uncertain"})
	var value map[string]interface{}
	if err := json.Unmarshal(buffer.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	if value["eventId"] != "payments.pos-checkout-order-engagement.uncertain" || value["resource"] != "pos-checkout-order-engagement" || value["requestId"] != "request-fixture" || value["userId"] != float64(44) || value["eventInstanceId"] == "" {
		t.Fatal("delivery trace fields missing")
	}
	if strings.Contains(buffer.String(), "secret") || strings.Contains(buffer.String(), "payload") || strings.Contains(buffer.String(), "http") {
		t.Fatal("sensitive delivery details were logged")
	}
}
