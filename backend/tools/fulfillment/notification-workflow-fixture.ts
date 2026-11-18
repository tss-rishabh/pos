import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { eq, getTableName } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { migrationPlan } from '../../src/db/migrations.js';
import {
  ExpressLineItem,
  HasProduct,
  Notification,
  Order,
  OrderStatus,
  PaymentStatus,
  PosUser,
  UsersNotification,
} from '../../src/db/legacy-schema.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { seal } from '../../src/auth/crypto.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { operatorCheckIns } from '../../src/modules/administration/schema.js';
import { notificationBus } from '../../src/modules/fulfillment/notification-bus.js';
import { localTimestamp } from '../../src/modules/fulfillment/domain.js';
import { verifiedMysqlFixture } from '../operational-reports/verified-mysql-fixture.js';

export const notificationHighWater = '9007199254740992';
export const notificationOrder = '9007199254741193';
export const notificationOtherOrder = '9007199254741194';
export const notificationFeed = '/api/v1/stores/1/notifications';
const exactId = z.union([z.string(), z.number().int().safe()]).transform(String);
const notificationRows = z.array(
  z.object({
    id: exactId,
    title: z.string(),
    url_key: z.string().nullable(),
    order_id: exactId,
    store_id: z.number().int(),
  }),
);
const recipientRows = z.array(
  z.object({
    id: exactId,
    notification_id: exactId,
    pos_admin_id: z.number().int(),
    is_viewed: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
);
const sourceResult = z.object({
  notificationId: z.string().optional(),
  users: z.array(z.number().int()).optional(),
  published: z.boolean().optional(),
  status: z.number().optional(),
  body: z.unknown().optional(),
  location: z.string().nullable().optional(),
  sourceHashes: z.record(z.string(), z.string()),
});

async function unusedPort() {
  const listener = createTcpServer();
  await new Promise<void>((done, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', done);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Owned loopback port unavailable');
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
async function stopProcess(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(timeout);
      done();
    });
    child.kill('SIGTERM');
  });
}

