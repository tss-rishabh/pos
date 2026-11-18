package poscheckout

// This audit runs inside the caller's native financial transaction. Metadata
// locks remain held until that transaction ends; no cross-request attestation
// substitutes for checking the current server's writer authority.
import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"regexp"
	"sort"
	"strings"
)

type headRow map[string]interface{}
type headDescriptor struct {
	MetadataHash            string
	TransactionMetadataHash string
	OriginTriggers          []headRow
	Families                map[string]struct {
		Definitions []headRow
		Procedure   headRow
	}
	PlatformTriggers []headRow
}
type headOwner struct {
	names, watched map[string]bool
	heads          map[string][]string
	procedures     map[string]string
	publisher      bool
}
type headAudit struct {
	descriptor                     headDescriptor
	schema, current, audit, origin string
	admins                         map[string]bool
	owners                         map[string]*headOwner
	declared                       map[string]bool
	familyOwners                   map[string]string
	platform                       bool
}

const headInfo = "pos_rewrite_origin_history_metadata"
const headTransactionInfo = "pos_rewrite_origin_transaction_metadata"

var headWatched = []string{"orders", "users", "has_products", "order_coupon_log", "coupons", "spiderman_screening_orders"}
var headBase = []string{"pos_rewrite_screening_origin_history_heads", "pos_rewrite_screening_origin_history_changes"}
var headFamilyRights = map[string]map[string][]string{
	"membership": {"pos_rewrite_membership_history_heads": {"SELECT", "INSERT", "UPDATE"}},
	"coupon":     {"pos_rewrite_coupon_history_heads": {"SELECT", "INSERT", "UPDATE"}},
	"counter":    {"pos_rewrite_screening_counter_heads": {"SELECT", "INSERT", "UPDATE"}, "pos_rewrite_screening_counters": {"SELECT", "UPDATE"}, "pos_rewrite_screening_contributions": {"SELECT", "INSERT", "UPDATE", "DELETE"}},
}
var headPublisherRights = map[string][]string{"pos_rewrite_screening_counter_heads": {"SELECT", "INSERT", "UPDATE"}, "pos_rewrite_screening_counters": {"SELECT", "INSERT", "UPDATE"}, "pos_rewrite_screening_contributions": {"SELECT", "INSERT", "DELETE"}}

