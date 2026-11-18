import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { z } from 'zod';
import type { Databases } from '../../src/db/pools.js';
import type { NativeHeadMetadataOptions } from '../../src/modules/screening-origins/native-head-metadata.js';
import { counterInstallationSql } from '../../src/modules/legacy-order-imports/screening-counter/writers.js';
import { couponHistoryWritersReviewSql } from '../../src/modules/legacy-order-imports/benefit-profile/history-writers.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
const DBA = [
  'root@localhost',
  'root@%',
  'mysql.infoschema@localhost',
  'mysql.session@localhost',
  'mysql.sys@localhost',
];
/** Literal review SQL parser, including its explicit delimiter blocks. No SQL
 * body is rewritten, stripped, generated or replaced by fake metadata flags. */
export function nativeHeadReviewStatements(input: string) {
  let delimiter = ';',
    buffer = '';
  const statements: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (/^\s*--/.test(line)) continue;
    const command = /^\s*DELIMITER\s+(\S+)\s*$/.exec(line);
    if (command) {
      if (buffer.trim()) throw new Error('Unfinished review statement');
      delimiter = command[1]!;
      continue;
    }
    buffer += line + '\n';
    const trimmed = buffer.trimEnd();
    if (trimmed.endsWith(delimiter)) {
      const statement = trimmed.slice(0, -delimiter.length).trim();
      if (statement) statements.push(statement);
      buffer = '';
    }
  }
  if (buffer.trim()) throw new Error('Unfinished review statement');
  return statements;
}
export async function installNativeHeadFixture(
  admin: mysql.Connection,
  template: string,
  options: { families: readonly ('counter' | 'membership' | 'membershipRevision' | 'coupon')[] },
) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    decodeURIComponent(url.username) !== 'root' ||
    ![
      '/pos_rewrite_legacy_order_imports_test',
      '/pos_rewrite_checkout_test',
      '/pos_checkout_contract_test',
    ].includes(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('Explicit isolated native-head fixture required');
  const [identityRaw] = await admin.query<mysql.RowDataPacket[]>(
    'SELECT DATABASE() db,CURRENT_USER() account',
  );
  const identity = z
    .array(
      z.object({
        db: z
          .string()
          .regex(
            /^(?:(?:pos_rewrite_|quota_|native_head_)[A-Za-z0-9_]{1,50}|pos_checkout_contract_test)$/,
          ),
        account: z.enum(['root@localhost', 'root@%']),
      }),
    )
    .length(1)
    .parse(identityRaw)[0]!;
  const schema = identity.db,
    scope = mysql.escapeId(schema),
    suffix = randomUUID().replaceAll('-', '').slice(0, 10),
    password = 'fixture-only-' + randomUUID();
  const names = {
    audit: 'nh_audit_' + suffix,
    origin: 'nh_origin_' + suffix,
    membership: 'nh_member_' + suffix,
    membershipRevision: 'nh_revision_' + suffix,
    coupon: 'nh_coupon_' + suffix,
    counter: 'nh_counter_' + suffix,
    source: 'nh_source_' + suffix,
    publisher: 'nh_pub_' + suffix,
    app: 'nh_app_' + suffix,
  };
  const families = new Set(options.families);
  if (families.size !== options.families.length) throw new Error('Duplicate fixture family');
  const accounts = [
    names.audit,
    names.origin,
    names.source,
    names.app,
    ...(families.has('counter') ? [names.counter, names.publisher] : []),
    ...(families.has('membership') ? [names.membership] : []),
    ...(families.has('membershipRevision') ? [names.membershipRevision] : []),
    ...(families.has('coupon') ? [names.coupon] : []),
  ];
  const ownedTriggers: string[] = [],
    pools: mysql.Pool[] = [];
  let locked = false,
    cleaned = false;
  const grantee = (name: string) => mysql.escape(name) + "@'%'";
  const headMetadata: NativeHeadMetadataOptions = {
    auditDefiner: names.audit + '@%',
    originDefiner: names.origin + '@%',
    administrators: DBA,
    ...(families.has('membership') ? { membershipDefiner: names.membership + '@%' } : {}),
    ...(families.has('membershipRevision')
      ? { membershipRevisionDefiner: names.membershipRevision + '@%' }
      : {}),
    ...(families.has('coupon') ? { couponDefiner: names.coupon + '@%' } : {}),
    ...(families.has('counter')
      ? { counterDefiner: names.counter + '@%', publisherGrantee: names.publisher + '@%' }
      : {}),
  };
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    await Promise.all(pools.map((pool) => pool.end()));
    try {
      for (const trigger of ownedTriggers)
        await admin.query('DROP TRIGGER IF EXISTS ' + scope + '.' + mysql.escapeId(trigger));
      if (families.has('counter'))
        await admin.query('DROP PROCEDURE IF EXISTS ' + scope + '.pos_screening_sync_marker');
      await admin.query(
        'DROP FUNCTION IF EXISTS ' + scope + '.pos_rewrite_origin_history_metadata',
      );
      await admin.query(
        'DROP FUNCTION IF EXISTS ' + scope + '.pos_rewrite_origin_transaction_metadata',
      );
      for (const name of accounts.reverse())
        await admin.query('DROP USER IF EXISTS ' + grantee(name));
    } finally {
      if (locked) {
        await admin.query("SELECT RELEASE_LOCK('codex-native-head-global-fixture')");
        locked = false;
      }
    }
  }
  try {
    const [lock] = await admin.query<mysql.RowDataPacket[]>(
      "SELECT GET_LOCK('codex-native-head-global-fixture',60) acquired",
    );
    if (String(lock[0]?.acquired) !== '1')
      throw new Error('Native head fixture isolation unavailable');
    locked = true;
    const [tables] = await admin.query<mysql.RowDataPacket[]>(
      'SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',
      [schema],
    );
    const existing = new Set(tables.map((r) => String(r.name)));
    const fixture = verifiedMysqlFixture(admin, [
      'evidence/mysql-import-benefit-profile-schema.json',
      'evidence/mysql-screening-schema.json',
    ]);
    const missing = [
      'users',
      'orders',
      'has_products',
      'order_coupon_log',
      'coupons',
      'spiderman_screening_orders',
      ...(families.has('membershipRevision') ? ['user_eav'] : []),
    ].filter((name) => !existing.has(name));
    if (missing.length) await fixture.create(missing);
    await admin.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
    for (const name of accounts) {
      const active = [names.source, names.publisher, names.app].includes(name);
      await admin.query(
        'CREATE USER ' +
          grantee(name) +
          (active ? ' IDENTIFIED BY ' + mysql.escape(password) : ' ACCOUNT LOCK'),
      );
    }
    const withDefiner = (statement: string, owner: string) =>
      statement.replace(
        /^CREATE\s+(?:DEFINER\s*=\s*'[^']+'@'[^']+'\s+)?(TRIGGER|PROCEDURE|FUNCTION)\b/i,
        'CREATE DEFINER=' + grantee(owner) + ' $1',
      );
    async function install(statements: string[], owner: string) {
      for (const raw of statements) {
        const statement = withDefiner(raw, owner),
          table = /^CREATE TABLE(?: IF NOT EXISTS)?\s+`?([A-Za-z0-9_]+)/i.exec(statement),
          trigger = /^CREATE DEFINER=.*? TRIGGER\s+(\w+)/i.exec(statement),
          procedure = /^CREATE DEFINER=.*? PROCEDURE\s+(\w+)/i.exec(statement);
        if (table && existing.has(table[1]!)) continue;
        if (trigger) {
          await admin.query('DROP TRIGGER IF EXISTS ' + mysql.escapeId(trigger[1]!));
          ownedTriggers.push(trigger[1]!);
        }
        if (procedure)
          await admin.query('DROP PROCEDURE IF EXISTS ' + mysql.escapeId(procedure[1]!));
        await admin.query(statement);
        if (table) existing.add(table[1]!);
      }
    }
    // Head tables must exist before the locked owners receive their exact rights.
    const source = nativeHeadReviewStatements(
      readFileSync('compatibility/upstream/screening-origins/history-heads.review.sql', 'utf8'),
    );
    for (const statement of source.filter((s) => /^CREATE TABLE/.test(s)))
      if (!existing.has(/^CREATE TABLE\s+(\w+)/.exec(statement)![1]!)) {
        await admin.query(statement);
        existing.add(/^CREATE TABLE\s+(\w+)/.exec(statement)![1]!);
      }
    if (families.has('membership'))
      await admin.query(
        'CREATE TABLE IF NOT EXISTS pos_rewrite_membership_history_heads(customer_id BIGINT NOT NULL PRIMARY KEY,revision BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB',
      );
    if (families.has('membershipRevision')) {
      const version = nativeHeadReviewStatements(
        readFileSync('src/modules/checkout/cancellations/benefit-migration.sql', 'utf8'),
      ).find((statement) => /^CREATE TABLE pos_rewrite_membership_versions\s*\(/.test(statement));
      if (!version) throw new Error('Canonical membership versions schema required');
      if (!existing.has('pos_rewrite_membership_versions')) {
        await admin.query(version);
        existing.add('pos_rewrite_membership_versions');
      }
    }
    if (families.has('coupon'))
      await admin.query(
        'CREATE TABLE IF NOT EXISTS pos_rewrite_coupon_history_heads(kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,scope_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,revision BIGINT UNSIGNED NOT NULL,last_owner_nonce VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,owner_start_revision BIGINT UNSIGNED NULL,PRIMARY KEY(kind,scope_id)) ENGINE=InnoDB',
      );
    if (families.has('counter'))
      for (const statement of counterInstallationSql.filter((s) => /^CREATE TABLE/.test(s)))
        if (!existing.has(/^CREATE TABLE\s+(\w+)/.exec(statement)![1]!)) {
          await admin.query(statement);
          existing.add(/^CREATE TABLE\s+(\w+)/.exec(statement)![1]!);
        }
    async function grant(rights: string, target: string, owner: string) {
      await admin.query('GRANT ' + rights + ' ON ' + target + ' TO ' + grantee(owner));
    }
    await grant('SELECT, SHOW VIEW, SHOW_ROUTINE, TRIGGER, EVENT', '*.*', names.audit);
    for (const table of ['orders', 'users'])
      await grant('SELECT, TRIGGER', scope + '.' + mysql.escapeId(table), names.origin);
    await grant(
      'SELECT, INSERT, UPDATE',
      scope + '.pos_rewrite_screening_origin_history_heads',
      names.origin,
    );
    await grant('INSERT', scope + '.pos_rewrite_screening_origin_history_changes', names.origin);
    if (families.has('membership')) {
      for (const table of ['orders', 'has_products', 'users'])
        await grant('SELECT, TRIGGER', scope + '.' + mysql.escapeId(table), names.membership);
      await grant(
        'SELECT, INSERT, UPDATE',
        scope + '.pos_rewrite_membership_history_heads',
        names.membership,
      );
    }
    if (families.has('membershipRevision')) {
      for (const table of ['users', 'user_eav'])
        await grant(
          'SELECT, TRIGGER',
          scope + '.' + mysql.escapeId(table),
          names.membershipRevision,
        );
      // Pinned MySQL8.0.39 requires an UPDATE privilege for this exact
      // definer SELECT...FOR UPDATE. Only id is granted, never table UPDATE.
      await grant('UPDATE(id)', scope + '.users', names.membershipRevision);
      await grant(
        'SELECT, INSERT, UPDATE',
        scope + '.pos_rewrite_membership_versions',
        names.membershipRevision,
      );
    }
    if (families.has('coupon')) {
      for (const table of ['orders', 'order_coupon_log', 'coupons', 'users'])
        await grant('SELECT, TRIGGER', scope + '.' + mysql.escapeId(table), names.coupon);
      await grant(
        'SELECT, INSERT, UPDATE',
        scope + '.pos_rewrite_coupon_history_heads',
        names.coupon,
      );
    }
    if (families.has('counter')) {
      for (const table of ['orders', 'has_products', 'spiderman_screening_orders'])
        await grant('SELECT, TRIGGER', scope + '.' + mysql.escapeId(table), names.counter);
      await grant(
        'SELECT, INSERT, UPDATE',
        scope + '.pos_rewrite_screening_counter_heads',
        names.counter,
      );
      await grant('SELECT, UPDATE', scope + '.pos_rewrite_screening_counters', names.counter);
      await grant(
        'SELECT, INSERT, UPDATE, DELETE',
        scope + '.pos_rewrite_screening_contributions',
        names.counter,
      );
    }
    await install(source, names.origin);
    if (families.has('membership'))
      await install(
        nativeHeadReviewStatements(
          readFileSync(
            'compatibility/upstream/public-screening-writer/membership-history-writers.review.sql',
            'utf8',
          ),
        ),
        names.membership,
      );
    if (families.has('membershipRevision'))
      await install(
        nativeHeadReviewStatements(
          readFileSync('compatibility/upstream/pending-cancellation/membership-fence.sql', 'utf8'),
        ),
        names.membershipRevision,
      );
    if (families.has('coupon'))
      await install(nativeHeadReviewStatements(couponHistoryWritersReviewSql()), names.coupon);
    if (families.has('counter')) {
      for (const [table, name, column] of [
        ['spiderman_screening_orders', 'idx_user_id', 'user_id'],
        ['spiderman_screening_orders', 'idx_order_id', 'order_id'],
        ['spiderman_screening_orders', 'idx_has_product_id', 'has_product_id'],
        ['has_products', 'order_id', 'order_id'],
      ] as const) {
        const [indexes] = await admin.query<mysql.RowDataPacket[]>(
          'SELECT INDEX_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?',
          [schema, table, name],
        );
        if (!indexes.length)
          await admin.query(
            'CREATE INDEX ' +
              mysql.escapeId(name) +
              ' ON ' +
              mysql.escapeId(table) +
              '(' +
              mysql.escapeId(column) +
              ')',
          );
      }
      await install([...counterInstallationSql], names.counter);
      await grant('EXECUTE', 'PROCEDURE ' + scope + '.pos_screening_sync_marker', names.counter);
    }
    await admin.query('DROP FUNCTION IF EXISTS pos_rewrite_origin_history_metadata');
    await install(
      nativeHeadReviewStatements(
        readFileSync(
          'compatibility/upstream/screening-origins/history-security.review.sql',
          'utf8',
        ),
      ),
      names.audit,
    );
    await grant(
      'EXECUTE',
      'FUNCTION ' + scope + '.pos_rewrite_origin_history_metadata',
      names.audit,
    );
    await admin.query('DROP FUNCTION IF EXISTS pos_rewrite_origin_transaction_metadata');
    await install(
      nativeHeadReviewStatements(
        readFileSync(
          'compatibility/upstream/screening-origins/transaction-security.review.sql',
          'utf8',
        ),
      ),
      names.audit,
    );
    await grant(
      'EXECUTE',
      'FUNCTION ' + scope + '.pos_rewrite_origin_transaction_metadata',
      names.audit,
    );
    if (families.has('counter'))
      await grant(
        'EXECUTE',
        'FUNCTION ' + scope + '.pos_rewrite_origin_transaction_metadata',
        names.counter,
      );
    for (const name of [
      names.source,
      names.app,
      ...(families.has('counter') ? [names.publisher] : []),
    ]) {
      await grant('SELECT', scope + '.*', name);
      const [platform] = await admin.query<mysql.RowDataPacket[]>(
        "SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA='sys' AND TABLE_NAME='sys_config'",
      );
      if (platform.length) await grant('SELECT', '`sys`.`sys_config`', name);
      await grant('SHOW_ROUTINE', '*.*', name);
      await grant('EXECUTE', 'FUNCTION ' + scope + '.pos_rewrite_origin_history_metadata', name);
      await grant(
        'EXECUTE',
        'FUNCTION ' + scope + '.pos_rewrite_origin_transaction_metadata',
        name,
      );
    }
    for (const table of [
      'users',
      'orders',
      'has_products',
      'order_coupon_log',
      'coupons',
      'spiderman_screening_orders',
    ])
      await grant('INSERT, UPDATE, DELETE', scope + '.' + mysql.escapeId(table), names.app);
    if (families.has('membershipRevision')) {
      await grant('INSERT, UPDATE, DELETE', scope + '.user_eav', names.app);
      await grant('INSERT, UPDATE', scope + '.pos_rewrite_membership_versions', names.app);
    }
    if (families.has('counter')) {
      for (const table of ['pos_rewrite_screening_counter_heads', 'pos_rewrite_screening_counters'])
        await grant('INSERT, UPDATE', scope + '.' + table, names.publisher);
      await grant(
        'INSERT, DELETE',
        scope + '.pos_rewrite_screening_contributions',
        names.publisher,
      );
    }
    function database(name: string): Databases {
      const pool = mysql.createPool({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: name,
        password,
        database: schema,
        connectionLimit: 8,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
      pools.push(pool);
      return { get: () => drizzle(pool), close: async () => undefined };
    }
    const connectionUrl = (name: string) => {
      const value = new URL(template);
      value.username = name;
      value.password = password;
      value.pathname = '/' + schema;
      return value.href;
    };
    const sourceDb = database(names.source),
      appDb = database(names.app),
      publisherDb = families.has('counter') ? database(names.publisher) : undefined;
    const environment: Record<string, string> = {
      POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER: headMetadata.auditDefiner,
      POS_SCREENING_ORIGIN_HISTORY_DEFINER: headMetadata.originDefiner,
      POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES: JSON.stringify(DBA),
      POS_MEMBERSHIP_HISTORY_TRIGGER_DEFINER: headMetadata.membershipDefiner ?? '',
      POS_MEMBERSHIP_REVISION_TRIGGER_DEFINER: headMetadata.membershipRevisionDefiner ?? '',
      POS_COUPON_HISTORY_DEFINER: headMetadata.couponDefiner ?? '',
      POS_SCREENING_COUNTER_TRIGGER_DEFINER: headMetadata.counterDefiner ?? '',
      POS_SCREENING_COUNTER_PUBLISHER_GRANTEE: headMetadata.publisherGrantee ?? '',
    };
    return {
      headMetadata,
      sourceDb,
      sourceUrl: connectionUrl(names.source),
      appUrl: connectionUrl(names.app),
      publisherUrl: families.has('counter') ? connectionUrl(names.publisher) : undefined,
      appDb,
      publisherDb,
      environment,
      schema,
      names,
      fixture,
      close: cleanup,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
