package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	mysql "github.com/go-sql-driver/mysql"
)

// Existing disposable native source stage only. No schema/app initialization,
// source Python deduction, payment provider, broker or credential logging.
func TestImportCouponExistingSource(t *testing.T) {
	if os.Getenv("POS_IMPORT_COUPON_GO_FIXTURE") != "1" {
		t.Skip("explicit local coupon bridge only")
	}
	var input struct {
		URL        string          `json:"url"`
		AuthKey    string          `json:"authKey"`
		ProofKey   string          `json:"proofKey"`
		OrderID    int64           `json:"orderId"`
		Capability json.RawMessage `json:"capability"`
		Selected   bool            `json:"selected"`
		Contenders int             `json:"contenders"`
		Mutation   string          `json:"mutation"`
		Reject     bool            `json:"reject"`
		Replay     bool            `json:"replay"`
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 32000))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || input.OrderID < 1 || input.Contenders < 1 || input.Contenders > 20 {
		t.Fatal("invalid local coupon bridge input")
	}
	u, err := url.Parse(input.URL)
	if err != nil || u.Scheme != "mysql" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.User == nil || u.RawQuery != "" || u.Fragment != "" || !regexp.MustCompile(`^/pos_rewrite_import_runtime_[a-f0-9]{12}$`).MatchString(u.Path) {
		t.Fatal("disposable localhost coupon schema required")
	}
	port := u.Port()
	if port == "" {
		port = "3306"
	}
	password, _ := u.User.Password()
	config := mysql.NewConfig()
	config.User, config.Passwd = u.User.Username(), password
	config.Net, config.Addr = "tcp", net.JoinHostPort(u.Hostname(), port)
	config.DBName, config.ParseTime, config.Loc = strings.TrimPrefix(u.Path, "/"), true, time.UTC
	config.Timeout, config.ReadTimeout, config.WriteTimeout = 5*time.Second, 20*time.Second, 20*time.Second
	db, err := sql.Open("mysql", config.FormatDSN())
	if err != nil {
		t.Fatal("local coupon connection unavailable")
	}
	defer db.Close()
	t.Setenv("POS_LEGACY_IMPORT_KEY", input.AuthKey)
	t.Setenv("POS_LEGACY_IMPORT_PROOF_KEY", input.ProofKey)
	t.Setenv("POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT", poscheckout.LegacyImportContract)
	t.Setenv("POS_LEGACY_IMPORT_COUPON_CONSUMPTION_CONTRACT", "")
	if input.Selected {
		t.Setenv("POS_LEGACY_IMPORT_COUPON_CONSUMPTION_CONTRACT", poscheckout.ImportCouponConsumptionContract)
	}
	t.Setenv("POS_MEMBERSHIP_PROOF_KEY", strings.Repeat("fixture-member-proof-", 3))
	t.Setenv("POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT", poscheckout.MembershipFenceContract)
	t.Setenv("POS_MEMBERSHIP_PRODUCT_IDS", "[]")
	for _, name := range []string{"EXCLUSIVE_PRODUCT_ID", "EXCLUSIVE_99_PRODUCT_ID", "EXCLUSIVE_QUARTERLY_ID", "EXCLUSIVE_QUARTERLY_ID_FREE", "EXCLUSIVE_UPGRADE_IDS"} {
		t.Setenv(name, "")
	}
	ctx, err := poscheckout.WithLegacyImport(context.Background(), base64.RawURLEncoding.EncodeToString(input.Capability), input.AuthKey, time.Now())
	if err != nil {
		t.Fatal("local coupon capability refused")
	}
	var calls, created, refused int64
	var group sync.WaitGroup
	for index := 0; index < input.Contenders; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			result, err := poscheckout.Confirm(ctx, db, input.OrderID, poscheckout.DefaultHashes, func(tx *sql.Tx) error {
				atomic.AddInt64(&calls, 1)
				if err := sourceApply(tx, int(input.OrderID), false); err != nil {
					return err
				}
				var statement string
				switch input.Mutation {
				case "":
					return nil
				case "double-deduction":
					statement = `UPDATE coupons_users SET coupon_used_count=coupon_used_count+1 WHERE user_id=77 AND c_id=222`
				case "missing-log":
					statement = `DELETE FROM order_coupon_log WHERE order_id=5001`
				case "wrong-log":
					statement = `UPDATE order_coupon_log SET coupon_id=223 WHERE order_id=5001`
				case "header":
					statement = `UPDATE orders SET currency='USD' WHERE id=5001`
				case "line":
					statement = `UPDATE has_products SET disc=disc+1 WHERE order_id=5001`
				case "allowance":
					statement = `UPDATE coupons_users SET coupon_allowed_count=coupon_allowed_count+1 WHERE user_id=77 AND c_id=222`
				default:
					return poscheckout.ErrReview
				}
				_, err = tx.Exec(statement)
				return err
			})
			if err != nil {
				atomic.AddInt64(&refused, 1)
				return
			}
			if result.Created {
				atomic.AddInt64(&created, 1)
			}
		}()
	}
	group.Wait()
	if input.Reject {
		if refused != int64(input.Contenders) || created != 0 {
			t.Fatal("coupon refusal changed financial result")
		}
	} else {
		want := int64(1)
		if input.Replay {
			want = 0
		}
		if refused != 0 || created != want || calls != want {
			t.Fatalf("local coupon confirmation refused: calls=%d created=%d refused=%d", calls, created, refused)
		}
	}
	encoded, _ := json.Marshal(map[string]int64{"sourceCalls": calls, "created": created, "refused": refused})
	t.Log("COUPON_BRIDGE " + string(encoded))
}