func headSet(values ...string) map[string]bool {
	m := map[string]bool{}
	for _, v := range values {
		m[v] = true
	}
	return m
}
func headHas(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func headText(r headRow, k string) string { v, _ := r[k].(string); return v }
func headFields(r headRow, keys string) bool {
	wanted := strings.Fields(keys)
	if len(r) != len(wanted) {
		return false
	}
	for _, k := range wanted {
		v, ok := r[k]
		if !ok {
			return false
		}
		if _, ok := v.(string); !ok {
			if _, numeric := v.(float64); !numeric || (k != "grantable" && k != "usesRoutines") {
				return false
			}
		}
	}
	return true
}
func headMode(v string) bool {
	return headHas(strings.Split(v, ","), "STRICT_TRANS_TABLES") || headHas(strings.Split(v, ","), "STRICT_ALL_TABLES")
}
func headEmpty(ctx context.Context, tx *sql.Tx, q string) error {
	r, e := tx.QueryContext(ctx, q)
	if e != nil {
		return ErrReview
	}
	defer r.Close()
	if r.Next() || r.Err() != nil {
		return ErrReview
	}
	return nil
}
func headPrelude(ctx context.Context, tx *sql.Tx) (*headAudit, error) {
	a := &headAudit{admins: map[string]bool{}, owners: map[string]*headOwner{}, declared: headSet(append(headBase, headWatched...)...), familyOwners: map[string]string{}}
	if json.Unmarshal([]byte(screeningHeadMetadataDefinitionJSON), &a.descriptor) != nil || !screeningCounterHash.MatchString(a.descriptor.MetadataHash) {
		return nil, ErrReview
	}
	a.audit = os.Getenv("POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER")
	a.origin = os.Getenv("POS_SCREENING_ORIGIN_HISTORY_DEFINER")
	var admins []string
	raw := os.Getenv("POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES")
	if raw == "" {
		raw = "[]"
	}
	if json.Unmarshal([]byte(raw), &admins) != nil || len(admins) > 32 {
		return nil, ErrReview
	}
	for _, v := range admins {
		if !counterOwnerPattern.MatchString(v) || a.admins[v] {
			return nil, ErrReview
		}
		a.admins[v] = true
	}
	participants := headSet()
	for _, v := range []string{a.audit, a.origin} {
		if !counterOwnerPattern.MatchString(v) || participants[v] || a.admins[v] {
			return nil, ErrReview
		}
		participants[v] = true
	}
	for family, env := range map[string]string{"membership": "POS_MEMBERSHIP_HISTORY_TRIGGER_DEFINER", "coupon": "POS_COUPON_HISTORY_DEFINER", "counter": "POS_SCREENING_COUNTER_TRIGGER_DEFINER", "publisher": "POS_SCREENING_COUNTER_PUBLISHER_GRANTEE"} {
		v := os.Getenv(env)
		if v == "" {
			continue
		}
		if !counterOwnerPattern.MatchString(v) || participants[v] || a.admins[v] {
			return nil, ErrReview
		}
		participants[v] = true
		a.familyOwners[family] = v
		if family != "publisher" {
			for t := range headFamilyRights[family] {
				a.declared[t] = true
			}
		}
	}
	var roles, mandatory, performance string
	var proxy sql.NullString
	if tx.QueryRowContext(ctx, `SELECT DATABASE(),CURRENT_USER(),CURRENT_ROLE(),@@SESSION.proxy_user,@@GLOBAL.mandatory_roles,CAST(@@GLOBAL.performance_schema AS CHAR)`).Scan(&a.schema, &a.current, &roles, &proxy, &mandatory, &performance) != nil || !regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`).MatchString(a.schema) || !counterOwnerPattern.MatchString(a.current) || roles != "NONE" || proxy.Valid || (mandatory != "" && mandatory != "NONE") || performance != "1" || participants[a.current] || a.admins[a.current] {
		return nil, ErrReview
	}
	d, err := counterDefinition()
	if err != nil || counterRuntimePrivileges(ctx, tx, d, a.familyOwners["counter"]) != nil {
		return nil, ErrReview
	}
	names := []string{}
	for t := range a.declared {
		names = append(names, t)
	}
	sort.Strings(names)
	for _, t := range names {
		if headEmpty(ctx, tx, "SELECT 1 FROM `"+t+"` WHERE FALSE") != nil {
			return nil, ErrReview
		}
	}
	var n int
	if tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='sys' AND TABLE_NAME='sys_config'`).Scan(&n) != nil || n > 1 {
		return nil, ErrReview
	}
	a.platform = n == 1
	if a.platform && headEmpty(ctx, tx, "SELECT 1 FROM `sys`.`sys_config` WHERE FALSE") != nil {
		return nil, ErrReview
	}
	if a.transactionReader(ctx, tx) != nil {
		return nil, ErrReview
	}
	return a, nil
}
func (a *headAudit) validate(ctx context.Context, tx *sql.Tx, sections map[string]json.RawMessage) error {
	names := []string{"triggers", "accounts", "roles", "proxies", "privileges", "routineGrants", "objects", "aliases", "tables", "foreignKeys", "replicationChannels", "membershipTriggers", "couponTriggers", "counterTriggers", "counterProcedures", "platformTriggers"}
	if len(sections) != len(names) {
		return ErrReview
	}
	data := map[string][]headRow{}
	for _, name := range names {
		raw, ok := sections[name]
		if !ok {
			return ErrReview
		}
		var rows []headRow
		if json.Unmarshal(raw, &rows) != nil || rows == nil || len(rows) > 1000 {
			return ErrReview
		}
		data[name] = rows
	}
	if len(data["aliases"]) != 0 || len(data["replicationChannels"]) != 0 {
		return ErrReview
	}
	for _, family := range []string{"membership", "coupon", "counter"} {
		actual := data[family+"Triggers"]
		owner := a.familyOwners[family]
		expected, ok := a.descriptor.Families[family]
		if !ok {
			return ErrReview
		}
		if len(actual) == 0 {
			if owner != "" || (family == "counter" && len(data["counterProcedures"]) > 0) {
				return ErrReview
			}
			continue
		}
		if owner == "" || len(actual) != len(expected.Definitions) {
			return ErrReview
		}
		spec := &headOwner{names: map[string]bool{}, watched: map[string]bool{}, heads: headFamilyRights[family], procedures: map[string]string{}}
		for _, r := range actual {
			if !headFields(r, "name tableName event timing hash definer sqlMode") || headText(r, "definer") != owner || !headMode(headText(r, "sqlMode")) || spec.names[headText(r, "name")] {
				return ErrReview
			}
			matched := false
			for _, w := range expected.Definitions {
				if headText(w, "name") != headText(r, "name") {
					continue
				}
				matched = true
				for k, v := range w {
					if r[k] != v {
						return ErrReview
					}
				}
			}
			if !matched {
				return ErrReview
			}
			spec.names[headText(r, "name")] = true
			spec.watched[headText(r, "tableName")] = true
		}
		if family == "counter" {
			p := data["counterProcedures"]
			if len(p) != 1 || !headFields(p[0], "name kind security hash definer") || headText(p[0], "definer") != owner {
				return ErrReview
			}
			for k, v := range expected.Procedure {
				if p[0][k] != v {
					return ErrReview
				}
			}
			spec.procedures[headText(p[0], "name")] = "PROCEDURE"
		}
		a.owners[owner] = spec
	}
	if pub := a.familyOwners["publisher"]; pub != "" {
		if a.owners[a.familyOwners["counter"]] == nil {
			return ErrReview
		}
		a.owners[pub] = &headOwner{names: map[string]bool{}, watched: map[string]bool{}, heads: headPublisherRights, procedures: map[string]string{}, publisher: true}
	}
	originSpec := &headOwner{names: map[string]bool{}, watched: headSet("orders", "users"), heads: map[string][]string{headBase[0]: {"SELECT", "INSERT", "UPDATE"}, headBase[1]: {"INSERT"}}, procedures: map[string]string{}}
	a.owners[a.origin] = originSpec
	if len(data["triggers"]) != 4 {
		return ErrReview
	}
	for _, r := range data["triggers"] {
		if !headFields(r, "name action sourceTable body owner sqlMode") || headText(r, "owner") != a.origin || !headMode(headText(r, "sqlMode")) || originSpec.names[headText(r, "name")] {
			return ErrReview
		}
		matched := false
		for _, w := range a.descriptor.OriginTriggers {
			if headText(w, "name") == headText(r, "name") && headText(w, "action") == headText(r, "action") && headText(w, "table") == headText(r, "sourceTable") && headText(w, "hash") == counterStatementHash(strings.TrimRight(counterNormalize(headText(r, "body")), ";")) {
				matched = true
			}
		}
		if !matched {
			return ErrReview
		}
		originSpec.names[headText(r, "name")] = true
	}
	accounts := map[string]string{}
	for _, r := range data["accounts"] {
		name := headText(r, "name")
		locked := headText(r, "locked")
		if !headFields(r, "name locked") || !counterOwnerPattern.MatchString(name) || accounts[name] != "" || (locked != "Y" && locked != "N") {
			return ErrReview
		}
		accounts[name] = locked
	}
	for owner, spec := range a.owners {
		locked := "Y"
		if spec.publisher {
			locked = "N"
		}
		if accounts[owner] != locked {
			return ErrReview
		}
	}
	if accounts[a.audit] != "Y" || accounts[a.current] != "N" {
		return ErrReview
	}
	for admin := range a.admins {
		if accounts[admin] == "" {
			return ErrReview
		}
	}
	isolated := headSet(a.audit, a.current)
	for owner := range a.owners {
		isolated[owner] = true
	}
	for _, r := range data["roles"] {
		n, role := headText(r, "name"), headText(r, "role")
		if !headFields(r, "name role") || accounts[n] == "" || accounts[role] == "" || isolated[n] || isolated[role] || a.admins[n] != a.admins[role] {
			return ErrReview
		}
	}
	for _, r := range data["proxies"] {
		n, target := headText(r, "name"), headText(r, "target")
		g, ok := r["grantable"].(float64)
		if !headFields(r, "name target grantable") || !ok || (g != 0 && g != 1) || accounts[n] == "" || (target != "@" && !counterOwnerPattern.MatchString(target)) || isolated[n] || isolated[target] || (!a.admins[n] && (a.admins[target] || target == "@" || g == 1)) {
			return ErrReview
		}
	}
	platformIDs := map[string]bool{}
	if (a.platform && len(data["platformTriggers"]) != 2) || (!a.platform && len(data["platformTriggers"]) != 0) {
		return ErrReview
	}
	for _, r := range data["platformTriggers"] {
		if !headFields(r, "schema name tableName event timing definer hash locked tableKind tableEngine") {
			return ErrReview
		}
		matched := false
		for _, w := range a.descriptor.PlatformTriggers {
			equal := true
			for k, v := range w {
				if r[k] != v {
					equal = false
				}
			}
			if equal {
				matched = true
			}
		}
		owner := headText(r, "definer")
		id := headText(r, "schema") + "/" + headText(r, "name") + "/TRIGGER"
		if !matched || platformIDs[id] || !a.admins[owner] || accounts[owner] != "Y" {
			return ErrReview
		}
		platformIDs[id] = true
	}
	auditGlobal := map[string]bool{}
	grantee := regexp.MustCompile(`^'([A-Za-z0-9_.$-]{1,64})'@'([A-Za-z0-9_.:%-]{1,255})'$`)
	for _, r := range data["privileges"] {
		if !headFields(r, "grantee scope schema table privilege grantable target") {
			return ErrReview
		}
		m := grantee.FindStringSubmatch(headText(r, "grantee"))
		if m == nil {
			return ErrReview
		}
		owner := m[1] + "@" + m[2]
		scope, schema, table, right, target := headText(r, "scope"), headText(r, "schema"), headText(r, "table"), headText(r, "privilege"), headText(r, "target")
		grant := headText(r, "grantable")
		if accounts[owner] == "" || !headHas([]string{"global", "schema", "table", "column"}, scope) || !headHas([]string{"global", "protected-schema", "grants", "control", "watched", "other"}, target) || !headHas([]string{"YES", "NO"}, grant) {
			return ErrReview
		}
		if spec := a.owners[owner]; spec != nil {
			allowed := []string{}
			if scope == "global" {
				allowed = []string{"USAGE"}
				if spec.publisher {
					allowed = append(allowed, "SHOW_ROUTINE", "SHOW ROUTINE")
				}
			} else if spec.publisher && scope == "schema" && schema == a.schema {
				allowed = []string{"SELECT", "SHOW VIEW", "REFERENCES"}
			} else if spec.publisher && a.platform && scope == "table" && schema == "sys" && table == "sys_config" {
				allowed = []string{"SELECT"}
			} else if scope == "table" && schema == a.schema {
				if spec.watched[table] {
					allowed = []string{"SELECT", "TRIGGER"}
				} else if spec.publisher && headHas(headWatched, table) {
					allowed = []string{"SELECT"}
				} else {
					allowed = spec.heads[table]
				}
			}
			if grant != "NO" || !headHas(allowed, right) {
				return ErrReview
			}
		} else if owner == a.audit {
			if scope != "global" || grant != "NO" || !headHas([]string{"SELECT", "SHOW VIEW", "SHOW_ROUTINE", "TRIGGER", "EVENT", "USAGE"}, right) {
				return ErrReview
			}
			auditGlobal[right] = true
		} else if !a.admins[owner] {
			if scope == "global" && (!headHas([]string{"USAGE", "SELECT", "SHOW DATABASES", "SHOW VIEW", "SHOW_ROUTINE", "SHOW ROUTINE", "PROCESS", "REPLICATION CLIENT", "REPLICATION SLAVE", "REPLICATION REPLICA"}, right) || grant != "NO") {
				return ErrReview
			}
			if scope == "schema" && (right == "EXECUTE" || (target == "protected-schema" && !headHas([]string{"SELECT", "SHOW VIEW", "REFERENCES"}, right))) {
				return ErrReview
			}
			if scope == "table" || scope == "column" {
				if target == "grants" && !headHas([]string{"SELECT", "SHOW VIEW"}, right) || target == "control" && right != "SELECT" || target == "watched" && !headHas([]string{"SELECT", "SHOW VIEW", "INSERT", "UPDATE", "DELETE", "REFERENCES", "INDEX"}, right) {
					return ErrReview
				}
			}
		}
	}
	for _, right := range []string{"SELECT", "SHOW VIEW", "SHOW_ROUTINE", "TRIGGER", "EVENT"} {
		if !auditGlobal[right] {
			return ErrReview
		}
	}
	for _, r := range data["routineGrants"] {
		if !headFields(r, "name schema routine kind privileges") || accounts[headText(r, "name")] == "" {
			return ErrReview
		}
		owner := headText(r, "name")
		if a.admins[owner] {
			continue
		}
		rights := headText(r, "privileges")
		single := strings.TrimSpace(strings.ToUpper(rights)) == "EXECUTE"
		name, kind := headText(r, "routine"), headText(r, "kind")
		metadata := headText(r, "schema") == a.schema && kind == "FUNCTION" && (name == headInfo || name == headTransactionInfo) && single
		if spec := a.owners[owner]; spec != nil {
			if metadata && (spec.publisher || owner == a.familyOwners["counter"] && name == headTransactionInfo) {
				continue
			}
			if headText(r, "schema") != a.schema || spec.procedures[name] != kind || !single {
				return ErrReview
			}
		} else if !metadata {
			return ErrReview
		}
	}
	objects := map[string]bool{}
	for _, r := range data["objects"] {
		if !headFields(r, "schema name kind owner security usesRoutines") {
			return ErrReview
		}
		schema, name, kind, owner, security := headText(r, "schema"), headText(r, "name"), headText(r, "kind"), headText(r, "owner"), headText(r, "security")
		uses, ok := r["usesRoutines"].(float64)
		id := schema + "/" + name + "/" + kind
		if accounts[owner] == "" || objects[id] || !headHas([]string{"FUNCTION", "PROCEDURE", "VIEW", "TRIGGER", "EVENT"}, kind) || !headHas([]string{"DEFINER", "INVOKER"}, security) || !ok || (uses != 0 && uses != 1) {
			return ErrReview
		}
		objects[id] = true
		if owner == a.audit {
			if schema != a.schema || kind != "FUNCTION" || (name != headInfo && name != headTransactionInfo) || security != "DEFINER" {
				return ErrReview
			}
		} else if spec := a.owners[owner]; spec != nil {
			if schema != a.schema || security != "DEFINER" || !((kind == "TRIGGER" && spec.names[name]) || spec.procedures[name] == kind) {
				return ErrReview
			}
		} else if a.admins[owner] && ((kind == "TRIGGER" && !platformIDs[id]) || kind == "EVENT" || kind == "VIEW" && security == "DEFINER" && uses == 1) {
			return ErrReview
		}
	}
	if !objects[a.schema+"/"+headInfo+"/FUNCTION"] || !objects[a.schema+"/"+headTransactionInfo+"/FUNCTION"] {
		return ErrReview
	}
	for _, spec := range a.owners {
		for name := range spec.names {
			if !objects[a.schema+"/"+name+"/TRIGGER"] {
				return ErrReview
			}
		}
		for name, kind := range spec.procedures {
			if !objects[a.schema+"/"+name+"/"+kind] {
				return ErrReview
			}
		}
	}
	tables := map[string]bool{}
	for _, r := range data["tables"] {
		n := headText(r, "name")
		if !headFields(r, "name kind engine") || tables[n] || !a.declared[n] || headText(r, "kind") != "BASE TABLE" || headText(r, "engine") != "InnoDB" {
			return ErrReview
		}
		tables[n] = true
	}
	if len(tables) != len(a.declared) {
		return ErrReview
	}
	for table := range a.declared {
		if headPhysical(ctx, tx, "", table) != nil {
			return ErrReview
		}
	}
	if a.platform && headPhysical(ctx, tx, "sys", "sys_config") != nil {
		return ErrReview
	}
	for _, r := range data["foreignKeys"] {
		table := headText(r, "table")
		if !headFields(r, "table column update delete") || !a.declared[table] || !headHas(headWatched, table) || !headHas([]string{"RESTRICT", "NO ACTION"}, headText(r, "update")) || !headHas([]string{"RESTRICT", "NO ACTION"}, headText(r, "delete")) {
			return ErrReview
		}
	}
	return nil
}
func headPhysical(ctx context.Context, tx *sql.Tx, schema, table string) error {
	target := "`" + table + "`"
	if schema != "" {
		target = "`" + schema + "`." + target
	}
	var name, body string
	if tx.QueryRowContext(ctx, "SHOW CREATE TABLE "+target).Scan(&name, &body) != nil || name != table || len(body) > 200000 || !regexp.MustCompile("^CREATE TABLE\\s+`"+table+"`\\s*\\(").MatchString(body) {
		return ErrReview
	}
	return nil
}

