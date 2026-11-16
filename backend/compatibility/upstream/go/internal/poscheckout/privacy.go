package poscheckout

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// EventKind is a closed catalog. Request data and error strings cannot become
// messages, resources, event names or attributes through this interface.
type EventKind uint8

const (
	RequestCompleted EventKind = iota + 1
	RequestPanicked
	AuthenticationRejected
	AuthenticationAccepted
	OrderValidationRejected
	OrderNotFound
	OrderAuthorizationRejected
	OrderAuthorizationAccepted
)

type HTTPEvent struct {
	Module    string  `json:"module"`
	Resource  string  `json:"resource"`
	EventID   string  `json:"eventId"`
	RequestID string  `json:"requestId"`
	UserID    *string `json:"userId"`
}

type privateHTTPKey struct{}
type privateHTTPState struct {
	authorized bool
	requestID  string
	operatorID *string
	resource   string
	emit       func(HTTPEvent)
}

var safeTraceID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
var safeOperatorID = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

// PrivateHTTP replaces BOTH gin.Default's request/recovery middleware and any
// additional gin.Recovery installed by the pinned service. It never formats a
// request, URL, header, body, recovered value, raw error or stack. Source handlers
// outside the audited POS confirmation path still need their own logging audit.
func PrivateHTTP(env func(string) string, output io.Writer) gin.HandlerFunc {
	var write sync.Mutex
	emit := func(event HTTPEvent) {
		if output == nil {
			return
		}
		encoded, err := json.Marshal(event)
		if err != nil {
			return
		}
		write.Lock()
		defer write.Unlock()
		_, _ = output.Write(append(encoded, '\n'))
	}
	return func(c *gin.Context) {
		// Validate once and remove the secret before auth, handlers or diagnostic
		// middleware can observe it. The authorization bit is request-scoped.
		authorized := ProjectionKeyValid(env("POS_CHECKOUT_PROJECTION_KEY"), c.GetHeader("X-POS-Projection-Key"))
		c.Request.Header.Del("X-POS-Projection-Key")
		consentRaw := c.GetHeader("X-POS-Customer-Consent")
		c.Request.Header.Del("X-POS-Customer-Consent")
		requestID := c.GetHeader("X-Request-ID")
		if !safeTraceID.MatchString(requestID) {
			var random [16]byte
			if _, err := rand.Read(random[:]); err != nil {
				// Fail closed if an independent correlation ID cannot be created.
				c.AbortWithStatus(http.StatusServiceUnavailable)
				return
			}
			requestID = hex.EncodeToString(random[:])
		}
		c.Request.Header.Set("X-Request-ID", requestID)
		var operatorID *string
		if value := c.GetHeader("X-POS-Operator-ID"); authorized && safeOperatorID.MatchString(value) {
			operatorID = &value
		}
		resource := "http-requests"
		if c.Request.Method == http.MethodPost && c.Request.URL.Path == "/api/v2/payment/orders" {
			resource = "checkout-confirmations"
		}
		state := privateHTTPState{authorized: authorized, requestID: requestID, operatorID: operatorID, resource: resource, emit: emit}
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), privateHTTPKey{}, state))
		if consentRaw != "" && authorized {
			actor := ""
			if operatorID != nil {
				actor = *operatorID
			}
			checked, _ := WithCustomerConsent(c.Request.Context(), consentRaw, env("POS_CHECKOUT_PROJECTION_KEY"), actor, time.Now())
			c.Request = c.Request.WithContext(checked)
		}
		defer func() {
			if recovered := recover(); recovered != nil {
				RecordHTTPEvent(c.Request.Context(), RequestPanicked)
				c.AbortWithStatus(http.StatusInternalServerError)
				return
			}
			RecordHTTPEvent(c.Request.Context(), RequestCompleted)
		}()
		c.Next()
	}
}

func ProjectionAuthorized(ctx context.Context) bool {
	state, ok := ctx.Value(privateHTTPKey{}).(privateHTTPState)
	return ok && state.authorized
}

// OperatorID is correlation metadata accepted only with the independent app
// key. Customer JWT subjects are not substituted for the initiating operator.
func OperatorID(ctx context.Context) *string {
	state, ok := ctx.Value(privateHTTPKey{}).(privateHTTPState)
	if !ok || state.operatorID == nil {
		return nil
	}
	value := *state.operatorID
	return &value
}

func RecordHTTPEvent(ctx context.Context, kind EventKind) {
	state, ok := ctx.Value(privateHTTPKey{}).(privateHTTPState)
	if !ok {
		return
	}
	suffix := ""
	switch kind {
	case RequestCompleted:
		suffix = "request-completed"
	case RequestPanicked:
		suffix = "request-panicked"
	case AuthenticationRejected:
		suffix = "authentication-rejected"
	case AuthenticationAccepted:
		suffix = "authentication-accepted"
	case OrderValidationRejected:
		suffix = "validation-rejected"
	case OrderNotFound:
		suffix = "order-not-found"
	case OrderAuthorizationRejected:
		suffix = "authorization-rejected"
	case OrderAuthorizationAccepted:
		suffix = "authorization-accepted"
	default:
		return
	}
	state.emit(HTTPEvent{Module: "payments", Resource: state.resource, EventID: "payments." + state.resource + "." + suffix, RequestID: state.requestID, UserID: state.operatorID})
}
