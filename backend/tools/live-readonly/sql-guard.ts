/**
 * Statement guard for the live read-only production parity suite (Phase F1).
 *
 * Every statement the suite can send to production passes through {@link guardStatement} before
 * any byte reaches the server. The guard refuses everything that is not a plain read:
 *
 * - allowed reads: SELECT, WITH … SELECT, a parenthesised SELECT (UNION form), SHOW, DESCRIBE,
 *   DESC and EXPLAIN (whose target must itself pass the read rules);
 * - allowed session setup: exactly `SET SESSION TRANSACTION READ ONLY` and
 *   `SET SESSION MAX_EXECUTION_TIME=<1..10000>`;
 * - allowed transaction brackets that Drizzle emits around the rewrite's read code: BEGIN,
 *   START TRANSACTION [WITH CONSISTENT SNAPSHOT] [READ ONLY], COMMIT, ROLLBACK, and the
 *   next-transaction `SET TRANSACTION ISOLATION LEVEL <level>`. None of them can change data, and
 *   the session is already READ ONLY, so START TRANSACTION READ WRITE is refused;
 * - everything else is refused: DML, DDL, CALL, LOAD, HANDLER, LOCK/UNLOCK, DO, any other SET,
 *   SAVEPOINT, `SELECT … INTO`, MySQL executable comments, and any multi-statement text.
 *
 * Locking reads: `SELECT … FOR UPDATE`, `FOR SHARE` and `LOCK IN SHARE MODE` are refused by
 * default (and always at the core-connection layer). The rewrite's authorization-confirmation
 * code issues them on the writer; MySQL itself rejects FOR UPDATE in a READ ONLY session
 * (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION) but would take shared row locks for FOR SHARE. The
 * live harness therefore opts into `lockingReads: 'downgrade'`, which removes exactly one trailing
 * locking clause at statement depth and sends the statement as a plain consistent (non-locking)
 * read. A locking clause anywhere else is refused. Nothing that takes a row lock is ever sent.
 */

export type GuardErrorCode =
  | 'RO_GUARD_EMPTY'
  | 'RO_GUARD_MULTI_STATEMENT'
  | 'RO_GUARD_EXECUTABLE_COMMENT'
  | 'RO_GUARD_UNTERMINATED'
  | 'RO_GUARD_STATEMENT'
  | 'RO_GUARD_SET'
  | 'RO_GUARD_WRITE_KEYWORD'
  | 'RO_GUARD_LOCKING_READ'
  | 'RO_GUARD_INTO';

/** Thrown before a refused statement is sent. The message never contains the statement text. */
export class ReadOnlyGuardError extends Error {
  readonly code: GuardErrorCode;
  constructor(code: GuardErrorCode, detail: string) {
    super(`Read-only guard refused a statement (${code}): ${detail}`);
    this.name = 'ReadOnlyGuardError';
    this.code = code;
  }
}

export interface GuardOptions {
  /**
   * `refuse` (default): every locking read is refused. `downgrade`: one trailing FOR UPDATE /
   * FOR SHARE [NOWAIT | SKIP LOCKED] / LOCK IN SHARE MODE clause is removed before sending.
   */
  lockingReads?: 'refuse' | 'downgrade';
}

export type StatementKind = 'read' | 'session' | 'transaction';
export interface GuardedStatement {
  kind: StatementKind;
  /** The text to send. Identical to the input unless a locking clause was downgraded. */
  sql: string;
  /** `true` when a trailing locking clause was removed. */
  downgraded: boolean;
  /** The removed clause's lock mode, when one was removed. */
  lock?: 'update' | 'share';
  /** `true` for SELECT-family statements (the ones the plan gate EXPLAINs first). */
  explainable: boolean;
}

interface Token {
  kind: 'word' | 'punct' | 'number' | 'string' | 'identifier' | 'variable';
  /** Upper-cased for words, the character for punctuation. */
  value: string;
  start: number;
  end: number;
  depth: number;
}

/** Splits SQL into tokens, skipping comments, string literals and quoted identifiers. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0,
    index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      if (text[index + 2] === '!')
        throw new ReadOnlyGuardError(
          'RO_GUARD_EXECUTABLE_COMMENT',
          'MySQL executable comments are not allowed.',
        );
      const close = text.indexOf('*/', index + 2);
      if (close < 0) throw new ReadOnlyGuardError('RO_GUARD_UNTERMINATED', 'Unterminated comment.');
      index = close + 2;
      continue;
    }
    if (char === '#' || (char === '-' && next === '-' && /[\s]/.test(text[index + 2] ?? ' '))) {
      const close = text.indexOf('\n', index);
      index = close < 0 ? length : close + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const start = index;
      index += 1;
      let closed = false;
      while (index < length) {
        const current = text[index]!;
        if (current === '\\' && char !== '`') {
          index += 2;
          continue;
        }
        if (current === char) {
          if (text[index + 1] === char) {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed)
        throw new ReadOnlyGuardError('RO_GUARD_UNTERMINATED', 'Unterminated quoted text.');
      tokens.push({
        kind: char === '`' ? 'identifier' : 'string',
        value: '',
        start,
        end: index,
        depth,
      });
      continue;
    }
    if (char === '@') {
      const start = index;
      index += 1;
      while (index < length && /[@\w.$]/.test(text[index]!)) index += 1;
      tokens.push({ kind: 'variable', value: text.slice(start, index), start, end: index, depth });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      while (index < length && /[\w$]/.test(text[index]!)) index += 1;
      tokens.push({
        kind: 'word',
        value: text.slice(start, index).toUpperCase(),
        start,
        end: index,
        depth,
      });
      continue;
    }
    if (/\d/.test(char)) {
      const start = index;
      while (index < length && /[\w.]/.test(text[index]!)) index += 1;
      tokens.push({ kind: 'number', value: text.slice(start, index), start, end: index, depth });
      continue;
    }
    if (char === ')') depth -= 1;
    tokens.push({ kind: 'punct', value: char, start: index, end: index + 1, depth });
    if (char === '(') depth += 1;
    index += 1;
  }
  return tokens;
}

