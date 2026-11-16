package sourcefixture

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"backend-tss-domestic_payments_api/internal/poscheckout"
	"github.com/gin-gonic/gin"
)

func TestActualSourceAuthenticationDoesNotLogCustomerJWTOrParserErrors(t *testing.T) {
	t.Setenv("JWT_KEY", "fixture-jwt-signing-key")
	t.Setenv("POS_CHECKOUT_PROJECTION_KEY", strings.Repeat("private-transport-key", 2))
	for _, valid := range []bool{false, true} {
		var logs bytes.Buffer
		router := gin.New()
		router.Use(poscheckout.PrivateHTTP(os.Getenv, &logs), AuthMiddleware())
		router.POST("/api/v2/payment/orders", func(c *gin.Context) {
			if valid {
				if subject, _ := c.Get("user_id"); subject != "CUSTOMER-SUBJECT-CANARY@example.test" {
					t.Error("source JWT semantics changed")
				}
				poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.OrderAuthorizationRejected)
			}
			c.Status(401)
		})
		token := "MALFORMED-JWT-CANARY@example.test"
		if valid {
			encoded := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"CUSTOMER-SUBJECT-CANARY@example.test","exp":4102444800}`))
			signature := hmac.New(sha256.New, []byte(os.Getenv("JWT_KEY")))
			_, _ = signature.Write([]byte(encoded))
			token = encoded + "." + base64.RawURLEncoding.EncodeToString(signature.Sum(nil))
		}
		request := httptest.NewRequest("POST", "/api/v2/payment/orders?phone=QUERY-CANARY", strings.NewReader(`{"email":"BODY-CANARY@example.test"}`))
		request.Header.Set("Authorization", token)
		request.Header.Set("Cookie", "session=COOKIE-CANARY")
		request.Header.Set("X-POS-Projection-Key", os.Getenv("POS_CHECKOUT_PROJECTION_KEY"))
		request.Header.Set("X-POS-Operator-ID", "44")
		router.ServeHTTP(httptest.NewRecorder(), request)
		for _, canary := range []string{token, "CUSTOMER-SUBJECT-CANARY", "MALFORMED-JWT-CANARY", "QUERY-CANARY", "BODY-CANARY", "COOKIE-CANARY", os.Getenv("POS_CHECKOUT_PROJECTION_KEY")} {
			if strings.Contains(logs.String(), canary) {
				t.Fatal("source auth logged private input")
			}
		}
		if !strings.Contains(logs.String(), "authentication-") || !strings.Contains(logs.String(), `"userId":"44"`) {
			t.Fatal("source auth lost its static trace event")
		}
	}
}
