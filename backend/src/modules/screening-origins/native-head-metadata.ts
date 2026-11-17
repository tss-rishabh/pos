import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { nativeHeadDescriptor as descriptor } from './native-head-metadata.generated.js';

export type NativeHeadTransaction = Pick<AdministrationTransaction, 'execute'>;
export interface NativeHeadMetadataOptions {
  auditDefiner: string;
  originDefiner: string;
  administrators: readonly string[];
  membershipDefiner?: string;
  couponDefiner?: string;
  counterDefiner?: string;
  publisherGrantee?: string;
}
export interface NativeHeadPolicy {
  policy: 'pos-screening-origin-history-head-integrity-v3';
  auditDefiner: string;
  metadataHash: string;
  qualifierHash: string;
  administrators: string[];
  participantsHash: string;
  participantQualifierHash: string;
}
function refuse(): never {
  throw new Error('SCREENING_ORIGIN_HISTORY_UNQUALIFIED');
}
// Absolute end preserves Python fullmatch semantics for source account names.
const accountPattern = /^[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}(?![\s\S])/;
const account = z.string().regex(accountPattern);
export const nativeHeadMetadataOptionsSchema = z
  .object({
    auditDefiner: account,
    originDefiner: account,
    administrators: z.array(account).max(32),
    membershipDefiner: account.optional(),
    couponDefiner: account.optional(),
    counterDefiner: account.optional(),
    publisherGrantee: account.optional(),
  })
  .strict()
  .superRefine((options, ctx) => {
    const administrators = new Set(options.administrators);
    const owners = [
      options.auditDefiner,
      options.originDefiner,
      options.membershipDefiner,
      options.couponDefiner,
      options.counterDefiner,
      options.publisherGrantee,
    ].filter((owner): owner is string => owner !== undefined);
    if (
      administrators.size !== options.administrators.length ||
      new Set(owners).size !== owners.length ||
      owners.some((owner) => administrators.has(owner))
    )
      ctx.addIssue({ code: 'custom', message: 'History metadata owners must be isolated' });
  });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const strictMode = (value: string) =>
  value.split(',').some((mode) => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(mode));
const normal = (value: string) => value.trim().split(/\s+/).join(' ').replace(/;+$/, '');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function canonicalNativeHeadJson(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(sorted);
    if (typeof item === 'object' && item !== null)
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sorted((item as Record<string, unknown>)[key])]),
      );
    return refuse();
  };
  return JSON.stringify(sorted(value));
}
export function readNativeHeadMetadataOptions(
  env: NodeJS.ProcessEnv = process.env,
): NativeHeadMetadataOptions {
  let administrators: unknown;
  try {
    administrators = JSON.parse(env.POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES ?? '[]');
  } catch {
    return refuse();
  }
  if (!Array.isArray(administrators) || administrators.some((value) => typeof value !== 'string'))
    return refuse();
  const options = {
    auditDefiner: env.POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER ?? '',
    originDefiner: env.POS_SCREENING_ORIGIN_HISTORY_DEFINER ?? '',
    administrators: administrators as string[],
    ...(env.POS_MEMBERSHIP_HISTORY_TRIGGER_DEFINER
      ? { membershipDefiner: env.POS_MEMBERSHIP_HISTORY_TRIGGER_DEFINER }
      : {}),
    ...(env.POS_COUPON_HISTORY_DEFINER ? { couponDefiner: env.POS_COUPON_HISTORY_DEFINER } : {}),
    ...(env.POS_SCREENING_COUNTER_TRIGGER_DEFINER
      ? { counterDefiner: env.POS_SCREENING_COUNTER_TRIGGER_DEFINER }
      : {}),
    ...(env.POS_SCREENING_COUNTER_PUBLISHER_GRANTEE
      ? { publisherGrantee: env.POS_SCREENING_COUNTER_PUBLISHER_GRANTEE }
      : {}),
  };
  const parsed = nativeHeadMetadataOptionsSchema.safeParse(options);
  return parsed.success ? parsed.data : refuse();
}
const trigger = z
  .object({
    name: z.string(),
    tableName: z.string(),
    event: z.enum(['INSERT', 'UPDATE', 'DELETE']),
    timing: z.literal('AFTER'),
    hash,
    definer: account,
    sqlMode: z.string(),
  })
  .strict();