export async function nativeNotificationFixture(output: string) {
  const base = new URL(process.env.NOTIFICATION_WORKFLOW_MYSQL_URL ?? '');
  if (
    base.protocol !== 'mysql:' ||
    base.hostname !== '127.0.0.1' ||
    !base.port ||
    base.pathname !== '/pos_rewrite_notification_workflow' ||
    base.search ||
    base.hash
  )
    throw new Error('Only the owned localhost notification MySQL fixture is permitted.');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const schema = 'pos_rewrite_notification_workflow_' + suffix;
  const prefix = 'notification_source_' + suffix;
  const connection = await mysql.createConnection({
    host: base.hostname,
    port: Number(base.port),
    user: decodeURIComponent(base.username),
    password: decodeURIComponent(base.password),
    database: base.pathname.slice(1),
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  const disposers: (() => Promise<void>)[] = [];
  let created = false;
  disposers.push(async () => {
    try {
      if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    } finally {
      await connection.end();
    }
  });
  const dispose = async () => {
    for (const close of disposers.splice(0).reverse()) {
      try {
        await close();
      } catch {
        /* Only owned resources; diagnostics stay private. */
      }
    }
  };
  try {
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await connection.changeUser({ database: schema });
    const physical = verifiedMysqlFixture(connection);
    await physical.create([
      'pos_user',
      'stores',
      'store_counters',
      'user_stores',
      getTableName(Notification),
      getTableName(UsersNotification),
      getTableName(Order),
      getTableName(HasProduct),
      getTableName(ExpressLineItem),
      'products',
      getTableName(OrderStatus),
      getTableName(PaymentStatus),
    ]);
    for (const migration of migrationPlan())
      for (const statement of migration.statements) await connection.query(statement);
    for (const store of [1, 2]) {
      await physical.insert('stores', {
        id: store,
        store_name: `Synthetic store ${store}`,
        location_code: `SYN${store}`,
        type: 'STORE',
        category: 'IN_HOUSE',
        is_active: 1,
      });
      await physical.insert('store_counters', {
        id: store + 1,
        store_id: store,
        counter_name: `Counter ${store + 1}`,
        is_active: 1,
      });
    }
    for (const [id, stores] of [
      [7, [1, 2]],
      [8, [1]],
      [9, [2]],
    ] as const) {
      await physical.insert('pos_user', {
        id,
        role: 4,
        user_type: 1,
        username: `synthetic-notification-${id}`,
        is_active: 1,
        is_staff: 1,
      });
      for (const store of stores)
        await physical.insert('user_stores', { django_user_id: id, store_id: store });
    }
    await physical.insert('products', {
      id: 10,
      product: 'Synthetic notification fixture product',
    });
    const timestamp = () => localTimestamp(Temporal.Now.instant(), 'Asia/Kolkata');
    for (const [id, store] of [
      ['301', 1],
      ['302', 2],
    ] as const) {
      await physical.insert(getTableName(Order), {
        id,
        order_ref_no: 'SYNTHETIC-NOTIFICATION-' + store,
        created_at: timestamp(),
        order_status: 3,
      });
      await physical.insert(getTableName(HasProduct), {
        id: store + 100,
        order_id: id,
        prod_id: 10,
        qty: 1,
        status: 'PLACED',
      });
      await physical.insert(getTableName(ExpressLineItem), {
        id: store,
        order_id: id,
        store_id: store,
        has_product_id: store + 100,
        status: 'PENDING',
        pending_expires_at: localTimestamp(
          Temporal.Now.instant().add({ hours: 2 }),
          'Asia/Kolkata',
        ),
        accepted_expires_at: localTimestamp(
          Temporal.Now.instant().add({ hours: 3 }),
          'Asia/Kolkata',
        ),
        vinc_status: 'Allocated',
      });
    }
    const redisPort = await unusedPort();
    const redisProcess = spawn(
      'redis-server',
      [
        '--port',
        String(redisPort),
        '--bind',
        '127.0.0.1',
        '--save',
        '',
        '--appendonly',
        'no',
        '--protected-mode',
        'yes',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    disposers.push(async () => stopProcess(redisProcess));
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Owned notification Redis startup timed out')),
        10000,
      );
      redisProcess.once('error', () => {
        clearTimeout(timer);
        reject(new Error('Owned notification Redis unavailable'));
      });
      redisProcess.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Ready to accept connections')) {
          clearTimeout(timer);
          done();
        }
      });
    });
    const redisUrl = `redis://127.0.0.1:${redisPort}/0`;
    const redis = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
    redis.on('error', () => {});
    disposers.push(async () => {
      if (redis.isOpen) await redis.quit();
    });
    await redis.connect();
    base.pathname = '/' + schema;
    const sourcePort = await unusedPort();
    const sourceOrigin = `http://127.0.0.1:${sourcePort}`;
    const python = process.env.NOTIFICATION_SOURCE_PYTHON,
      sourceRoot = process.env.NOTIFICATION_SOURCE_ROOT;
    if (!python || !sourceRoot)
      throw new Error('Private pinned notification source environment required');
    const sourceInput = { url: base.href, redis: redisUrl, prefix };
    const sourceServer = spawn(
      python,
      ['-B', 'tools/fulfillment/notification-workflow-source.py'],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, TZ: 'Asia/Kolkata', NOTIFICATION_SOURCE_ROOT: sourceRoot },
      },
    );
    disposers.push(async () => stopProcess(sourceServer));
    sourceServer.stdin?.end(JSON.stringify({ ...sourceInput, action: 'serve', port: sourcePort }));
    await new Promise<void>((done, reject) => {
      let buffer = '';
      const timer = setTimeout(
        () => reject(new Error('Pinned source ASGI startup timed out')),
        15000,
      );
      sourceServer.once('error', () => {
        clearTimeout(timer);
        reject(new Error('Pinned source ASGI unavailable'));
      });
      sourceServer.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Pinned source ASGI stopped before ready'));
      });
      sourceServer.stdout?.on('data', (value: Buffer) => {
        buffer += value.toString();
        if (buffer.length > 8000) {
          clearTimeout(timer);
          reject(new Error('Source diagnostics omitted'));
          return;
        }
        if (
          buffer.split('\n').some((line) => {
            try {
              return z
                .object({ ready: z.literal(true), port: z.literal(sourcePort) })
                .safeParse(JSON.parse(line) as unknown).success;
            } catch {
              return false;
            }
          })
        ) {
          clearTimeout(timer);
          done();
        }
      });
    });
    let backendOrigin = '',
      loseReadResponse = false;
    const traffic: { method: string; path: string; status: number }[] = [];
    const sourceTraffic: {
      method: string;
      path: string;
      status: number;
      notificationId: string | null;
    }[] = [];
    const cookieActors = new Map<string, string>();
    const streams = new Set<{
      kind: 'candidate' | 'source';
      actor: string;
      path: string;
      client: Socket;
      upstream: Socket;
    }>();
    function source(raw: Record<string, unknown>) {
      const result = spawnSync(
        python!,
        ['-B', 'tools/fulfillment/notification-workflow-source.py'],
        {
          input: JSON.stringify({ ...sourceInput, ...raw }),
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 1024 * 1024,
          env: { PATH: process.env.PATH, TZ: 'Asia/Kolkata', NOTIFICATION_SOURCE_ROOT: sourceRoot },
        },
      );
      if (result.status !== 0)
        throw new Error('Original native notification execution failed; diagnostics omitted');
      return sourceResult.parse(JSON.parse(result.stdout) as unknown);
    }
    const gateway = createServer(async (request, response) => {
      const target = request.url ?? '/',
        pathname = new URL(target, 'http://127.0.0.1').pathname;
      const isSource =
        pathname.startsWith('/__notification_source_header__') ||
        pathname.startsWith('/notification/') ||
        pathname.startsWith('/static/');
      if (isSource || pathname.startsWith('/api/v1/')) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const value of request) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          size += chunk.length;
          if (size > 16000) {
            response.writeHead(413);
            response.end();
            return;
          }
          chunks.push(chunk);
        }
        try {
          const upstream = await fetch((isSource ? sourceOrigin : backendOrigin) + target, {
            method: request.method,
            redirect: 'manual',
            headers: Object.fromEntries(
              Object.entries(request.headers)
                .filter(
                  ([name, value]) =>
                    name !== 'host' && name !== 'connection' && typeof value === 'string',
                )
                .map(([name, value]) => [name, String(value)]),
            ),
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          });
          const bytes = Buffer.from(await upstream.arrayBuffer());
          if (isSource && pathname === '/notification/ajax-notification-update/')
            sourceTraffic.push({
              method: request.method ?? '',
              path: pathname,
              status: upstream.status,
              notificationId: new URLSearchParams(Buffer.concat(chunks).toString()).get('noti_id'),
            });
          if (!isSource)
            traffic.push({ method: request.method ?? '', path: target, status: upstream.status });
          if (
            !isSource &&
            request.method === 'PUT' &&
            pathname.endsWith('/read-receipt') &&
            loseReadResponse
          ) {
            loseReadResponse = false;
            response.writeHead(upstream.status, {
              'content-type': 'application/json',
              'content-length': String(bytes.length),
            });
            response.flushHeaders();
            response.write(bytes.subarray(0, 1), () => response.destroy());
            return;
          }
          response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
          response.end(bytes);
        } catch {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ error: { code: 'SYNTHETIC_NOTIFICATION_TRANSPORT_UNAVAILABLE' } }),
          );
        }
        return;
      }
      try {
        const file = pathname.startsWith('/assets/')
          ? resolve(output, '.' + pathname)
          : resolve(output, 'index.html');
        if (!file.startsWith(resolve(output) + sep)) throw new Error('Invalid fixture path');
        response.writeHead(200, {
          'content-type': file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/html',
        });
        response.end(await readFile(file));
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    gateway.on('upgrade', (request, client, head) => {
      const path = request.url ?? '';
      const kind = path.startsWith('/ws/notification/')
        ? 'source'
        : path.startsWith('/api/v1/stores/') && path.endsWith('/notifications/stream')
          ? 'candidate'
          : null;
      if (!kind) {
        client.destroy();
        return;
      }
      const upstream = connect(
        new URL(kind === 'source' ? sourceOrigin : backendOrigin).port
          ? Number(new URL(kind === 'source' ? sourceOrigin : backendOrigin).port)
          : 80,
        '127.0.0.1',
      );
      const cookies = request.headers.cookie ?? '';
      const actor =
        kind === 'source'
          ? (/notification_source_actor=(7|8|9)(?:;|$)/.exec(cookies)?.[1] ?? 'anonymous')
          : ([...cookieActors].find(([value]) => cookies.includes('pos_session=' + value))?.[1] ??
            'anonymous');
      const pair: {
        kind: 'candidate' | 'source';
        actor: string;
        path: string;
        client: Socket;
        upstream: Socket;
      } = { kind, actor, path, client: client as Socket, upstream };
      streams.add(pair);
      const close = () => {
        streams.delete(pair);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
      client.on('close', close);
      upstream.on('close', close);
      upstream.once('connect', () => {
        upstream.write(
          `${request.method} ${path} HTTP/${request.httpVersion}\r\n` +
            Object.entries(request.headers)
              .filter(([, value]) => typeof value === 'string')
              .map(([name, value]) => `${name}: ${String(value)}\r\n`)
              .join('') +
            '\r\n',
        );
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
    disposers.push(async () => {
      for (const pair of [...streams]) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      if (gateway.listening) await new Promise<void>((done) => gateway.close(() => done()));
    });
    await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
    const address = gateway.address();
    if (!address || typeof address === 'string')
      throw new Error('Owned notification gateway unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      WEB_ORIGIN: origin,
      SESSION_SECRET: 'synthetic-notification-native-secret-'.repeat(3),
      REDIS_URL: redisUrl,
      MYSQL_WRITER_URL: base.href,
      MYSQL_PRIMARY_READER_URL: base.href,
      MYSQL_DATA_READER_URL: base.href,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      DAY_CLOSE_ENABLED_STORE_IDS: '',
    });
    const db = createDatabases(config);
    disposers.push(async () => db.close());
    const app = await buildApp(config, { logger: false });
    disposers.push(async () => app.close());
    const bus = notificationBus(config);
    disposers.push(async () => bus.close());
    backendOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
    const principal = (id: string) => ({
      id,
      role: 4 as const,
      userType: 1 as const,
      name: 'Synthetic notification operator',
      email: 'operator@example.test',
      storeIds: id === '7' ? ['1', '2'] : id === '8' ? ['1'] : ['2'],
    });
    async function checkIn(actor: string, store: string | null) {
      await redis.lRem('check_in_list_1', 0, actor);
      await redis.lRem('check_in_list_2', 0, actor);
      if (store === null) {
        await checkInService(db, config).clear(principal(actor));
        await redis.del('check_in_' + actor);
        return;
      }
      await checkInService(db, config).set(principal(actor), store, String(Number(store) + 1));
      await redis.set(
        'check_in_' + actor,
        JSON.stringify([Number(store), `Synthetic store ${store}`]),
      );
      await redis.rPush('check_in_list_' + store, actor);
    }
    async function recipients(id: string) {
      const [rows] = await connection.execute(
        'SELECT id,notification_id,pos_admin_id,is_viewed,created_at,updated_at FROM pos_user_notifications WHERE notification_id=? ORDER BY id',
        [id],
      );
      return recipientRows.parse(rows);
    }
    async function notices() {
      const [rows] = await connection.query(
        'SELECT id,title,url_key,order_id,store_id FROM pos_notifications ORDER BY id',
      );
      return notificationRows.parse(rows);
    }
    async function publish(
      id: string,
      isNewOrder: boolean,
      event: 'notification.created' | 'notification.read' = 'notification.created',
    ) {
      const row = (await notices()).find((value) => value.id === id);
      if (!row) throw new Error('Synthetic notice missing');
      await bus.publish({
        event,
        notificationId: id,
        storeId: String(row.store_id),
        userIds: (await recipients(id)).map((value) => String(value.pos_admin_id)),
        isNewOrder,
      });
    }
    return {
      origin,
      sourceOrigin,
      traffic,
      sourceTraffic,
      source,
      checkIn,
      recipients,
      notices,
      publish,
      async socket(
        kind: 'candidate' | 'source' = 'candidate',
        actor: string | null = '7',
        store = '1',
        options: { origin?: string; ttl?: number } = {},
      ) {
        const value =
          actor === null
            ? null
            : kind === 'candidate'
              ? await mysqlSessions(db).create(actor, Date.now() + (options.ttl ?? 300000))
              : null;
        const credential =
          value && actor ? seal({ id: actor, ...value }, config.SESSION_SECRET) : null;
        if (credential && actor) cookieActors.set(credential, actor);
        const path =
          kind === 'candidate'
            ? `/api/v1/stores/${store}/notifications/stream`
            : '/ws/notification/order/';
        const socket = new WebSocket(origin.replace('http:', 'ws:') + path, {
          headers: {
            Origin: options.origin ?? origin,
            ...(actor
              ? {
                  Cookie:
                    kind === 'source'
                      ? `notification_source_actor=${actor}`
                      : `pos_session=${credential}`,
                }
              : {}),
          },
        });
        socket.on('error', () => {});
        await new Promise<void>((done, reject) => {
          socket.once('open', done);
          socket.once('unexpected-response', (_request, response) => {
            socket.terminate();
            reject(new Error('WS_HTTP_' + response.statusCode));
          });
          socket.once('error', () => reject(new Error('WS_CONNECTION_REFUSED')));
        });
        return socket;
      },
      async cookie(actor = '7', ttl = 300000) {
        const credential = await mysqlSessions(db).create(actor, Date.now() + ttl);
        const value = seal({ id: actor, ...credential }, config.SESSION_SECRET);
        cookieActors.set(value, actor);
        return {
          name: 'pos_session',
          value,
          url: origin,
          httpOnly: true,
          sameSite: 'Lax' as const,
        };
      },
      sourceCookie(actor = '7') {
        return {
          name: 'notification_source_actor',
          value: actor,
          url: origin,
          httpOnly: true,
          sameSite: 'Lax' as const,
        };
      },
      async seedNotice(
        id: string,
        title: string,
        store = 1,
        users = ['7'],
        orderId = notificationOrder,
        url: string | null = null,
      ) {
        await physical.insert(getTableName(Notification), {
          id,
          title,
          store_id: store,
          order_id: orderId,
          url_key: url,
          created_at: timestamp(),
          updated_at: timestamp(),
        });
        for (const user of users)
          await physical.insert(getTableName(UsersNotification), {
            notification_id: id,
            pos_admin_id: Number(user),
            is_viewed: 0,
            created_at: timestamp(),
            updated_at: timestamp(),
          });
      },
      async rawEvent(raw: string, store = '1') {
        await redis.publish('pos-rewrite:notifications:' + store, raw);
      },
      disconnect(actor = '7') {
        for (const pair of [...streams])
          if (pair.kind === 'candidate' && pair.actor === actor) {
            pair.client.destroy();
            pair.upstream.destroy();
          }
      },
      streamCount(kind: 'candidate' | 'source', actor = '7') {
        return [...streams].filter((pair) => pair.kind === kind && pair.actor === actor).length;
      },
      loseNextReadResponse() {
        loseReadResponse = true;
      },
      async archiveActor(active: boolean, actor = '7') {
        await db
          .get('writer')
          .update(PosUser)
          .set({ is_active: active })
          .where(eq(PosUser.id, BigInt(actor)));
      },
      async removeAssignment(actor = '7', store = '1') {
        await connection.execute('DELETE FROM user_stores WHERE django_user_id=? AND store_id=?', [
          actor,
          store,
        ]);
      },
      async expireCheckIn(actor = '7') {
        await db
          .get('writer')
          .update(operatorCheckIns)
          .set({ expiresAt: '2000-01-01 00:00:00' })
          .where(eq(operatorCheckIns.operatorId, actor));
      },
      async financialRows() {
        const [orders] = await connection.query(
          'SELECT id,order_status,payment_status,order_amt FROM orders ORDER BY id',
        );
        const [commands] = await connection.query(
          'SELECT command_id FROM pos_rewrite_fulfillment_commands',
        );
        const [effects] = await connection.query('SELECT id FROM pos_rewrite_fulfillment_effects');
        return { orders, commands, effects };
      },
      async reset() {
        for (const pair of [...streams]) {
          pair.client.destroy();
          pair.upstream.destroy();
        }
        await connection.query('DELETE FROM pos_user_notifications');
        await connection.query('DELETE FROM pos_notifications');
        await connection.query(
          `ALTER TABLE pos_notifications AUTO_INCREMENT=${notificationHighWater}`,
        );
        await physical.insert(getTableName(Notification), {
          id: notificationHighWater,
          title: 'Synthetic high-water marker',
          store_id: 1,
          order_id: notificationOrder,
          created_at: timestamp(),
          updated_at: timestamp(),
        });
        await connection.query('UPDATE pos_user SET is_active=1');
        await connection.query('DELETE FROM user_stores');
        for (const [actor, store] of [
          [7, 1],
          [7, 2],
          [8, 1],
          [9, 2],
        ])
          await physical.insert('user_stores', { django_user_id: actor!, store_id: store! });
        await checkIn('7', '1');
        await checkIn('8', null);
        await checkIn('9', '2');
        traffic.length = 0;
        sourceTraffic.length = 0;
        loseReadResponse = false;
      },
      async close() {
        for (const pair of [...streams]) {
          pair.client.destroy();
          pair.upstream.destroy();
        }
        await dispose();
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
