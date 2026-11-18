package poscheckout

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/go-sql-driver/mysql"
)

// This stream exercises database/sql's real EOF/error/Close semantics without
// inventing server privileges or substituting for the native audit below.
type headCapacityStream struct {
	values            []string
	index, calls      int
	closed, brokenEOF bool
}

func (s *headCapacityStream) Columns() []string { return []string{"Grants"} }
func (s *headCapacityStream) Close() error      { s.closed = true; return nil }
func (s *headCapacityStream) Next(dst []driver.Value) error {
	s.calls++
	if s.index == len(s.values) {
		if s.brokenEOF {
			return errors.New("fixture incomplete grant stream")
		}
		return io.EOF
	}
	dst[0] = s.values[s.index]
	s.index++
	return nil
}

type headCapacityConnector struct{ stream *headCapacityStream }

func (c headCapacityConnector) Connect(context.Context) (driver.Conn, error) {
	return headCapacityConnection{c.stream}, nil
}
func (c headCapacityConnector) Driver() driver.Driver { return headCapacityDriver{} }

type headCapacityDriver struct{}

func (headCapacityDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("connector required")
}

type headCapacityConnection struct{ stream *headCapacityStream }

func (headCapacityConnection) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepared query")
}
func (headCapacityConnection) Close() error              { return nil }
func (headCapacityConnection) Begin() (driver.Tx, error) { return headCapacityTransaction{}, nil }
func (c headCapacityConnection) QueryContext(_ context.Context, q string, _ []driver.NamedValue) (driver.Rows, error) {
	if q != "SHOW GRANTS FOR CURRENT_USER" {
		return nil, errors.New("unexpected fixture query")
	}
	return c.stream, nil
}

type headCapacityTransaction struct{}

func (headCapacityTransaction) Commit() error   { return nil }
func (headCapacityTransaction) Rollback() error { return nil }

func TestOriginNativeHeadCapacityReaderBoundaries(t *testing.T) {
	limits, err := configuredHeadCapacity()
	if err != nil {
		t.Fatal(err)
	}
	if limits.Contract != "pos-native-head-capacity-v1" || limits.CallerGrantRows != 512 || limits.CallerGrantRowBytes != 8192 || limits.CallerGrantTotalBytes != 524288 || limits.PrivilegeRows != 4096 || limits.SectionRows != 1000 || limits.MetadataBytes != 2097152 {
		t.Fatal("generated capacity contract changed")
	}
	repeat := func(value string, n int) []string {
		values := make([]string, n)
		for i := range values {
			values[i] = value
		}
		return values
	}
	for _, test := range []struct {
		name           string
		values         []string
		broken, accept bool
	}{
		{"exact row boundary", repeat("GRANT USAGE ON *.* TO 'fixture'@'%'", 512), false, true},
		{"extra row", repeat("GRANT USAGE ON *.* TO 'fixture'@'%'", 513), false, false},
		{"exact ASCII bytes", []string{strings.Repeat("a", 8192)}, false, true},
		{"extra ASCII byte", []string{strings.Repeat("a", 8193)}, false, false},
		{"exact UTF8 bytes", []string{strings.Repeat("é", 4096)}, false, true},
		{"extra UTF8 byte", []string{strings.Repeat("é", 4096) + "x"}, false, false},
		{"invalid UTF8", []string{string([]byte{0xff})}, false, false},
		{"exact total bytes", repeat(strings.Repeat("é", 4096), 64), false, true},
		{"extra total bytes", append(repeat(strings.Repeat("é", 4096), 64), "x"), false, false},
		{"boundary stream error", repeat("GRANT USAGE ON *.* TO 'fixture'@'%'", 512), true, false},
		{"empty stream", nil, false, false},
		{"empty statement", []string{""}, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			stream := &headCapacityStream{values: test.values, brokenEOF: test.broken}
			db := sql.OpenDB(headCapacityConnector{stream})
			defer db.Close()
			tx, e := db.BeginTx(context.Background(), nil)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback()
			grants, e := headCallerGrants(context.Background(), tx)
			if (e == nil) != test.accept {
				t.Fatalf("accepted=%v expected=%v", e == nil, test.accept)
			}
			if !stream.closed {
				t.Fatal("grant stream was not closed")
			}
			if test.accept && (len(grants) != len(test.values) || stream.calls != len(test.values)+1) {
				t.Fatal("complete grant stream was not read through EOF")
			}
		})
	}
}