const procedure = z
  .object({
    name: z.string(),
    kind: z.literal('PROCEDURE'),
    security: z.literal('DEFINER'),
    hash,
    definer: account,
  })
  .strict();
const documentSchema = z
  .object({
    triggers: z
      .array(
        z
          .object({
            name: z.string(),
            action: z.string(),
            sourceTable: z.string(),
            body: z.string(),
            owner: account,
            sqlMode: z.string(),
          })
          .strict(),
      )
      .max(1000),
    membershipTriggers: z.array(trigger).max(1000),
    couponTriggers: z.array(trigger).max(1000),
    counterTriggers: z.array(trigger).max(1000),
    counterProcedures: z.array(procedure).max(1000),
    accounts: z.array(z.object({ name: account, locked: z.enum(['Y', 'N']) }).strict()).max(1000),
    roles: z.array(z.object({ name: account, role: account }).strict()).max(1000),
    proxies: z
      .array(
        z
          .object({
            name: account,
            target: z.string(),
            grantable: z.union([z.literal(0), z.literal(1)]),
          })
          .strict(),
      )
      .max(1000),
    privileges: z
      .array(
        z
          .object({
            grantee: z.string(),
            scope: z.enum(['global', 'schema', 'table', 'column']),
            schema: z.string(),
            table: z.string(),
            privilege: z.string(),
            grantable: z.enum(['YES', 'NO']),
            target: z.enum(['global', 'protected-schema', 'grants', 'control', 'watched', 'other']),
          })
          .strict(),
      )
      .max(1000),
    routineGrants: z
      .array(
        z
          .object({
            name: account,
            schema: z.string(),
            routine: z.string(),
            kind: z.enum(['FUNCTION', 'PROCEDURE']),
            privileges: z.string(),
          })
          .strict(),
      )
      .max(1000),
    objects: z
      .array(
        z
          .object({
            schema: z.string(),
            name: z.string(),
            kind: z.enum(['FUNCTION', 'PROCEDURE', 'VIEW', 'TRIGGER', 'EVENT']),
            owner: account,
            security: z.enum(['DEFINER', 'INVOKER']),
            usesRoutines: z.union([z.literal(0), z.literal(1)]),
          })
          .strict(),
      )
      .max(1000),
    aliases: z.array(z.unknown()).max(1000),
    replicationChannels: z.array(z.unknown()).max(1000),
    tables: z
      .array(z.object({ name: z.string(), kind: z.string(), engine: z.string() }).strict())
      .max(1000),
    foreignKeys: z
      .array(
        z
          .object({
            table: z.string(),
            column: z.string(),
            update: z.enum(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION']),
            delete: z.enum(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION']),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type NativeHeadTrigger = z.infer<typeof trigger>;
export type NativeHeadProcedure = z.infer<typeof procedure>;
export interface NativeHeadMetadata {
  membershipTriggers: NativeHeadTrigger[];
  couponTriggers: NativeHeadTrigger[];
  counterTriggers: NativeHeadTrigger[];
  counterProcedures: NativeHeadProcedure[];
  policy: NativeHeadPolicy;
}
const INFO = 'pos_rewrite_origin_history_metadata';
const HEADS = [
  'pos_rewrite_screening_origin_history_heads',
  'pos_rewrite_screening_origin_history_changes',
];
const WATCHED = [
  'orders',
  'users',
  'has_products',
  'order_coupon_log',
  'coupons',
  'spiderman_screening_orders',
];
const familyHeads = {
  membership: { pos_rewrite_membership_history_heads: ['SELECT', 'INSERT', 'UPDATE'] },
  coupon: { pos_rewrite_coupon_history_heads: ['SELECT', 'INSERT', 'UPDATE'] },
  counter: {
    pos_rewrite_screening_counter_heads: ['SELECT', 'INSERT', 'UPDATE'],
    pos_rewrite_screening_counters: ['SELECT', 'UPDATE'],
    pos_rewrite_screening_contributions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
};
const publisherRights: Record<string, string[]> = {
  pos_rewrite_screening_counter_heads: ['SELECT', 'INSERT', 'UPDATE'],
  pos_rewrite_screening_counters: ['SELECT', 'INSERT', 'UPDATE'],
  pos_rewrite_screening_contributions: ['SELECT', 'INSERT', 'DELETE'],
};
const allHeads = new Set([
  ...HEADS,
  ...Object.values(familyHeads).flatMap((item) => Object.keys(item)),
]);
const globalRead = new Set([
  'USAGE',
  'SELECT',
  'SHOW DATABASES',
  'SHOW VIEW',
  'SHOW_ROUTINE',
  'SHOW ROUTINE',
  'PROCESS',
  'REPLICATION CLIENT',
  'REPLICATION SLAVE',
  'REPLICATION REPLICA',
]);
const sourceRead = ['SELECT', 'SHOW VIEW', 'REFERENCES'];
const tableWrite = ['SELECT', 'SHOW VIEW', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'INDEX'];
const auditRights = ['SELECT', 'SHOW VIEW', 'SHOW_ROUTINE', 'TRIGGER', 'EVENT'];
interface OwnerSpec {
  names: Set<string>;
  watched: Set<string>;
  heads: Record<string, string[]>;
  procedures: Record<string, string>;
  publisher?: boolean;
}
async function query(tx: NativeHeadTransaction, statement: string): Promise<unknown[]> {
  const [raw] = await tx.execute(sql.raw(statement));
  if (!Array.isArray(raw)) return refuse();
  return raw;
}
async function one(tx: NativeHeadTransaction, statement: string): Promise<Record<string, unknown>> {
  const values = await query(tx, statement);
  if (
    values.length !== 1 ||
    !values[0] ||
    typeof values[0] !== 'object' ||
    Array.isArray(values[0])
  )
    return refuse();
  return values[0] as Record<string, unknown>;
}
/** The fixed SQL function is read-only. All qualification and policy hashing
 * happen locally while the caller's existing SQL transaction retains MDL. */
export async function readNativeHeadMetadata(
  tx: NativeHeadTransaction,
  options: NativeHeadMetadataOptions,
  mode: { purpose: 'application' | 'counter-publication' } = { purpose: 'application' },
): Promise<NativeHeadMetadata> {
  if (mode.purpose !== 'application' && mode.purpose !== 'counter-publication') return refuse();
  const publication = mode.purpose === 'counter-publication';
  if (!nativeHeadMetadataOptionsSchema.safeParse(options).success) return refuse();
  const { auditDefiner: audit, originDefiner: origin } = options;
  if (
    !accountPattern.test(audit) ||
    !accountPattern.test(origin) ||
    audit === origin ||
    !Array.isArray(options.administrators) ||
    options.administrators.length > 32 ||
    options.administrators.some((item) => typeof item !== 'string' || !accountPattern.test(item))
  )
    return refuse();
  const administrators = new Set(options.administrators);
  if (
    administrators.size !== options.administrators.length ||
    administrators.has(audit) ||
    administrators.has(origin)
  )
    return refuse();
  const caller = await one(
    tx,
    'SELECT CURRENT_USER() AS account,CURRENT_ROLE() AS roles,@@SESSION.proxy_user AS proxyAccount,@@GLOBAL.mandatory_roles AS mandatoryRoles,CAST(@@GLOBAL.performance_schema AS CHAR) AS performanceSchema',
  );
  const current = account.safeParse(caller.account);
  if (
    !current.success ||
    caller.roles !== 'NONE' ||
    caller.proxyAccount !== null ||
    !['', 'NONE'].includes(String(caller.mandatoryRoles)) ||
    caller.performanceSchema !== '1' ||
    administrators.has(current.data) ||
    [audit, origin].includes(current.data)
  )
    return refuse();
  if (
    publication &&
    (!options.publisherGrantee ||
      current.data !== options.publisherGrantee ||
      !options.counterDefiner)
  )
    return refuse();
  const schemaValue = await one(tx, 'SELECT DATABASE() AS db');
  if (typeof schemaValue.db !== 'string' || !/^[A-Za-z0-9_]{1,64}(?![\s\S])/.test(schemaValue.db))
    return refuse();
  const schema = schemaValue.db;
  const grants = await query(tx, 'SHOW GRANTS FOR CURRENT_USER()');
  // skip-grant-tables is a startup option, not a queryable MySQL8 system
  // variable. Require a real authenticated account and successful nonempty
  // server grant resolution; an unavailable grant table never qualifies.
  if (!grants.length || grants.length >= 65) return refuse();
  for (const row of grants) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 1)
      return refuse();
    const value = Object.values(row)[0];
    if (typeof value !== 'string') return refuse();
    const match = /^GRANT (.+) ON (.+) TO .+$/.exec(value);
    if (!match || /WITH GRANT OPTION/i.test(value)) return refuse();
    const rights = match[1]!.split(',').map((item) => item.trim().toUpperCase());
    const target = match[2]!.replace(/`/g, '');
    if (
      rights.some(
        (right) =>
          ![
            'USAGE',
            'SELECT',
            'SHOW VIEW',
            'SHOW_ROUTINE',
            'SHOW ROUTINE',
            'PROCESS',
            'EXECUTE',
            'INSERT',
            'UPDATE',
            'DELETE',
            'REFERENCES',
            'INDEX',
          ].includes(right),
      )
    )
      return refuse();
    if (rights.some((right) => ['INSERT', 'UPDATE', 'DELETE', 'INDEX'].includes(right))) {
      if (publication) {
        const table = target.startsWith(schema + '.') ? target.slice(schema.length + 1) : '';
        const allowed = publisherRights[table];
        if (!allowed || rights.some((right) => !allowed.includes(right))) return refuse();
      } else if (
        target === '*.*' ||
        target.endsWith('.*') ||
        allHeads.has(target.split('.').at(-1)!)
      )
        return refuse();
    }
    if (rights.includes('EXECUTE') && target !== `FUNCTION ${schema}.${INFO}`) return refuse();
  }
  const declared = new Set([...HEADS, ...WATCHED]);
  for (const family of ['membership', 'coupon', 'counter'] as const) {
    if (options[`${family}Definer`])
      for (const name of Object.keys(familyHeads[family])) declared.add(name);
  }
  for (const table of [...declared].sort())
    await tx.execute(sql.raw('SELECT 1 FROM `' + table + '` WHERE FALSE'));
  const routine = await one(
    tx,
    "SELECT /*+ MAX_EXECUTION_TIME(3000) */ DEFINER AS owner,SECURITY_TYPE AS security,SQL_DATA_ACCESS AS accessMode,ROUTINE_DEFINITION AS body FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME='pos_rewrite_origin_history_metadata' AND ROUTINE_TYPE='FUNCTION'",
  );
  if (
    routine.owner !== audit ||
    routine.security !== 'DEFINER' ||
    routine.accessMode !== 'READS SQL DATA' ||
    typeof routine.body !== 'string' ||
    Buffer.byteLength(routine.body) > 60000 ||
    digest(normal(routine.body)) !== descriptor.metadataHash
  )
    return refuse();
  const result = await one(
    tx,
    'SELECT /*+ MAX_EXECUTION_TIME(3000) */ pos_rewrite_origin_history_metadata() AS document',
  );
  let raw: unknown = result.document;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > 500000) return refuse();
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return refuse();
    }
  } else if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 500000) return refuse();
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) return refuse();
  const data = parsed.data;
  const owners = new Map<string, OwnerSpec>();
  const families: Record<string, unknown> = {};
  for (const family of ['membership', 'coupon', 'counter'] as const) {
    const actual = data[`${family}Triggers`];
    const owner = options[`${family}Definer`];
    if (!actual.length) {
      if (owner || (family === 'counter' && data.counterProcedures.length)) return refuse();
      continue;
    }
    const expected = descriptor.families[family];
    if (
      !owner ||
      !accountPattern.test(owner) ||
      owner === origin ||
      owners.has(owner) ||
      actual.length !== expected.definitions.length
    )
      return refuse();
    const seen = new Set<string>();
    for (const item of actual) {
      const wanted = expected.definitions.find((item2) => item2.name === item.name);
      if (
        !wanted ||
        seen.has(item.name) ||
        item.definer !== owner ||
        !strictMode(item.sqlMode) ||
        Object.entries(wanted).some(
          ([key, value]) => item[key as keyof NativeHeadTrigger] !== value,
        )
      )
        return refuse();
      seen.add(item.name);
    }
    const procedures: Record<string, string> = {};
    if (family === 'counter') {
      const wanted = descriptor.families.counter.procedure;
      const item = data.counterProcedures[0];
      if (
        data.counterProcedures.length !== 1 ||
        !item ||
        item.definer !== owner ||
        Object.entries(wanted).some(
          ([key, value]) => item[key as keyof NativeHeadProcedure] !== value,
        )
      )
        return refuse();
      procedures[item.name] = 'PROCEDURE';
    }
    owners.set(owner, {
      names: seen,
      watched: new Set(expected.definitions.map((item) => item.tableName)),
      heads: familyHeads[family],
      procedures,
    });
    families[family] = {
      owner,
      definitions: expected.definitions,
      manifestHash: expected.manifestHash,
    };
  }
  if (options.publisherGrantee) {
    const owner = options.publisherGrantee;
    if (!accountPattern.test(owner) || owner === origin || owners.has(owner) || !families.counter)
      return refuse();
    const rights = publisherRights;
    owners.set(owner, {
      names: new Set(),
      watched: new Set(),
      heads: rights,
      procedures: {},
      publisher: true,
    });
    families['counter-publication'] = {
      owner,
      rights: Object.fromEntries(
        Object.entries(rights).map(([key, value]) => [key, [...value].sort()]),
      ),
    };
  }
  if (publication && !families.counter) return refuse();
  for (const owner of owners.keys())
    if (
      administrators.has(owner) ||
      owner === audit ||
      (owner === current.data && !(publication && owner === options.publisherGrantee))
    )
      return refuse();
  owners.set(origin, {
    names: new Set(descriptor.originTriggers.map((item) => item.name)),
    watched: new Set(['orders', 'users']),
    heads: {
      pos_rewrite_screening_origin_history_heads: ['SELECT', 'INSERT', 'UPDATE'],
      pos_rewrite_screening_origin_history_changes: ['INSERT'],
    },
    procedures: {},
  });
  const heads = new Set(HEADS);
  for (const spec of owners.values()) for (const name of Object.keys(spec.heads)) heads.add(name);
  const accounts = new Map<string, string>();
  for (const item of data.accounts) {
    if (accounts.has(item.name)) return refuse();
    accounts.set(item.name, item.locked);
  }
  if (
    [...owners].some(([owner, spec]) => accounts.get(owner) !== (spec.publisher ? 'N' : 'Y')) ||
    accounts.get(audit) !== 'Y' ||
    accounts.get(current.data) !== 'N' ||
    [...administrators].some((owner) => !accounts.has(owner))
  )
    return refuse();
  const isolated = new Set([...owners.keys(), audit, current.data]);
  for (const item of data.roles)
    if (
      !accounts.has(item.name) ||
      !accounts.has(item.role) ||
      isolated.has(item.name) ||
      isolated.has(item.role) ||
      administrators.has(item.name) !== administrators.has(item.role)
    )
      return refuse();
  for (const item of data.proxies) {
    if (
      !accounts.has(item.name) ||
      (item.target !== '@' && !accountPattern.test(item.target)) ||
      isolated.has(item.name) ||
      isolated.has(item.target) ||
      (!administrators.has(item.name) &&
        (administrators.has(item.target) || item.target === '@' || item.grantable === 1))
    )
      return refuse();
  }
  if (data.triggers.length !== 4) return refuse();
  const originNames = new Set<string>();
  for (const item of data.triggers) {
    const wanted = descriptor.originTriggers.find((expected) => expected.name === item.name);
    if (
      !wanted ||
      originNames.has(item.name) ||
      item.owner !== origin ||
      item.action !== wanted.action ||
      item.sourceTable !== wanted.table ||
      digest(normal(item.body)) !== wanted.hash ||
      !strictMode(item.sqlMode)
    )
      return refuse();
    originNames.add(item.name);
  }
  const auditGlobal = new Set<string>();
  for (const item of data.privileges) {
    const match = /^'([A-Za-z0-9_.$-]{1,64})'@'([A-Za-z0-9_.:%-]{1,255})'(?![\s\S])/.exec(
      item.grantee,
    );
    if (!match) return refuse();
    const owner = match[1] + '@' + match[2];
    if (!accounts.has(owner)) return refuse();
    const spec = owners.get(owner);
    if (spec) {
      const allowed =
        item.scope === 'global'
          ? spec.publisher
            ? ['USAGE', 'SHOW_ROUTINE', 'SHOW ROUTINE']
            : ['USAGE']
          : spec.publisher && item.scope === 'schema' && item.schema === schema
            ? sourceRead
            : spec.publisher &&
                item.scope === 'table' &&
                item.schema === schema &&
                WATCHED.includes(item.table)
              ? ['SELECT']
              : item.scope === 'table' && item.schema === schema && spec.watched.has(item.table)
                ? ['SELECT', 'TRIGGER']
                : item.scope === 'table' && item.schema === schema
                  ? (spec.heads[item.table] ?? [])
                  : [];
      if (item.grantable !== 'NO' || !allowed.includes(item.privilege)) return refuse();
    } else if (owner === audit) {
      if (
        item.scope !== 'global' ||
        item.grantable !== 'NO' ||
        ![...auditRights, 'USAGE'].includes(item.privilege)
      )
        return refuse();
      auditGlobal.add(item.privilege);
    } else if (!administrators.has(owner)) {
      if (
        (item.scope === 'global' && (!globalRead.has(item.privilege) || item.grantable !== 'NO')) ||
        (item.scope === 'schema' &&
          (item.privilege === 'EXECUTE' ||
            (item.target === 'protected-schema' && !sourceRead.includes(item.privilege)))) ||
        (['table', 'column'].includes(item.scope) &&
          ((item.target === 'grants' && !['SELECT', 'SHOW VIEW'].includes(item.privilege)) ||
            (item.target === 'control' && item.privilege !== 'SELECT') ||
            (item.target === 'watched' && !tableWrite.includes(item.privilege))))
      )
        return refuse();
    }
  }
  if (auditRights.some((right) => !auditGlobal.has(right))) return refuse();
  for (const item of data.routineGrants) {
    if (!accounts.has(item.name)) return refuse();
    const rights = new Set(item.privileges.split(',').map((value) => value.trim().toUpperCase()));
    if (administrators.has(item.name)) continue;
    const spec = owners.get(item.name);
    const metadata =
      item.schema === schema &&
      item.routine === INFO &&
      item.kind === 'FUNCTION' &&
      rights.size === 1 &&
      rights.has('EXECUTE');
    if (spec) {
      if (spec.publisher && metadata) continue;
      if (
        item.schema !== schema ||
        spec.procedures[item.routine] !== item.kind ||
        rights.size !== 1 ||
        !rights.has('EXECUTE')
      )
        return refuse();
    } else if (item.name === audit || !metadata) return refuse();
  }
  const objects = new Set<string>();
  const identity = (schemaName: string, name: string, kind: string) =>
    canonicalNativeHeadJson([schemaName, name, kind]);
  for (const item of data.objects) {
    const id = identity(item.schema, item.name, item.kind);
    if (!accounts.has(item.owner) || objects.has(id)) return refuse();
    objects.add(id);
    const spec = owners.get(item.owner);
    if (item.owner === audit) {
      if (id !== identity(schema, INFO, 'FUNCTION') || item.security !== 'DEFINER') return refuse();
    } else if (spec) {
      if (
        item.schema !== schema ||
        !(
          (item.kind === 'TRIGGER' && spec.names.has(item.name)) ||
          spec.procedures[item.name] === item.kind
        ) ||
        item.security !== 'DEFINER'
      )
        return refuse();
    } else if (administrators.has(item.owner)) {
      if (
        ['TRIGGER', 'EVENT'].includes(item.kind) ||
        (item.kind === 'VIEW' && item.security === 'DEFINER' && item.usesRoutines === 1)
      )
        return refuse();
    }
  }
  if (!objects.has(identity(schema, INFO, 'FUNCTION'))) return refuse();
  for (const spec of owners.values()) {
    for (const name of spec.names)
      if (!objects.has(identity(schema, name, 'TRIGGER'))) return refuse();
    for (const [name, kind] of Object.entries(spec.procedures))
      if (!objects.has(identity(schema, name, kind))) return refuse();
  }
  if (data.aliases.length || data.replicationChannels.length) return refuse();
  const tables = new Set<string>();
  const requiredTables = new Set([...heads, ...WATCHED]);
  for (const item of data.tables) {
    if (
      tables.has(item.name) ||
      !requiredTables.has(item.name) ||
      item.kind !== 'BASE TABLE' ||
      item.engine !== 'InnoDB'
    )
      return refuse();
    tables.add(item.name);
  }
  if (tables.size !== requiredTables.size) return refuse();
  for (const table of [...requiredTables].sort()) {
    const actual = await one(tx, 'SHOW CREATE TABLE `' + table + '`');
    if (
      actual.Table !== table ||
      typeof actual['Create Table'] !== 'string' ||
      Buffer.byteLength(actual['Create Table']) > 200000 ||
      !new RegExp('^CREATE TABLE\\s+`' + table + '`\\s*\\(').test(actual['Create Table'])
    )
      return refuse();
  }
  for (const item of data.foreignKeys)
    if (
      !requiredTables.has(item.table) ||
      heads.has(item.table) ||
      !['RESTRICT', 'NO ACTION'].includes(item.update) ||
      !['RESTRICT', 'NO ACTION'].includes(item.delete)
    )
      return refuse();
  const policy: NativeHeadPolicy = {
    policy: 'pos-screening-origin-history-head-integrity-v3',
    auditDefiner: audit,
    metadataHash: descriptor.metadataHash,
    qualifierHash: descriptor.qualifierHash,
    administrators: [...administrators].sort(),
    participantsHash: digest(canonicalNativeHeadJson(families)),
    participantQualifierHash: descriptor.participantQualifierHash,
  };
  return {
    membershipTriggers: data.membershipTriggers,
    couponTriggers: data.couponTriggers,
    counterTriggers: data.counterTriggers,
    counterProcedures: data.counterProcedures,
    policy,
  };
}
