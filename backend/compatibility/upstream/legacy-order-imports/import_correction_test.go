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
	"testing"
	"time"

	mysql "github.com/go-sql-driver/mysql"
)

// Existing disposable source order only. This runner creates no schema and
// imports no application initialization, network provider or real credentials.
func TestImportCorrectionExistingSource(t *testing.T) {
	if os.Getenv("POS_IMPORT_CORRECTION_GO_FIXTURE") != "1" {
		t.Skip("explicit local correction bridge only")
	}
	var input struct {
		URL        string          `json:"url"`
		AuthKey    string          `json:"authKey"`
		ProofKey   string          `json:"proofKey"`
		OrderID    int64           `json:"orderId"`
		Capability json.RawMessage `json:"capability"`
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 32000))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || input.OrderID < 1 {
		t.Fatal("invalid local correction bridge input")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		t.Fatal("trailing local correction bridge input")
	}
	u, err := url.Parse(input.URL)
	if err != nil || u.Scheme != "mysql" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.User == nil || u.RawQuery != "" || u.Fragment != "" || !regexp.MustCompile(`^/pos_rewrite_import_runtime_[a-f0-9]{12}$`).MatchString(u.Path) {
		t.Fatal("disposable localhost source schema required")
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
		t.Fatal("local correction connection unavailable")
	}
	defer db.Close()
	t.Setenv("POS_LEGACY_IMPORT_KEY", input.AuthKey)
	t.Setenv("POS_LEGACY_IMPORT_PROOF_KEY", input.ProofKey)
	t.Setenv("POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT", poscheckout.LegacyImportContract)
	t.Setenv("POS_MEMBERSHIP_PROOF_KEY", strings.Repeat("fixture-member-proof-", 3))
	t.Setenv("POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT", "pos-membership-native-revision-v1")
	t.Setenv("POS_MEMBERSHIP_PRODUCT_IDS", "[]")
	for _, name := range []string{"EXCLUSIVE_PRODUCT_ID", "EXCLUSIVE_99_PRODUCT_ID", "EXCLUSIVE_QUARTERLY_ID", "EXCLUSIVE_QUARTERLY_ID_FREE", "EXCLUSIVE_UPGRADE_IDS"} {
		t.Setenv(name, "")
	}
	ctx, err := poscheckout.WithLegacyImport(context.Background(), base64.RawURLEncoding.EncodeToString(input.Capability), input.AuthKey, time.Now())
	if err != nil {
		t.Fatal("local correction capability refused")
	}
	called := 0
	for attempt := 0; attempt < 2; attempt++ {
		result, confirmErr := poscheckout.Confirm(ctx, db, input.OrderID, poscheckout.DefaultHashes, func(tx *sql.Tx) error {
			called++
			return sourceApply(tx, int(input.OrderID), false)
		})
		if confirmErr != nil {
			if native, ok := confirmErr.(*mysql.MySQLError); ok {
				missing := regexp.MustCompile(`(?i)Table '[a-z0-9_]+\.([a-z0-9_]+)' doesn't exist`).FindStringSubmatch(native.Message)
				if len(missing) == 2 {
					t.Fatalf("local correction missing native table %s", missing[1])
				}
				t.Fatalf("local correction confirmation SQL code %d", native.Number)
			}
			t.Fatalf("local correction confirmation refused, source callbacks %d", called)
		}
		if result.Created != (attempt == 0) {
			t.Fatal("local correction confirmation replay changed its result")
		}
	}
	var receipts int
	if called != 1 || db.QueryRow(`SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts WHERE kind='confirmation'`).Scan(&receipts) != nil || receipts != 1 {
		t.Fatal("local corrected source was not applied exactly once")
	}
}
