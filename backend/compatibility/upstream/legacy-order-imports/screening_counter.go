// Current operational screening projection. The independent baseline is BQ
// qualified; interactive confirmation never scans old raw Order/HP markers.
package poscheckout

import (
	"bytes"
	"context"
	"crypto/hmac"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const ScreeningCounterContract = "pos-screening-current-counter-v1"

var screeningCounterHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

type screeningCounterDefinition struct {
	Contract, PublicationContract, WritersContract, SourceCommit, SKU, DefinitionHash string
	PrivilegeSQL                                                                      string
	IndexSQL                                                                          string
	RequiredPrefixes                                                                  map[string][]string
	Procedure                                                                         struct{ Name, Type, Security, Statement string }
	Triggers                                                                          []struct{ Name, Table, Event, Timing, Statement string }
}

func counterDefinition() (screeningCounterDefinition, error) {
	var d screeningCounterDefinition
	if json.Unmarshal([]byte(screeningCounterDefinitionJSON), &d) != nil || d.Contract != ScreeningCounterContract || len(d.Triggers) != 9 || !screeningCounterHash.MatchString(d.DefinitionHash) {
		return d, ErrReview
	}
	return d, nil
}
func counterNormalize(value string) string { return strings.Join(strings.Fields(value), " ") }
func qualifyScreeningCounter(ctx context.Context, tx *sql.Tx) error {
	var isolation string
	if tx.QueryRowContext(ctx, `SELECT @@transaction_isolation`).Scan(&isolation) != nil || isolation != "READ-COMMITTED" {
		return ErrReview
	}
	d, err := counterDefinition()
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT 1 FROM orders o,has_products hp,spiderman_screening_orders s,pos_rewrite_screening_counter_heads h,pos_rewrite_screening_counters c,pos_rewrite_screening_contributions x WHERE FALSE`)
	if err != nil {
		return err
	}
	rows.Close()
	rows, err = tx.QueryContext(ctx, d.IndexSQL)
	if err != nil {
		return err
	}
	prefixes := map[string]map[string]bool{}
	primary := map[string]string{}
	indexCount := 0
	for rows.Next() {
		var table, name, position, kind, unique string
		var column sql.NullString
		if rows.Scan(&table, &name, &column, &position, &kind, &unique) != nil {
			rows.Close()
			return ErrReview
		}
		indexCount++
		if column.Valid && position == "1" && kind == "BTREE" {
			if prefixes[table] == nil {
				prefixes[table] = map[string]bool{}
			}
			prefixes[table][column.String] = true
		}
		if name == "PRIMARY" {
			if primary[table] != "" || !column.Valid || position != "1" || unique != "0" {
				rows.Close()
				return ErrReview
			}
			primary[table] = column.String
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil || indexCount > 2000 {
		return ErrReview
	}
	for table, columns := range d.RequiredPrefixes {
		if len(columns) == 0 || primary[table] != columns[0] {
			return ErrReview
		}
		for _, column := range columns {
			if !prefixes[table][column] {
				return ErrReview
			}
		}
	}
	rows, err = tx.QueryContext(ctx, `SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_TIMING,ACTION_STATEMENT,DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME LIKE 'pos_screening_%'`)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	owner := ""
	for rows.Next() {
		var name, table, event, timing, body, definer string
		if rows.Scan(&name, &table, &event, &timing, &body, &definer) != nil {
			rows.Close()
			return ErrReview
		}
		matched := false
		for _, expected := range d.Triggers {
			if expected.Name == name && expected.Table == table && expected.Event == event && expected.Timing == timing && counterNormalize(expected.Statement) == counterNormalize(body) {
				matched = true
			}
		}
		if owner == "" {
			owner = definer
		}
		if !matched || seen[name] || owner != definer {
			rows.Close()
			return ErrReview
		}
		seen[name] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(seen) != 9 {
		return ErrReview
	}
	var name, kind, security, body, definer string
	if tx.QueryRowContext(ctx, `SELECT ROUTINE_NAME,ROUTINE_TYPE,SECURITY_TYPE,ROUTINE_DEFINITION,DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME='pos_screening_sync_marker'`).Scan(&name, &kind, &security, &body, &definer) != nil || name != d.Procedure.Name || kind != "PROCEDURE" || security != "DEFINER" || definer != owner || counterNormalize(body) != counterNormalize(d.Procedure.Statement) {
		return ErrReview
	}
	return nil
}
func counterUint(value interface{}) (uint64, bool) {
	text, ok := value.(string)
	if !ok {
		return 0, false
	}
	number, err := strconv.ParseUint(text, 10, 64)
	return number, err == nil && strconv.FormatUint(number, 10) == text
}
func counterPoint(value interface{}) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	point, err := number.Int64()
	return point, err == nil && point > 0 && point <= 9007199254740991
}
func readCurrentScreeningCount(ctx context.Context, tx *sql.Tx, customer int64) (uint64, error) {
	key := os.Getenv("POS_SCREENING_COUNTER_PUBLICATION_KEY")
	if os.Getenv("POS_SCREENING_COUNTER_CONTRACT") != ScreeningCounterContract || !ProjectionKeyValid(key, key) {
		return 0, ErrReview
	}
	d, err := counterDefinition()
	if err != nil {
		return 0, err
	}
	var nativeCustomer, sku, count, revision, head, server, schema, seal string
	var raw []byte
	if tx.QueryRowContext(ctx, `SELECT CAST(c.customer_id AS CHAR),CAST(c.sku AS CHAR),CAST(c.bought AS CHAR),CAST(c.revision AS CHAR),CAST(h.revision AS CHAR),@@server_uuid,DATABASE(),CASE WHEN OCTET_LENGTH(c.baseline)<=12000 THEN c.baseline ELSE NULL END,c.baseline_hash FROM pos_rewrite_screening_counters c JOIN pos_rewrite_screening_counter_heads h ON h.customer_id=c.customer_id WHERE c.customer_id=? FOR SHARE`, customer).Scan(&nativeCustomer, &sku, &count, &revision, &head, &server, &schema, &raw, &seal) != nil {
		return 0, ErrReview
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var proof map[string]interface{}
	if decoder.Decode(&proof) != nil || len(proof) != 21 {
		return 0, ErrReview
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF {
		return 0, ErrReview
	}
	signature, ok := proof["signature"].(string)
	if !ok || !hmac.Equal([]byte(signature), []byte(seal)) {
		return 0, ErrReview
	}
	delete(proof, "signature")
	signed, e := importMAC(key, "screening-counter.publication.v1", proof)
	if e != nil || !hmac.Equal([]byte(signed), []byte(signature)) {
		return 0, ErrReview
	}
	scope, ok := proof["scope"].(map[string]interface{})
	if !ok || len(scope) != 2 || scope["customerId"] != strconv.FormatInt(customer, 10) || scope["sku"] != "390238" {
		return 0, ErrReview
	}
	baselineRev, ok := counterUint(proof["headRevision"])
	if !ok {
		return 0, ErrReview
	}
	nativeRev, e := strconv.ParseUint(revision, 10, 64)
	if e != nil || nativeRev < baselineRev || head != revision {
		return 0, ErrReview
	}
	if proof["contract"] != d.PublicationContract || proof["sourceCommit"] != d.SourceCommit || proof["writersContract"] != d.WritersContract || proof["writersDefinitionHash"] != d.DefinitionHash || proof["serverUuid"] != server || proof["sourceSchema"] != schema || proof["complete"] != true || nativeCustomer != strconv.FormatInt(customer, 10) || sku != "390238" {
		return 0, ErrReview
	}
	var owner string
	if tx.QueryRowContext(ctx, `SELECT DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME='pos_screening_sync_marker'`).Scan(&owner) != nil || proof["writersOwner"] != owner {
		return 0, ErrReview
	}
	if err = counterRuntimePrivileges(ctx, tx, d, owner); err != nil {
		return 0, err
	}
	for _, name := range []string{"generationId", "rowsHash", "sourceCaptureHash"} {
		text, ok := proof[name].(string)
		if !ok || !screeningCounterHash.MatchString(text) {
			return 0, ErrReview
		}
	}
	for _, name := range []string{"snapshotId", "serverUuid"} {
		text, ok := proof[name].(string)
		if !ok || !importUUID.MatchString(text) {
			return 0, ErrReview
		}
	}
	markerRows, ok := counterUint(proof["rows"])
	if !ok {
		return 0, ErrReview
	}
	includedRows, ok := counterUint(proof["count"])
	if !ok || includedRows > markerRows {
		return 0, ErrReview
	}
	var previous int64
	for _, name := range []string{"sourceCapturedAt", "sourceFinishedAt", "sourceCdcThrough", "publishedAt"} {
		point, ok := counterPoint(proof[name])
		if !ok || point < previous {
			return 0, ErrReview
		}
		previous = point
	}
	bought, e := strconv.ParseUint(count, 10, 64)
	if e != nil {
		return 0, ErrReview
	}
	var actual string
	var actualRows uint64
	if tx.QueryRowContext(ctx, `SELECT CAST(COALESCE(SUM(included),0) AS CHAR),COUNT(*) FROM (SELECT included FROM pos_rewrite_screening_contributions WHERE customer_id=? LIMIT 10001) current_rows`, customer).Scan(&actual, &actualRows) != nil || actual != count || actualRows > 10000 {
		return 0, ErrReview
	}
	return bought, nil
}
func counterRuntimePrivileges(ctx context.Context, tx *sql.Tx, d screeningCounterDefinition, owner string) error {
	var actor, roles string
	if tx.QueryRowContext(ctx, `SELECT CURRENT_USER(),CURRENT_ROLE()`).Scan(&actor, &roles) != nil || actor == owner || roles != "NONE" {
		return ErrReview
	}
	rows, err := tx.QueryContext(ctx, d.PrivilegeSQL)
	if err != nil {
		return err
	}
	count := 0
	for rows.Next() {
		var scope, privilege, object, grantable string
		if rows.Scan(&scope, &privilege, &object, &grantable) != nil || privilege != "SELECT" && privilege != "USAGE" && privilege != "SHOW_ROUTINE" || grantable != "NO" {
			rows.Close()
			return ErrReview
		}
		count++
	}
	err = rows.Err()
	rows.Close()
	if err != nil || count > 1000 {
		return ErrReview
	}
	rows, err = tx.QueryContext(ctx, `SHOW GRANTS FOR CURRENT_USER`)
	if err != nil {
		return err
	}
	count = 0
	for rows.Next() {
		var grant string
		if rows.Scan(&grant) != nil || regexp.MustCompile(`(?i)\b(EXECUTE|PROXY)\b|\bWITH GRANT OPTION\b`).MatchString(grant) {
			rows.Close()
			return ErrReview
		}
		count++
	}
	err = rows.Err()
	rows.Close()
	if err != nil || count > 1000 {
		return ErrReview
	}
	return nil
}
func acquireCounterName(ctx context.Context, tx *sql.Tx, p *importConfirmationPrelude, kind string, id int64) error {
	var name string
	if tx.QueryRowContext(ctx, `SELECT CONCAT('pos-screening:',LEFT(SHA2(DATABASE(),256),16),':',?,':',?)`, kind, strconv.FormatInt(id, 10)).Scan(&name) != nil {
		return ErrReview
	}
	for _, owned := range p.counterLocks {
		if owned == name {
			return nil
		}
	}
	var acquired sql.NullInt64
	if tx.QueryRowContext(ctx, `SELECT GET_LOCK(?,0)`, name).Scan(&acquired) != nil || !acquired.Valid || acquired.Int64 != 1 {
		return ErrReview
	}
	p.counterLocks = append(p.counterLocks, name)
	return nil
}
func releaseScreeningCounter(ctx context.Context, tx *sql.Tx, p *importConfirmationPrelude) error {
	if p == nil || len(p.counterLocks) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	var first error
	for i := len(p.counterLocks) - 1; i >= 0; i-- {
		var released sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT RELEASE_LOCK(?)`, p.counterLocks[i]).Scan(&released)
		if err != nil || !released.Valid || released.Int64 != 1 {
			first = ErrReview
		}
	}
	p.counterLocks = nil
	if first != nil {
		p.counterPoisoned = true
	}
	return first
}
func closeScreeningCounterConnection(p *importConfirmationPrelude) {
	if p == nil || p.counterConnection == nil {
		return
	}
	if p.counterPoisoned {
		p.counterConnection.Raw(func(_ interface{}) error { return driver.ErrBadConn })
	}
	p.counterConnection.Close()
	p.counterConnection = nil
}
func enterScreeningCounter(ctx context.Context, tx *sql.Tx, p *importConfirmationPrelude, orderID int64) error {
	if p == nil || !p.ticket {
		return nil
	}
	if !p.customerLocked {
		return ErrReview
	}
	if err := qualifyScreeningCounter(ctx, tx); err != nil {
		return err
	}
	if err := acquireCounterName(ctx, tx, p, "u", p.user); err != nil {
		return err
	}
	var found int64
	if err := tx.QueryRowContext(ctx, `SELECT id FROM orders WHERE id=? FOR UPDATE`, orderID).Scan(&found); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id FROM has_products WHERE order_id=? ORDER BY id LIMIT 1001`, orderID)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) != nil {
			rows.Close()
			return ErrReview
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(ids) > 1000 {
		return ErrReview
	}
	known := map[int64]bool{}
	for _, id := range ids {
		known[id] = true
	}
	// Scope recheck before taking any child lock. A cross-order marker anomaly
	// needs the multi-parent maintenance entry, never widened financial scope.
	rows, err = tx.QueryContext(ctx, `SELECT user_id,has_product_id FROM spiderman_screening_orders WHERE order_id=? ORDER BY id LIMIT 10001`, orderID)
	if err != nil {
		return err
	}
	count := 0
	for rows.Next() {
		var user, line int64
		if rows.Scan(&user, &line) != nil || user != p.user || !known[line] {
			rows.Close()
			return ErrReview
		}
		count++
	}
	err = rows.Err()
	rows.Close()
	if err != nil || count > 10000 {
		return ErrReview
	}
	if err = acquireCounterName(ctx, tx, p, "o", orderID); err != nil {
		return err
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if err = tx.QueryRowContext(ctx, `SELECT id FROM has_products WHERE id=? FOR UPDATE`, id).Scan(&found); err != nil {
			return err
		}
		if err = acquireCounterName(ctx, tx, p, "p", id); err != nil {
			return err
		}
	}
	_, err = readCurrentScreeningCount(ctx, tx, p.user)
	return err
}