const words = (tokens: readonly Token[]) => tokens.map((token) => token.value).join(' ');
const sessionReadOnly = /^SET SESSION TRANSACTION READ ONLY$/;
const isolation =
  /^SET TRANSACTION ISOLATION LEVEL (?:REPEATABLE READ|READ COMMITTED|READ UNCOMMITTED|SERIALIZABLE)$/;
const startTransaction = /^START TRANSACTION(?: WITH CONSISTENT SNAPSHOT)?(?: ,)?(?: READ ONLY)?$/;
/** Maximum statement time the suite may configure, in milliseconds. */
export const maxExecutionTimeLimit = 10_000;

/** Keywords that never appear in a read statement as anything but a write or side effect. */
const forbiddenAnywhere = new Set([
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'CALL',
  'HANDLER',
  'LOAD',
  'LOAD_FILE',
  'UNLOCK',
  'OUTFILE',
  'DUMPFILE',
  'SAVEPOINT',
  'RELEASE',
  'PREPARE',
  'DEALLOCATE',
  'KILL',
  'SHUTDOWN',
  'FLUSH',
  'RESET',
  'PURGE',
  'INSTALL',
  'UNINSTALL',
  'IMPORT',
  'OPTIMIZE',
  'ANALYZE',
  'REPAIR',
  'CHECKSUM',
  'GET_LOCK',
  'RELEASE_LOCK',
  'RELEASE_ALL_LOCKS',
  'SLEEP',
  'BENCHMARK',
]);
/** Keywords that are also string functions: refused unless used as a call, e.g. `REPLACE(`. */
const forbiddenUnlessCall = new Set(['INSERT', 'REPLACE']);

function checkRead(
  tokens: readonly Token[],
  options: GuardOptions,
): { end: number; lock?: 'update' | 'share' } {
  let end = tokens.length;
  const tail = (count: number) =>
    tokens
      .slice(Math.max(0, end - count), end)
      .map((token) => (token.depth === 0 && token.kind === 'word' ? token.value : '\u0000'))
      .join(' ');
  // One trailing locking clause at statement depth: FOR UPDATE | FOR SHARE [NOWAIT | SKIP LOCKED],
  // or LOCK IN SHARE MODE.
  let locking: { from: number; update: boolean } | undefined;
  for (const mode of ['UPDATE', 'SHARE'])
    for (const suffix of ['', ' NOWAIT', ' SKIP LOCKED']) {
      const clause = `FOR ${mode}${suffix}`,
        count = clause.split(' ').length;
      if (tail(count) === clause) locking = { from: end - count, update: mode === 'UPDATE' };
    }
  if (!locking && tail(4) === 'LOCK IN SHARE MODE') locking = { from: end - 4, update: false };
  if (locking && options.lockingReads !== 'downgrade')
    throw new ReadOnlyGuardError(
      'RO_GUARD_LOCKING_READ',
      locking.update ? 'SELECT … FOR UPDATE is refused.' : 'Locking reads are refused.',
    );
  if (locking) end = locking.from;
  for (let index = 0; index < end; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'word') continue;
    if (forbiddenAnywhere.has(token.value))
      throw new ReadOnlyGuardError('RO_GUARD_WRITE_KEYWORD', `Keyword ${token.value} is refused.`);
    if (forbiddenUnlessCall.has(token.value) && tokens[index + 1]?.value !== '(')
      throw new ReadOnlyGuardError('RO_GUARD_WRITE_KEYWORD', `Keyword ${token.value} is refused.`);
    if (token.value === 'INTO')
      throw new ReadOnlyGuardError('RO_GUARD_INTO', 'SELECT … INTO is refused.');
    if (token.value === 'FOR' && ['UPDATE', 'SHARE'].includes(tokens[index + 1]?.value ?? ''))
      throw new ReadOnlyGuardError('RO_GUARD_LOCKING_READ', 'Nested locking reads are refused.');
    if (token.value === 'LOCK')
      throw new ReadOnlyGuardError('RO_GUARD_LOCKING_READ', 'Locking reads are refused.');
  }
  return locking ? { end, lock: locking.update ? 'update' : 'share' } : { end };
}

