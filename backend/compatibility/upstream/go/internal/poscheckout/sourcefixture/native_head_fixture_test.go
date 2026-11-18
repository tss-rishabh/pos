package sourcefixture

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var fixtureAdministrators sync.Map

// The isolated runner retains administrative setup separately from the actual
// application handle. No production handler receives this fixture-only map.
func fixtureAdministrator(db *sql.DB) *sql.DB {
	if value, ok := fixtureAdministrators.Load(db); ok {
		return value.(*sql.DB)
	}
	return db
}
func nativeHeadFixtureApplication(t *testing.T, admin *sql.DB, action string) *sql.DB {
	t.Helper()
	root := os.Getenv("POS_IMPORT_NATIVE_FIXTURE_BRIDGE")
	if root == "" || (action != "install" && action != "connect") {
		t.Fatal("isolated native-head fixture bridge required")
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	name := hex.EncodeToString(random[:])
	request := filepath.Join(root, name+".request")
	response := filepath.Join(root, name+".response")
	raw, _ := json.Marshal(map[string]string{"action": action})
	if err := os.WriteFile(request+".tmp", raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(request+".tmp", request); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(request)
	defer os.Remove(response)
	var reply struct {
		Environment map[string]string `json:"environment"`
		DSN         string            `json:"dsn"`
		Error       string            `json:"error"`
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		body, err := os.ReadFile(response)
		if err == nil {
			if json.Unmarshal(body, &reply) != nil || reply.Error != "" {
				t.Fatal("reviewed native-head fixture unavailable")
			}
			break
		}
		if !os.IsNotExist(err) || time.Now().After(deadline) {
			t.Fatal("reviewed native-head fixture unavailable")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for key, value := range reply.Environment {
		t.Setenv(key, value)
	}
	db, err := sql.Open("mysql", reply.DSN)
	if err != nil {
		t.Fatal("independent native application unavailable")
	}
	var account string
	if db.QueryRow("SELECT CURRENT_USER()").Scan(&account) != nil || strings.HasPrefix(account, "root@") {
		db.Close()
		t.Fatal("independent native application required")
	}
	fixtureAdministrators.Store(db, admin)
	t.Cleanup(func() {
		fixtureAdministrators.Delete(db)
		db.Close()
		// Cleanup uses the same private protocol without replacing transaction state.
		raw, _ := json.Marshal(map[string]string{"action": "cleanup"})
		if err := os.WriteFile(request+".tmp", raw, 0600); err != nil {
			t.Error("native fixture cleanup unavailable")
			return
		}
		if err := os.Rename(request+".tmp", request); err != nil {
			t.Error("native fixture cleanup unavailable")
			return
		}
		end := time.Now().Add(60 * time.Second)
		for time.Now().Before(end) {
			if body, err := os.ReadFile(response); err == nil {
				var result struct {
					Error string `json:"error"`
				}
				if json.Unmarshal(body, &result) != nil || result.Error != "" {
					t.Error("native fixture cleanup failed")
				}
				os.Remove(request)
				os.Remove(response)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Error("native fixture cleanup timed out")
	})
	return db
}
