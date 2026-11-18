package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"context"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	mysql "github.com/go-sql-driver/mysql"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

//go:embed import_authority_migration.sql
var importAuthorityMigration string

var importFixtureApplications sync.Map

// The runner copies the canonical additive migration without altering it.
func installImportAuthorityMigration(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, table := range []string{"pos_rewrite_import_authority_stage_claims", "pos_rewrite_import_authority_continuations", "pos_rewrite_import_authority_heads", "pos_rewrite_import_authority_successions"} {
		execute(t, db, "DROP TABLE IF EXISTS "+table)
	}
	for _, statement := range strings.Split(importAuthorityMigration, ";") {
		if strings.TrimSpace(statement) != "" {
			execute(t, db, statement)
		}
	}
}

type importFixtureReply struct {
	Environment map[string]string `json:"environment"`
	DSN         string            `json:"dsn"`
	Error       string            `json:"error"`
}

// File IPC is confined to the runner's private disposable directory. It carries
// only fixture credentials; no service listener or external provider is used.
func importFixtureBridge(t *testing.T, action string) importFixtureReply {
	t.Helper()
	root := os.Getenv("POS_IMPORT_NATIVE_FIXTURE_BRIDGE")
	if root == "" {
		t.Fatal("isolated native-head fixture runner required")
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	name := hex.EncodeToString(random[:])
	request := filepath.Join(root, name+".request")
	response := filepath.Join(root, name+".response")
	body, _ := json.Marshal(map[string]string{"action": action})
	if err := os.WriteFile(request+".tmp", body, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(request+".tmp", request); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(request)
	defer os.Remove(response)
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(response)
		if err == nil {
			var reply importFixtureReply
			if json.Unmarshal(raw, &reply) != nil || reply.Error != "" {
				t.Fatal("native-head fixture setup failed: " + reply.Error)
			}
			return reply
		}
		if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("native-head fixture setup timed out")
	return importFixtureReply{}
}
func installImportNativeHead(t *testing.T, admin *sql.DB) {
	connectImportNativeHead(t, admin, "install")
}
func connectImportNativeHead(t *testing.T, admin *sql.DB, action string) {
	t.Helper()
	reply := importFixtureBridge(t, action)
	for key, value := range reply.Environment {
		t.Setenv(key, value)
	}
	app, err := sql.Open("mysql", reply.DSN)
	if err != nil {
		t.Fatal("native application connection unavailable")
	}
	if err = app.Ping(); err != nil {
		t.Fatal("native application connection unavailable")
	}
	var account string
	if err = app.QueryRow("SELECT CURRENT_USER()").Scan(&account); err != nil || strings.HasPrefix(account, "root@") {
		t.Fatal("financial fixture must use independent application account")
	}
	if os.Getenv("POS_CSV_MEMBERSHIP_BRIDGE") == "1" {
		query := "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('pos_rewrite_mem_eav_insert','pos_rewrite_mem_eav_update','pos_rewrite_mem_eav_delete','pos_rewrite_mem_user_email')"
		var installed, visible int
		if admin.QueryRow(query).Scan(&installed) != nil || app.QueryRow(query).Scan(&visible) != nil {
			t.Fatal("membership fence visibility probe failed")
		}
		t.Logf("literal membership revision fences installed=%d application-visible=%d", installed, visible)
	}
	importFixtureApplications.Store(admin, app)
	t.Cleanup(func() { importFixtureApplications.Delete(admin); app.Close(); importFixtureBridge(t, "cleanup") })
}
func importFixtureConfirm(ctx context.Context, admin *sql.DB, order int64, hashes poscheckout.HashContract, apply poscheckout.Apply) (poscheckout.Confirmation, error) {
	value, ok := importFixtureApplications.Load(admin)
	if !ok {
		return poscheckout.Confirmation{}, errors.New("native application fixture was not installed")
	}
	app, ok := value.(*sql.DB)
	if !ok {
		return poscheckout.Confirmation{}, errors.New("invalid native application fixture")
	}
	return poscheckout.Confirm(ctx, app, order, hashes, apply)
}

func importApplicationBridgeDB(t *testing.T) *sql.DB {
	t.Helper()
	db := bridgeDB(t)
	connectImportNativeHead(t, db, "connect")
	return db
}

func importFixtureError(err error) string {
	if err == nil {
		return "none"
	}
	var native *mysql.MySQLError
	if errors.As(err, &native) {
		denied := regexp.MustCompile(`(?i)^(SELECT|INSERT|UPDATE|DELETE)(?: with locking clause)? command denied .* for table '([a-z0-9_]+)'$`).FindStringSubmatch(native.Message)
		if native.Number == 1142 && len(denied) == 3 {
			return fmt.Sprintf("mysql%d %s %s", native.Number, strings.ToUpper(denied[1]), denied[2])
		}
		return fmt.Sprintf("mysql%d", native.Number)
	}
	if errors.Is(err, poscheckout.ErrReview) {
		return "review"
	}
	return fmt.Sprintf("%T", err)
}
