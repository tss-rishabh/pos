// Native statement deltas, observed on a separate connection outside request timers.
// Com_* is deliberately not read from status_by_thread: MySQL does not expose it there.
import mysql from 'mysql2/promise';

const scalar = (value) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('INVALID_NATIVE_STATEMENT_COUNTER');
  return result;
};
const fields = { count: 'COUNT_STAR', rowsSent: 'SUM_ROWS_SENT', rowsExamined: 'SUM_ROWS_EXAMINED',
  rowsAffected: 'SUM_ROWS_AFFECTED', errors: 'SUM_ERRORS', warnings: 'SUM_WARNINGS' };

export function workflowCounters(observer) {
  async function snapshot(accounts) {
    if (!accounts.length || accounts.some((name) => !/^cw_[a-f0-9]{12}_[a-z_]+$/.test(name)))
      throw new Error('EXPLICIT_BENCHMARK_COUNTER_ACCOUNTS_REQUIRED');
    const [threads] = await observer.execute(
      `SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_USER IN (${accounts.map(() => '?').join(',')}) ORDER BY THREAD_ID`, accounts);
    const ids = threads.map((row) => String(row.THREAD_ID));
    if (!ids.length) throw new Error('BENCHMARK_THREADS_NOT_WARMED');
    const [rows] = await observer.execute(
      `SELECT THREAD_ID,EVENT_NAME,${Object.values(fields).join(',')} FROM performance_schema.events_statements_summary_by_thread_by_event_name WHERE THREAD_ID IN (${ids.map(() => '?').join(',')}) AND COUNT_STAR>0`, ids);
    const values = {};
    for (const row of rows) {
      const key = String(row.THREAD_ID) + ':' + String(row.EVENT_NAME);
      values[key] = Object.fromEntries(Object.entries(fields).map(([name, column]) => [name, scalar(row[column])]));
    }
    return { ids, values };
  }
  async function sessionProfiles(accounts) {
    const { ids } = await snapshot(accounts);
    const [rows] = await observer.execute(
      `SELECT THREAD_ID,VARIABLE_NAME,VARIABLE_VALUE FROM performance_schema.variables_by_thread WHERE THREAD_ID IN (${ids.map(() => '?').join(',')}) AND VARIABLE_NAME IN ('sql_mode','group_concat_max_len','collation_connection','character_set_connection','transaction_isolation','transaction_read_only','max_execution_time','time_zone') ORDER BY THREAD_ID,VARIABLE_NAME`, ids);
    const profiles = Object.fromEntries(ids.map((id) => [id, {}]));
    for (const row of rows) profiles[String(row.THREAD_ID)][String(row.VARIABLE_NAME).toLowerCase()] = String(row.VARIABLE_VALUE);
    for (const values of Object.values(profiles))
      if (!Object.hasOwn(values, 'sql_mode') || !Object.hasOwn(values, 'group_concat_max_len'))
        throw new Error('NATIVE_SESSION_PROFILE_UNAVAILABLE');
    return profiles;
  }
  function delta(before, after) {
    if (JSON.stringify(before.ids) !== JSON.stringify(after.ids)) throw new Error('BENCHMARK_CONNECTION_SET_CHANGED');
    const events = {};
    for (const key of new Set([...Object.keys(before.values), ...Object.keys(after.values)])) {
      const event = key.slice(key.indexOf(':') + 1);
      const current = events[event] ?? Object.fromEntries(Object.keys(fields).map((field) => [field, 0]));
      for (const name of Object.keys(fields)) {
        const change = (after.values[key]?.[name] ?? 0) - (before.values[key]?.[name] ?? 0);
        if (change < 0) throw new Error('NATIVE_STATEMENT_COUNTER_REGRESSED');
        current[name] += change;
      }
      events[event] = current;
    }
    return Object.fromEntries(Object.entries(events).filter(([, row]) => row.count > 0));
  }
  const signature = (events) => Object.fromEntries(Object.entries(events).filter(([name]) =>
    name === 'statement/sql/select' || name === 'statement/com/Execute' || name === 'statement/com/Query')
    .map(([name, row]) => [name, row.count]).filter(([, count]) => count > 0));

  async function calibrate(account) {
    const connection = await mysql.createConnection(account.url);
    await connection.query('SELECT CONNECTION_ID()');
    async function observed(action) {
      const before = await snapshot([account.name]);
      await action();
      return delta(before, await snapshot([account.name]));
    }
    try {
      const text = signature(await observed(() => connection.query('SELECT 1 AS workflow_counter_calibration')));
      await connection.execute('SELECT ? AS workflow_counter_calibration', [1]);
      const prepared = signature(await observed(() => connection.execute('SELECT ? AS workflow_counter_calibration', [2])));
      const keys = [...new Set([...Object.keys(text), ...Object.keys(prepared)])].sort((a, b) =>
        Number(b === 'statement/sql/select') - Number(a === 'statement/sql/select') || a.localeCompare(b));
      let weights;
      const shared = keys.find((key) => text[key] > 0 && text[key] === prepared[key]);
      if (shared) weights = { [shared]: 1 / text[shared] };
      else for (let first = 0; first < keys.length && !weights; first++)
        for (let second = first + 1; second < keys.length; second++) {
          const a = keys[first], b = keys[second];
          const ta = text[a] ?? 0, tb = text[b] ?? 0, pa = prepared[a] ?? 0, pb = prepared[b] ?? 0;
          const determinant = ta * pb - tb * pa;
          if (!determinant) continue;
          const wa = (pb - tb) / determinant, wb = (ta - pa) / determinant;
          if (wa >= 0 && wb >= 0) { weights = { [a]: wa, [b]: wb }; break; }
        }
      if (!weights) throw new Error('NATIVE_READ_COUNTER_CALIBRATION_UNAVAILABLE');
      function logicalReads(events) {
        const count = Object.entries(weights).reduce((sum, [event, weight]) => sum + (events[event]?.count ?? 0) * weight, 0);
        if (!Number.isFinite(count) || Math.abs(count - Math.round(count)) > 1e-9)
          throw new Error('NATIVE_READ_COUNT_NOT_INTEGRAL');
        return Math.round(count);
      }
      const textCheck = await observed(() => connection.query('SELECT 3 AS workflow_counter_calibration'));
      const preparedCheck = await observed(() => connection.execute('SELECT ? AS workflow_counter_calibration', [4]));
      const cteCheck = await observed(() => connection.query('WITH workflow_calibration AS (SELECT 1 AS n) SELECT n FROM workflow_calibration'));
      if ([textCheck, preparedCheck, cteCheck].some((events) => logicalReads(events) !== 1))
        throw new Error('NATIVE_READ_COUNTER_CALIBRATION_FAILED');
      return { logicalReads, facts: { textSignature: text, preparedSignature: prepared, eventWeights: weights,
        textReads: logicalReads(textCheck), preparedReads: logicalReads(preparedCheck), cteReads: logicalReads(cteCheck),
        source: 'events_statements_summary_by_thread_by_event_name; not status_by_thread.Com_*' } };
    } finally { await connection.end(); }
  }
  function assertReadOnly(events) {
    for (const [name, row] of Object.entries(events)) {
      if (row.errors || row.rowsAffected || (/statement\/sql\/(?:insert|update|delete|replace|create|alter|drop|truncate)/.test(name) && row.count))
        throw new Error('BENCHMARK_REQUEST_WAS_NOT_A_SUCCESSFUL_READ');
    }
  }
  return { snapshot, sessionProfiles, delta, calibrate, assertReadOnly };
}
