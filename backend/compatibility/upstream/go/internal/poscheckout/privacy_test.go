package poscheckout

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestPrivateHTTPDoesNotDumpSecretsPIIOrRawFailures(t *testing.T) {
	oldMode := gin.Mode()
	oldOutput, oldErrors := gin.DefaultWriter, gin.DefaultErrorWriter
	t.Cleanup(func() {
		gin.SetMode(oldMode)
		gin.DefaultWriter, gin.DefaultErrorWriter = oldOutput, oldErrors
	})
	for _, mode := range []string{gin.DebugMode, gin.ReleaseMode} {
		for _, outcome := range []string{"success", "rejected", "panic", "broken-pipe", "error-list"} {
			t.Run(mode+"/"+outcome, func(t *testing.T) {
				gin.SetMode(mode)
				var logs, defaults bytes.Buffer
				gin.DefaultWriter, gin.DefaultErrorWriter = &defaults, &defaults
				key := "PRIVATE-PROJECTION-KEY-CANARY-00000000000000"
				router := gin.New()
				router.Use(PrivateHTTP(func(string) string { return key }, &logs))
				router.POST("/api/v2/payment/orders", func(c *gin.Context) {
					if c.GetHeader("X-POS-Projection-Key") != "" || c.GetHeader("X-POS-Customer-Consent") != "" || !ProjectionAuthorized(c.Request.Context()) {
						t.Error("private transport authorization was lost or raw header survived")
					}
					switch outcome {
					case "rejected":
						var body struct {
							Order int `json:"order" binding:"required"`
						}
						if err := c.ShouldBindJSON(&body); err != nil {
							RecordHTTPEvent(c.Request.Context(), OrderValidationRejected)
							c.AbortWithStatus(400)
						}
					case "panic":
						panic("PANIC-RAW-ERROR-CANARY alice@example.test")
					case "broken-pipe":
						panic(&net.OpError{Op: "write", Net: "tcp", Err: &os.SyscallError{Syscall: "BROKEN-CONNECTION-CANARY", Err: syscall.EPIPE}})
					case "error-list":
						_ = c.Error(errors.New("SQL-ERROR-CANARY alice@example.test"))
						c.Status(503)
					default:
						c.Status(201)
					}
				})
				request := httptest.NewRequest("POST", "/api/v2/payment/orders?email=QUERY-CANARY%40example.test", strings.NewReader(`{"order":"BODY-CANARY@example.test"}`))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Authorization", "JWT-HEADER-CANARY")
				request.Header.Set("Cookie", "session=COOKIE-CANARY")
				request.Header.Set("User-Agent", "USER-AGENT-CANARY")
				request.Header.Set("X-POS-Projection-Key", key)
				request.Header.Set("X-POS-Customer-Consent", "PRIVATE-CUSTOMER-CONSENT-CANARY")
				request.Header.Set("X-Request-ID", "privacy-fixture-request")
				request.Header.Set("X-POS-Operator-ID", "44")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if (outcome == "panic" || outcome == "broken-pipe") && response.Code != 500 {
					t.Fatal("panic did not preserve a failed HTTP outcome")
				}
				combined := logs.String() + defaults.String() + response.Body.String()
				for _, canary := range []string{key, "PRIVATE-CUSTOMER-CONSENT-CANARY", "QUERY-CANARY", "BODY-CANARY", "COOKIE-CANARY", "JWT-HEADER-CANARY", "USER-AGENT-CANARY", "PANIC-RAW-ERROR-CANARY", "BROKEN-CONNECTION-CANARY", "SQL-ERROR-CANARY", "alice@example.test"} {
					if strings.Contains(combined, canary) {
						t.Fatalf("private value reached an output: %s", canary)
					}
				}
				for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
					var event map[string]json.RawMessage
					if err := json.Unmarshal([]byte(line), &event); err != nil || len(event) != 5 {
						t.Fatal("log event escaped its closed schema")
					}
					if string(event["module"]) != `"payments"` || string(event["resource"]) != `"checkout-confirmations"` || string(event["requestId"]) != `"privacy-fixture-request"` || string(event["userId"]) != `"44"` {
						t.Fatal("safe initiating context missing")
					}
				}
			})
		}
	}
}

func TestPrivateHTTPDoesNotTrustActorWithoutIndependentProjectionKey(t *testing.T) {
	var logs bytes.Buffer
	router := gin.New()
	router.Use(PrivateHTTP(func(string) string { return strings.Repeat("x", 32) }, &logs))
	router.POST("/api/v2/payment/orders", func(c *gin.Context) {
		if ProjectionAuthorized(c.Request.Context()) || c.GetHeader("X-POS-Projection-Key") != "" {
			t.Error("untrusted app authorization survived")
		}
		RecordHTTPEvent(c.Request.Context(), EventKind(255))
		c.Status(401)
	})
	request := httptest.NewRequest("POST", "/api/v2/payment/orders", nil)
	request.Header.Set("X-POS-Projection-Key", "INVALID-KEY-CANARY")
	request.Header.Set("X-Request-ID", "EMAIL-CANARY@example.test")
	request.Header.Set("X-POS-Operator-ID", "99")
	router.ServeHTTP(httptest.NewRecorder(), request)
	var event HTTPEvent
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &event); err != nil {
		t.Fatal(err)
	}
	if event.UserID != nil || len(event.RequestID) != 32 || strings.Contains(logs.String(), "CANARY") {
		t.Fatal("untrusted correlation data was logged")
	}
}
