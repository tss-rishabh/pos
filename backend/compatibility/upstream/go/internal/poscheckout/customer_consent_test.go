package poscheckout

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func consentTestWire(body []byte, key string) string {
	encoded := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(CustomerConsentContract + "\n" + encoded))
	return encoded + "." + hex.EncodeToString(mac.Sum(nil))
}
func TestCanonicalCustomerConsentMatchesNodeGoldenAndRejectsAmbiguousWire(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	key := "fixture-customer-consent-key-0123456789"
	value := CustomerConsent{V: 1, Contract: CustomerConsentContract, OrderID: "9007199254740993", CustomerID: "77", OperatorID: "44", StoreID: "1", CounterID: "3", Contact: ContactBinding{Revision: "18446744073709551615", Digest: strings.Repeat("a", 64)}, ExpiresAt: 1800000600000}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	wire := consentTestWire(body, key)
	if strings.Split(wire, ".")[1] != "ce17285983289c285b035ca976be0d821ef607da9666e385890b3186ab50c80d" {
		t.Fatal("Node and Go canonical proof bytes differ")
	}
	if _, err := WithCustomerConsent(context.Background(), wire, key, "44", now); err != nil {
		t.Fatal(err)
	}
	for _, change := range []string{"actor", "signature", "duplicate", "unknown", "whitespace", "padding", "expired", "future", "revision", "integer"} {
		t.Run(change, func(t *testing.T) {
			changed, actor := wire, "44"
			switch change {
			case "actor":
				actor = "45"
			case "signature":
				changed = consentTestWire(body, strings.Repeat("other-key", 8))
			case "duplicate":
				changed = consentTestWire([]byte(strings.Replace(string(body), `"v":1`, `"v":1,"v":1`, 1)), key)
			case "unknown":
				changed = consentTestWire([]byte(strings.Replace(string(body), `"v":1`, `"unknown":true,"v":1`, 1)), key)
			case "whitespace":
				changed = consentTestWire(append([]byte(" "), body...), key)
			case "padding":
				changed = strings.Split(wire, ".")[0] + "=." + strings.Split(wire, ".")[1]
			default:
				candidate := value
				switch change {
				case "expired":
					candidate.ExpiresAt = now.UnixMilli()
				case "future":
					candidate.ExpiresAt = now.UnixMilli() + 900001
				case "revision":
					candidate.Contact.Revision = "18446744073709551616"
				case "integer":
					candidate.OrderID = "9223372036854775808"
				}
				altered, _ := json.Marshal(candidate)
				changed = consentTestWire(altered, key)
			}
			ctx, err := WithCustomerConsent(context.Background(), changed, key, actor, now)
			if err == nil {
				t.Fatal("ambiguous or unbound wire was accepted")
			}
			state, _ := ctx.Value(consentKey{}).(consentState)
			if !state.invalid {
				t.Fatal("invalid proof lost its rejection marker")
			}
		})
	}
}
