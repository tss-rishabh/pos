package poscheckout

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type deliveryTarget struct {
	resource, key, method string
	appendID              bool
}

var targets = []deliveryTarget{
	{"inventory-sync", "POS_PRODUCT_SYNC", "GET", true},
	{"welcome-exclusive", "WELCOME_EXCLUSIVE", "POST", false},
	{"order-producer", "ORDER_PRODUCER_URL", "POST", false},
	{"order-engagement", "ORDER_EM_CHK_URL", "POST", false},
	{"gift-voucher-check", "ORDER_GV_CHK_URL", "POST", false},
	{"auto-deliver", "AUTODELIVER_URL", "POST", false},
	{"order-email", "ORDER_EMAIL", "POST", false},
	{"gift-voucher-emails", "GIFTVOUCHER_EMAILS", "POST", false},
	{"store-utm", "STORE_UTM", "GET", true},
	{"freebie-count", "FREEBIE_COUNT", "POST", false},
}

// HTTPHandlers never reads a URL from a job or request. Empty integration keys
// leave jobs pending. An invalid configured URL is an explicit startup error;
// credentials, redirects, response bodies and raw errors are never logged.
func HTTPHandlers(env func(string) string, allowLoopback bool) (map[string]Handler, error) {
	result := map[string]Handler{}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return ErrReview }}
	for _, target := range targets {
		if target.resource == "order-producer" && (env("POST_ORDER_APP_ID") == "" || env("POST_ORDER_APP_KEY") == "") {
			continue
		}
		raw := env(target.key)
		if raw == "" {
			continue
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.User != nil || parsed.Fragment != "" || (parsed.Scheme != "https" && !(allowLoopback && parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1"))) {
			return nil, ErrReview
		}
		selected, endpoint := target, raw
		result[selected.resource] = func(ctx context.Context, effect Effect) error {
			destination := endpoint
			if selected.appendID {
				id := effect.OrderID
				if selected.resource == "inventory-sync" {
					id = effect.Payload.ProductID
				}
				if id < 1 {
					return Rejected{}
				}
				destination += fmt.Sprint(id)
			}
			var body io.Reader
			if selected.method == "POST" {
				payload := map[string]interface{}{"order_id": effect.OrderID}
				if selected.resource == "order-producer" {
					payload = map[string]interface{}{"payload": effect.OrderID}
				}
				if selected.resource == "welcome-exclusive" || selected.resource == "order-email" || selected.resource == "gift-voucher-emails" {
					payload = map[string]interface{}{"orderId": effect.OrderID}
				}
				if selected.resource == "freebie-count" {
					payload["change_type"] = "incr"
				}
				encoded, err := json.Marshal(payload)
				if err != nil {
					return err
				}
				body = bytes.NewReader(encoded)
			}
			request, err := http.NewRequestWithContext(ctx, selected.method, destination, body)
			if err != nil {
				return err
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Idempotency-Key", effect.ID)
			if effect.RequestID != "" {
				request.Header.Set("X-Request-ID", effect.RequestID)
			}
			if selected.resource == "order-producer" {
				app, key := env("POST_ORDER_APP_ID"), env("POST_ORDER_APP_KEY")
				if app == "" || key == "" {
					return Rejected{}
				}
				request.Header.Set("ar-app-id", app)
				request.Header.Set("ar-app-key", key)
			}
			response, err := client.Do(request)
			if err != nil {
				return err
			}
			defer response.Body.Close()
			if _, err = io.Copy(io.Discard, io.LimitReader(response.Body, 2*1024*1024)); err != nil {
				return err
			}
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				return nil
			}
			if response.StatusCode >= 400 && response.StatusCode < 500 {
				return Rejected{}
			}
			return ErrReview
		}
	}
	// Redis's historical user-only lock has no order token. It is deliberately
	// not treated as a safe delayed/retryable HTTP notification.
	return result, nil
}

func LogOutcome(writer io.Writer, value Outcome) {
	if !resources[value.Effect.Resource] || !strings.Contains("|delivered|rejected|uncertain|", "|"+value.Status+"|") {
		return
	}
	event := struct {
		EventID, EventInstanceID, Module, Resource, RequestID string
		UserID, OrderID                                       int64
		DeliveryID                                            string
	}{
		EventID:         "payments.pos-checkout-" + value.Effect.Resource + "." + value.Status,
		EventInstanceID: fmt.Sprintf("%s:%d", value.Effect.ID, time.Now().UnixNano()), Module: "payments", Resource: "pos-checkout-" + value.Effect.Resource, RequestID: value.Effect.RequestID, UserID: value.Effect.UserID, OrderID: value.Effect.OrderID, DeliveryID: value.Effect.ID,
	}
	// Map keys intentionally use the same lower-camel fields as the rewrite logs.
	encoded, err := json.Marshal(map[string]interface{}{"eventId": event.EventID, "eventInstanceId": event.EventInstanceID, "module": event.Module, "resource": event.Resource, "requestId": event.RequestID, "userId": value.Effect.OperatorID, "orderId": event.OrderID, "deliveryId": event.DeliveryID})
	if err == nil {
		writer.Write(append(encoded, '\n'))
	}
}
