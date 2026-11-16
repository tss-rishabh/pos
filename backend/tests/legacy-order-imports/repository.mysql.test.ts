import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { splitMigration } from '../../src/db/migrations.js';
import { AppError } from '../../src/domain/errors.js';
import { offlineOrderColumns } from '../../src/modules/legacy-order-imports/csv.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { legacyOrderImportHistoricalResult } from '../../src/modules/legacy-order-imports/history.js';
import type {
  ImportFinancialAdapter,
  ImportFinancialResult,
  ImportFinancialScope,
} from '../../src/modules/legacy-order-imports/financial-contracts.js';

const template = process.env.LEGACY_ORDER_IMPORT_MYSQL_TEST_URL;
const secret = 'isolated-legacy-import-encryption-secret-'.repeat(3);
function input(rows = 1, id = randomUUID()) {
  const cells = {
    SerialNo: 'A',
    StoreId: '1',
    Email: 'private-import@example.test',
    UserName: 'Private imported name',
    IsExclusive: '1',
    ProductId: '9007199254740993',
    ProductQty: '2',
    ProductPrice: '25.49',
    PaymentMode: 'cash',
    OrderDate: '2026-06-15 12:00:00',
    OrderPlacedSms: '0',
    OrderMessage: 'Private imported message',
  };
  const csv = [
    offlineOrderColumns.join(','),
    ...Array.from({ length: rows }, (_, index) =>
      offlineOrderColumns.map((key) => (key === 'SerialNo' ? 'A' + index : cells[key])).join(','),
    ),
  ].join('\n');
  return { id, kind: 'offline' as const, counters: [{ storeId: '1', counterId: '2' }], csv };
}
describe.skipIf(!template)(
  'native MySQL durable CSV order coordination (synthetic financial adapter)',
  () => {
    let connection: Connection,
      db: Databases,
      schemaName: string,
      clock: number,
      repository: ReturnType<typeof legacyOrderImportRepository>,
      authorized = true;
    let orderSequence = 1000;
    beforeAll(async () => {
      const url = new URL(template!);
      if (
        url.protocol !== 'mysql:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_legacy_order_imports_test'
      )
        throw new Error('Explicit isolated local import fixture required.');
      schemaName = `pos_rewrite_legacy_order_imports_test_${process.pid}_${randomUUID().slice(0, 8)}`;
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      await connection.query(`CREATE DATABASE ${mysql.escapeId(schemaName)}`);
      await connection.changeUser({ database: schemaName });
      for (const statement of splitMigration(
        readFileSync('src/modules/legacy-order-imports/migration.sql', 'utf8'),
      ))
        await connection.query(statement);
      url.pathname = '/' + schemaName;
      db = createDatabases(
        readConfig({
          NODE_ENV: 'test',
          SESSION_SECRET: secret,
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
          MYSQL_WRITER_URL: url.href,
          MYSQL_PRIMARY_READER_URL: url.href,
        }),
      );
      clock = Date.UTC(2026, 10, 17, 12);
      repository = legacyOrderImportRepository(db, {
        secret,
        now: () => clock,
        authorize: async (_tx, actor, scopes) => {
          if (
            !authorized ||
            actor !== '1' ||
            scopes.some((scope) => scope.storeId !== '1' || scope.counterId !== '2')
          )
            throw new AppError(403, 'ORDER_IMPORT_ACCESS_CHANGED', 'Fixture access unavailable.');
        },
      });
    });
    afterAll(async () => {
      await db?.close();
      if (connection) {
        await connection.query(`DROP DATABASE ${mysql.escapeId(schemaName)}`);
        await connection.end();
      }
    });
    function completed(scope: ImportFinancialScope): ImportFinancialResult {
      return {
        status: 'completed',
        operationId: scope.operationId,
        orderId: String(++orderSequence),
        receiptId: randomUUID(),
        businessDate: '2026-06-15',
        projectionHash: 'a'.repeat(64),
      };
    }
    function adapter() {
      const outcomes = new Map<string, ImportFinancialResult>();
      let starts = 0,
        reads = 0;
      const gateway: ImportFinancialAdapter = {
        async start(scope) {
          starts++;
          const value = completed(scope);
          outcomes.set(scope.operationId, value);
          return value;
        },
        async read(scope) {
          reads++;
          return outcomes.get(scope.operationId) ?? null;
        },
      };
      return { gateway, outcomes, starts: () => starts, reads: () => reads };
    }
    async function clear() {
      authorized = true;
      await connection.query('DELETE FROM pos_rewrite_legacy_order_import_rows');
      await connection.query('DELETE FROM pos_rewrite_legacy_order_imports');
    }
    it('stages twenty identical contenders once, preserving one opaque operation and private payload', async () => {
      await clear();
      const command = input(),
        results = await Promise.all(
          Array.from({ length: 20 }, () => repository.stage('1', 'r'.repeat(128), command)),
        );
      expect(results.every((result) => result.id === command.id && result.totalOrders === 1)).toBe(
        true,
      );
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT * FROM pos_rewrite_legacy_order_import_rows',
      );
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain('private-import@example.test');
      expect(JSON.stringify(rows)).not.toContain('Private imported message');
      const publicRows = await repository.results('1', command.id);
      expect(publicRows[0]?.operationId).toBe(rows[0]?.operation_id);
      expect(publicRows[0]).not.toHaveProperty('payload');
      await expect(
        repository.stage('1', 'another', {
          ...command,
          csv: command.csv.replace('25.49', '25.50'),
        }),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COMMAND_CHANGED' });
      await expect(repository.detail('2', command.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_NOT_FOUND',
      });
    });
    it('claims twenty worker contenders once and records one completed proof', async () => {
      await clear();
      const command = input(),
        remote = adapter();
      await repository.stage('1', undefined, command);
      await Promise.all(Array.from({ length: 20 }, () => repository.runOne(remote.gateway)));
      expect(remote.starts()).toBe(1);
      expect(remote.reads()).toBe(0);
      expect(await repository.detail('1', command.id)).toMatchObject({
        state: 'COMPLETED',
        importedOrders: 1,
      });
      expect((await repository.results('1', command.id))[0]).toMatchObject({
        state: 'IMPORTED',
        businessDate: '2026-06-15',
      });
    });
    it('recovers a committed-but-lost start response with GET only after reconnect', async () => {
      await clear();
      const command = input(),
        remote = adapter(),
        originalStart = remote.gateway.start;
      remote.gateway.start = async (scope) => {
        await originalStart(scope);
        throw new Error('private-import@example.test secret=fixture');
      };
      await repository.stage('1', undefined, command);
      await repository.runOne(remote.gateway);
      expect((await repository.results('1', command.id))[0]?.state).toBe('RECONCILING');
      await expect(repository.cancel('1', command.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_IN_FLIGHT',
      });
      clock += 30001;
      await Promise.all(Array.from({ length: 20 }, () => repository.runOne(remote.gateway)));
      expect(remote.starts()).toBe(1);
      expect(remote.reads()).toBe(1);
      expect(await repository.detail('1', command.id)).toMatchObject({
        state: 'COMPLETED',
        importedOrders: 1,
      });
    });
    it('does not redispatch after a start checkpoint even when repeated remote reads return no record', async () => {
      await clear();
      const command = input();
      let starts = 0,
        reads = 0;
      const remote: ImportFinancialAdapter = {
        async start() {
          starts++;
          throw new Error('fixture disconnect');
        },
        async read() {
          reads++;
          return null;
        },
      };
      await repository.stage('1', undefined, command);
      await repository.runOne(remote);
      for (let i = 0; i < 3; i++) {
        clock += 30001;
        await repository.runOne(remote);
      }
      expect([starts, reads]).toEqual([1, 3]);
      expect(await repository.detail('1', command.id)).toMatchObject({
        state: 'RUNNING',
        importedOrders: 0,
        errorCode: 'ORDER_IMPORT_OUTCOME_UNCERTAIN',
      });
    });
    it('fences a late worker after lease takeover without issuing a second financial start', async () => {
      await clear();
      const command = input(),
        remote = adapter();
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        originalStart = remote.gateway.start;
      remote.gateway.start = async (scope) => {
        const result = await originalStart(scope);
        entered();
        await waiting;
        return result;
      };
      await repository.stage('1', undefined, command);
      const first = repository.runOne(remote.gateway);
      await started;
      clock += 120001;
      await repository.runOne(remote.gateway);
      release();
      await first;
      expect(remote.starts()).toBe(1);
      expect(remote.reads()).toBe(1);
      expect(await repository.detail('1', command.id)).toMatchObject({
        state: 'COMPLETED',
        importedOrders: 1,
      });
    });
    it('keeps recovery read-only when the original operator loses access after a start', async () => {
      await clear();
      const command = input(),
        remote = adapter(),
        originalStart = remote.gateway.start;
      remote.gateway.start = async (scope) => {
        await originalStart(scope);
        throw new Error('fixture lost response');
      };
      await repository.stage('1', undefined, command);
      await repository.runOne(remote.gateway);
      authorized = false;
      clock += 30001;
      await repository.runOne(remote.gateway);
      expect(remote.starts()).toBe(1);
      expect(remote.reads()).toBe(1);
      authorized = true;
      expect(await repository.detail('1', command.id)).toMatchObject({ state: 'COMPLETED' });
    });
    it('blocks revoked authority and tampered encryption before any financial start', async () => {
      await clear();
      const command = input(),
        remote = adapter();
      await repository.stage('1', undefined, command);
      authorized = false;
      await repository.runOne(remote.gateway);
      authorized = true;
      expect(await repository.detail('1', command.id)).toMatchObject({
        state: 'BLOCKED',
        errorCode: 'ORDER_IMPORT_ACCESS_CHANGED',
      });
      expect(remote.starts()).toBe(0);
      await repository.cancel('1', command.id);
      const changed = input();
      await repository.stage('1', undefined, changed);
      await connection.query(
        'UPDATE pos_rewrite_legacy_order_import_rows SET payload=? WHERE job_id=?',
        ['tampered', changed.id],
      );
      await repository.runOne(remote.gateway);
      expect(await repository.detail('1', changed.id)).toMatchObject({
        state: 'BLOCKED',
        errorCode: 'ORDER_IMPORT_PAYLOAD_INVALID',
      });
      expect(remote.starts()).toBe(0);
      await repository.cancel('1', changed.id);
    });
    it('records partial failures accurately and cancels only remaining unsent orders', async () => {
      await clear();
      const command = input(2),
        remote = adapter(),
        originalStart = remote.gateway.start;
      let count = 0;
      remote.gateway.start = async (scope) =>
        ++count === 1
          ? originalStart(scope)
          : {
              status: 'rejected',
              operationId: scope.operationId,
              code: 'ORDER_IMPORT_QUOTE_CHANGED',
            };
      await repository.stage('1', undefined, command);
      await repository.runOne(remote.gateway);
      await repository.runOne(remote.gateway);
      expect(await repository.detail('1', command.id)).toMatchObject({
        state: 'PARTIAL',
        importedOrders: 1,
        failedOrders: 1,
      });
      const cancel = input(3);
      await repository.stage('1', undefined, cancel);
      await repository.runOne(adapter().gateway);
      expect(await repository.cancel('1', cancel.id)).toMatchObject({
        state: 'CANCELLED',
        importedOrders: 1,
        cancelledOrders: 2,
      });
    });
    it('refuses mismatched operation/date proofs and historical MySQL result fallback', async () => {
      await clear();
      const command = input(),
        remote = adapter();
      remote.gateway.start = async (scope) => ({ ...completed(scope), operationId: randomUUID() });
      await repository.stage('1', undefined, command);
      await repository.runOne(remote.gateway);
      expect((await repository.results('1', command.id))[0]?.state).toBe('RECONCILING');
      const operation = (await repository.results('1', command.id))[0]!.operationId;
      remote.outcomes.set(operation, {
        status: 'completed',
        operationId: operation,
        orderId: String(++orderSequence),
        receiptId: randomUUID(),
        businessDate: '2026-06-16',
        projectionHash: 'b'.repeat(64),
      });
      clock += 30001;
      await repository.runOne(remote.gateway);
      expect((await repository.results('1', command.id))[0]?.state).toBe('RECONCILING');
      remote.outcomes.set(
        operation,
        completed({ actorId: '1', operationId: operation, storeId: '1', counterId: '2' }),
      );
      clock += 30001;
      await repository.runOne(remote.gateway);
      clock += 86400001;
      await expect(repository.detail('1', command.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_HISTORY_REQUIRED',
      });
      await expect(repository.results('1', command.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_HISTORY_REQUIRED',
      });
    });
    it('rolls back a late local result failure and recovers the same remote operation', async () => {
      await clear();
      const command = input(),
        remote = adapter();
      await repository.stage('1', undefined, command);
      await connection.query(
        "CREATE TRIGGER fixture_result_failure BEFORE UPDATE ON pos_rewrite_legacy_order_imports FOR EACH ROW BEGIN IF NEW.imported_orders > OLD.imported_orders THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated failure'; END IF; END",
      );
      try {
        await expect(repository.runOne(remote.gateway)).rejects.toBeInstanceOf(Error);
      } finally {
        await connection.query('DROP TRIGGER fixture_result_failure');
      }
      expect((await repository.results('1', command.id))[0]?.state).toBe('STARTING');
      clock += 120001;
      await repository.runOne(remote.gateway);
      expect(remote.starts()).toBe(1);
      expect(remote.reads()).toBe(1);
      expect(await repository.detail('1', command.id)).toMatchObject({
        state: 'COMPLETED',
        importedOrders: 1,
      });
    });
    it('routes old results to the published reader while current results stay native', async () => {
      await clear();
      const command = input();
      await repository.stage('1', undefined, command);
      await repository.runOne(adapter().gateway);
      const current = await repository.detail('1', command.id),
        archived = { ...current, state: 'COMPLETED' as const, completedAt: current.completedAt! },
        archivedRows = (await repository.results('1', command.id)).map((row) =>
          legacyOrderImportHistoricalResult.parse(row),
        );
      let warehouseCalls = 0;
      const reader = legacyOrderImportRepository(db, {
        secret,
        now: () => clock,
        authorize: async () => {
          if (!authorized)
            throw new AppError(403, 'ORDER_IMPORT_ACCESS_CHANGED', 'Fixture access unavailable.');
        },
        history: {
          async detail(anchor) {
            warehouseCalls++;
            expect(anchor.job.id).toBe(command.id);
            return archived;
          },
          async results(anchor, after = 0, limit = 50) {
            warehouseCalls++;
            expect(anchor.scopes).toEqual([{ storeId: '1', counterId: '2' }]);
            return archivedRows.filter((row) => row.sequence > after).slice(0, limit);
          },
        },
      });
      expect(await reader.detail('1', command.id)).toEqual(current);
      expect(warehouseCalls).toBe(0);
      clock += 86400001;
      await connection.query(
        'UPDATE pos_rewrite_legacy_order_import_rows SET first_row=100 WHERE job_id=?',
        [command.id],
      );
      expect(await reader.detail('1', command.id)).toEqual(archived);
      expect(await reader.results('1', command.id)).toEqual(archivedRows);
      expect(warehouseCalls).toBe(2);
    });
    it('releases writer locks during warehouse I/O and rechecks changed or revoked history', async () => {
      await clear();
      const command = input();
      await repository.stage('1', undefined, command);
      await repository.runOne(adapter().gateway);
      const current = await repository.detail('1', command.id),
        archived = { ...current, state: 'COMPLETED' as const, completedAt: current.completedAt! };
      clock += 86400001;
      await connection.query('SET SESSION innodb_lock_wait_timeout=1');
      const reader = legacyOrderImportRepository(db, {
        secret,
        now: () => clock,
        authorize: async () => {
          if (!authorized)
            throw new AppError(403, 'ORDER_IMPORT_ACCESS_CHANGED', 'Fixture access unavailable.');
        },
        history: {
          async detail() {
            await connection.query(
              'UPDATE pos_rewrite_legacy_order_imports SET request_hash=? WHERE id=?',
              ['b'.repeat(64), command.id],
            );
            return archived;
          },
          async results() {
            authorized = false;
            return [];
          },
        },
      });
      await expect(reader.detail('1', command.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_HISTORY_CHANGED',
      });
      await expect(reader.results('1', command.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_ACCESS_CHANGED',
      });
      authorized = true;
    });
  },
);