func TestOriginNativeHeadCapacityActualCaller(t *testing.T) {
	cfg, err := mysql.ParseDSN(os.Getenv("POS_ORIGIN_HEAD_DSN"))
	if err != nil || cfg.Net != "tcp" || cfg.Addr != "mysql:3306" || cfg.DBName != "native_head_go_validation" || cfg.User != "origin_go_app" {
		t.Fatal("explicit isolated full-head fixture required")
	}
	app, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	admin, err := sql.Open("mysql", "root@tcp(mysql:3306)/native_head_go_validation?parseTime=true")
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	ctx := context.Background()
	countGrants := func() int {
		rows, e := app.QueryContext(ctx, "SHOW GRANTS FOR CURRENT_USER")
		if e != nil {
			t.Fatal(e)
		}
		defer rows.Close()
		n := 0
		for rows.Next() {
			var value string
			if e = rows.Scan(&value); e != nil {
				t.Fatal(e)
			}
			n++
		}
		if rows.Err() != nil {
			t.Fatal(rows.Err())
		}
		return n
	}
	qualify := func(standalone bool) error {
		tx, e := app.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
		if e != nil {
			return e
		}
		defer tx.Rollback()
		if standalone {
			d, e := counterDefinition()
			if e != nil {
				return e
			}
			return counterRuntimePrivileges(ctx, tx, d, os.Getenv("POS_SCREENING_COUNTER_TRIGGER_DEFINER"))
		}
		_, e = counterMetadata(ctx, tx)
		return e
	}
	var tables []string
	defer func() {
		for _, table := range tables {
			if _, e := admin.Exec("REVOKE ALL PRIVILEGES ON native_head_go_validation.`" + table + "` FROM 'origin_go_app'@'%'"); e != nil {
				t.Error(e)
			}
			if _, e := admin.Exec("DROP TABLE `" + table + "`"); e != nil {
				t.Error(e)
			}
		}
	}()
	add := func() {
		table := fmt.Sprintf("zz_origin_capacity_%03d", len(tables))
		if _, e := admin.Exec("CREATE TABLE `" + table + "`(id BIGINT PRIMARY KEY)"); e != nil {
			t.Fatal(e)
		}
		tables = append(tables, table)
		if _, e := admin.Exec("GRANT INSERT ON native_head_go_validation.`" + table + "` TO 'origin_go_app'@'%'"); e != nil {
			t.Fatal(e)
		}
	}
	initial := countGrants()
	if initial >= 512 {
		t.Fatal("fixture caller unexpectedly starts at capacity")
	}
	for i := initial; i < 512; i++ {
		add()
	}
	if countGrants() != 512 {
		t.Fatal("fixture did not reach exact caller boundary")
	}
	if err = qualify(false); err != nil {
		t.Fatalf("full fresh audit refused exact512 grants: %v", err)
	}
	if err = qualify(true); err != nil {
		t.Fatalf("standalone counter parser refused exact512 grants: %v", err)
	}
	add()
	if countGrants() != 513 {
		t.Fatal("fixture did not exceed caller boundary")
	}
	if err = qualify(false); err == nil {
		t.Fatal("full audit accepted513 caller grants")
	}
	if err = qualify(true); err == nil {
		t.Fatal("standalone counter parser accepted513 caller grants")
	}
	extra := tables[len(tables)-1]
	if _, err = admin.Exec("REVOKE INSERT ON native_head_go_validation.`" + extra + "` FROM 'origin_go_app'@'%'"); err != nil {
		t.Fatal(err)
	}
	if _, err = admin.Exec("DROP TABLE `" + extra + "`"); err != nil {
		t.Fatal(err)
	}
	tables = tables[:len(tables)-1]
	late := tables[len(tables)-1]
	if _, err = admin.Exec("GRANT TRIGGER ON native_head_go_validation.`" + late + "` TO 'origin_go_app'@'%'"); err != nil {
		t.Fatal(err)
	}
	if countGrants() != 512 {
		t.Fatal("unsafe grant must remain inside caller capacity")
	}
	if err = qualify(false); err == nil {
		t.Fatal("full audit accepted late unsafe table grant")
	}
	if err = qualify(true); err == nil {
		t.Fatal("standalone counter parser accepted late unsafe table grant")
	}
	if _, err = admin.Exec("REVOKE TRIGGER ON native_head_go_validation.`" + late + "` FROM 'origin_go_app'@'%'"); err != nil {
		t.Fatal(err)
	}
	if err = qualify(false); err != nil {
		t.Fatalf("restored512-grant audit refused: %v", err)
	}
}