/**
 * Classifies one statement, or throws {@link ReadOnlyGuardError}. Pure: it never sends anything.
 */
export function guardStatement(text: string, options: GuardOptions = {}): GuardedStatement {
  if (typeof text !== 'string')
    throw new ReadOnlyGuardError('RO_GUARD_STATEMENT', 'Statement text is not a string.');
  const tokens = tokenize(text);
  if (!tokens.length) throw new ReadOnlyGuardError('RO_GUARD_EMPTY', 'Empty statement.');
  if (tokens.some((token) => token.kind === 'punct' && token.value === ';'))
    throw new ReadOnlyGuardError('RO_GUARD_MULTI_STATEMENT', 'Multiple statements are refused.');
  if (tokens.some((token) => token.depth < 0))
    throw new ReadOnlyGuardError('RO_GUARD_STATEMENT', 'Unbalanced parentheses.');
  const first = tokens[0]!;
  const sentence = words(tokens);
  if (first.value === 'SET') {
    if (sessionReadOnly.test(sentence) || isolation.test(sentence))
      return {
        kind: sessionReadOnly.test(sentence) ? 'session' : 'transaction',
        sql: text,
        downgraded: false,
        explainable: false,
      };
    const timeout = /^SET SESSION MAX_EXECUTION_TIME = (\d{1,6})$/.exec(sentence);
    if (timeout && Number(timeout[1]) >= 1 && Number(timeout[1]) <= maxExecutionTimeLimit)
      return { kind: 'session', sql: text, downgraded: false, explainable: false };
    throw new ReadOnlyGuardError('RO_GUARD_SET', 'Only the two session settings are allowed.');
  }
  if (
    sentence === 'BEGIN' ||
    sentence === 'COMMIT' ||
    sentence === 'ROLLBACK' ||
    startTransaction.test(sentence)
  )
    return { kind: 'transaction', sql: text, downgraded: false, explainable: false };
  if (first.value === 'SHOW')
    return { kind: 'read', sql: text, downgraded: false, ...checkShow(tokens) };
  if (first.value === 'DESCRIBE' || first.value === 'DESC') {
    checkRead(tokens, {});
    return { kind: 'read', sql: text, downgraded: false, explainable: false };
  }
  let body = 0;
  if (first.value === 'EXPLAIN') {
    body = 1;
    if (tokens[1]?.value === 'ANALYZE')
      throw new ReadOnlyGuardError('RO_GUARD_STATEMENT', 'EXPLAIN ANALYZE executes; refused.');
    if (tokens[1]?.value === 'FORMAT' && tokens[2]?.value === '=') body = 4;
  }
  let lead = body;
  while (tokens[lead]?.value === '(') lead += 1;
  const verb = tokens[lead]?.value;
  if (verb !== 'SELECT' && verb !== 'WITH')
    throw new ReadOnlyGuardError(
      'RO_GUARD_STATEMENT',
      `Only SELECT, SHOW, DESCRIBE and EXPLAIN are allowed (got ${verb ?? 'nothing'}).`,
    );
  const { end, lock } = checkRead(tokens.slice(body), options);
  const cut = body + end;
  if (lock && cut < tokens.length) {
    const sql = text.slice(0, tokens[cut]!.start).replace(/\s+$/, '');
    return { kind: 'read', sql, downgraded: true, lock, explainable: body === 0 };
  }
  return { kind: 'read', sql: text, downgraded: false, explainable: body === 0 };
}

function checkShow(tokens: readonly Token[]): { explainable: false } {
  const allowed = new Set([
    'CREATE',
    'COLUMNS',
    'FIELDS',
    'FULL',
    'INDEX',
    'INDEXES',
    'KEYS',
    'TABLE',
    'TABLES',
    'STATUS',
    'VARIABLES',
    'SESSION',
    'WARNINGS',
    'ERRORS',
    'DATABASES',
  ]);
  const second = tokens[1]?.value ?? '';
  if (!allowed.has(second))
    throw new ReadOnlyGuardError('RO_GUARD_STATEMENT', `SHOW ${second || '?'} is refused.`);
  // `SHOW CREATE` is only allowed for tables and views (no procedure bodies, users or events).
  if (second === 'CREATE' && !['TABLE', 'VIEW'].includes(tokens[2]?.value ?? ''))
    throw new ReadOnlyGuardError('RO_GUARD_STATEMENT', 'Only SHOW CREATE TABLE is allowed.');
  return { explainable: false };
}

/** Extracts the SQL template from the argument shapes mysql2 accepts. */
export function statementText(argument: unknown): string {
  if (typeof argument === 'string') return argument;
  if (argument && typeof argument === 'object' && 'sql' in argument) {
    const value = (argument as { sql: unknown }).sql;
    if (typeof value === 'string') return value;
  }
  throw new ReadOnlyGuardError('RO_GUARD_STATEMENT', 'Unrecognised statement argument.');
}