// Both readers are closed, hash-pinned functions owned by the same locked audit
// principal. Checking routine metadata also holds its native metadata lock.
func (a *headAudit) transactionReader(ctx context.Context, tx *sql.Tx) error {
	if !screeningCounterHash.MatchString(a.descriptor.TransactionMetadataHash) {
		return ErrReview
	}
	if a.checkRoutine(ctx, tx, headTransactionInfo, a.descriptor.TransactionMetadataHash) != nil {
		return ErrReview
	}
	var raw []byte
	if tx.QueryRowContext(ctx, `SELECT CASE WHEN OCTET_LENGTH(pos_rewrite_origin_transaction_metadata())<=2000 THEN pos_rewrite_origin_transaction_metadata() ELSE NULL END`).Scan(&raw) != nil || len(raw) == 0 || len(raw) > 2000 {
		return ErrReview
	}
	if a.checkRoutine(ctx, tx, headTransactionInfo, a.descriptor.TransactionMetadataHash) != nil {
		return ErrReview
	}
	var rows []headRow
	if json.Unmarshal(raw, &rows) != nil || len(rows) != 1 || !headFields(rows[0], "state isolation") || headText(rows[0], "state") != "ACTIVE" || headText(rows[0], "isolation") != "READ COMMITTED" {
		return ErrReview
	}
	return nil
}

func (a *headAudit) checkRoutine(ctx context.Context, tx *sql.Tx, name, hash string) error {
	if !screeningCounterHash.MatchString(hash) {
		return ErrReview
	}
	var owner, security, access, body string
	if tx.QueryRowContext(ctx, `SELECT DEFINER,SECURITY_TYPE,SQL_DATA_ACCESS,CASE WHEN OCTET_LENGTH(ROUTINE_DEFINITION)<=60000 THEN ROUTINE_DEFINITION ELSE NULL END FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME=? AND ROUTINE_TYPE='FUNCTION'`, name).Scan(&owner, &security, &access, &body) != nil || owner != a.audit || security != "DEFINER" || access != "READS SQL DATA" || counterStatementHash(strings.TrimRight(counterNormalize(body), ";")) != hash {
		return ErrReview
	}
	return nil
}
