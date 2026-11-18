import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chromium,
  expect as ui,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import type WebSocket from 'ws';
import { build } from 'vite';
import { z } from 'zod';
import {
  nativeNotificationFixture,
  notificationFeed,
  notificationOrder,
} from '../../../backend/tools/fulfillment/notification-workflow-fixture';

const feedSchema = z.object({
  unreadCount: z.number(),
  data: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      isViewed: z.boolean(),
      url: z.string().nullable(),
    }),
  ),
});
const nextId = (offset: number) => String(9007199254740992n + BigInt(offset));

describe.skipIf(!process.env.NOTIFICATION_WORKFLOW_MYSQL_URL)(
  'pinned source Channels/header and native App notification workflow',
  () => {
    let browser: Browser,
      temporary: string,
      fixture: Awaited<ReturnType<typeof nativeNotificationFixture>>;
    const contexts: BrowserContext[] = [],
      sockets: WebSocket[] = [];
    beforeAll(async () => {
      temporary = await mkdtemp(join(tmpdir(), 'pos-notification-production-build-'));
      const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      await build({
        root: frontend,
        configFile: join(frontend, 'vite.config.ts'),
        cacheDir: join(temporary, 'vite-cache'),
        logLevel: 'silent',
        build: { outDir: join(temporary, 'dist'), emptyOutDir: true },
      });
      fixture = await nativeNotificationFixture(join(temporary, 'dist'));
      const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const executablePath =
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (process.platform === 'darwin' && existsSync(mac) ? mac : undefined);
      browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
    });
    beforeEach(async () => {
      await fixture.reset();
    });
    afterEach(async () => {
      for (const socket of sockets.splice(0)) socket.terminate();
      await Promise.all(contexts.splice(0).map((context) => context.close()));
    });
    afterAll(async () => {
      await browser?.close();
      await fixture?.close();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    });
    async function context(source = false, actor = '7') {
      const value = await browser.newContext({ serviceWorkers: 'block' });
      contexts.push(value);
      await value.addCookies([source ? fixture.sourceCookie(actor) : await fixture.cookie(actor)]);
      return value;
    }
    async function workspace() {
      const current = await context(),
        page = await current.newPage();
      await page.goto(fixture.origin + '/shortcut-reference');
      await ui(page.getByLabel('Current store')).toHaveValue('1');
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await ui(page.getByRole('region', { name: 'Store notifications' })).toContainText('Live');
      await ui.poll(() => fixture.streamCount('candidate')).toBe(1);
      return page;
    }
    async function sourcePage(variant: 'main' | 'compact' = 'main') {
      const current = await context(true),
        page = await current.newPage();
      await page.goto(fixture.origin + '/__notification_source_header__?variant=' + variant);
      await ui.poll(() => fixture.streamCount('source')).toBeGreaterThan(0);
      // An ordinary user gesture permits the original media element to play.
      await page.locator('#source-media-gesture').click();
      return page;
    }
    async function socket(
      kind: 'source' | 'candidate',
      actor: string | null = '7',
      store = '1',
      options: { origin?: string; ttl?: number } = {},
    ) {
      const value = await fixture.socket(kind, actor, store, options);
      sockets.push(value);
      return value;
    }
    function frames(value: WebSocket) {
      const received: unknown[] = [];
      value.on('message', (bytes) => {
        received.push(JSON.parse(bytes.toString()) as unknown);
      });
      return received;
    }
    async function http(
      path = notificationFeed,
      method = 'GET',
      actor = '7',
      cookie?: Awaited<ReturnType<typeof fixture.cookie>>,
    ) {
      const credential = cookie ?? (await fixture.cookie(actor));
      return fetch(fixture.origin + path, {
        method,
        headers: {
          Cookie: `${credential.name}=${credential.value}`,
          'X-Operator-ID': actor,
          ...(method !== 'GET' ? { Origin: fixture.origin } : {}),
        },
      });
    }
    async function feed() {
      return feedSchema.parse((await (await http()).json()) as unknown);
    }
    function sourcePublish(title: string, isNewOrder = true) {
      const result = fixture.source({
        action: 'publish',
        title,
        orderId: notificationOrder,
        storeId: '1',
        isNewOrder,
      });
      if (!result.notificationId) throw new Error('Original producer did not persist a notice');
      return result.notificationId;
    }
    function article(page: Page, title: string) {
      return page
        .locator('.notification-panel article')
        .filter({ has: page.locator('strong', { hasText: title }) });
    }

    it('joins the original producer, both original header variants, native rows and the actual App through real Redis/WebSockets', async () => {
      const main = await sourcePage(),
        compact = await sourcePage('compact'),
        page = await workspace();
      const rawSource = frames(await socket('source')),
        candidate = frames(await socket('candidate'));
      const cdp = await page.context().newCDPSession(page),
        oscillators: string[] = [];
      await cdp.send('WebAudio.enable');
      cdp.on('WebAudio.audioNodeCreated', (event) => {
        if (event.node.nodeType === 'Oscillator') oscillators.push(event.node.nodeId);
      });
      await page.getByRole('button', { name: 'Enable notification sound', exact: true }).click();
      await ui(
        page.getByRole('button', { name: 'Mute notification sound', exact: true }),
      ).toBeVisible();
      const beforeAudio = oscillators.length;
      await page.waitForTimeout(850); // Real production chime coalescing interval is 800ms.
      const id = sourcePublish('Hyperlocal synthetic incoming');
      await fixture.publish(id, true);
      await ui.poll(() => rawSource.length).toBe(1);
      await ui.poll(() => candidate.length).toBe(1);
      expect(rawSource[0]).toMatchObject({ users: [7], is_new_order: true });
      expect(candidate[0]).toMatchObject({ notificationId: id, storeId: '1', isNewOrder: true });
      expect(Object.keys(candidate[0] as object).sort()).toEqual([
        'event',
        'isNewOrder',
        'notificationId',
        'storeId',
      ]);
      await ui(article(page, 'Hyperlocal synthetic incoming')).toBeVisible();
      await ui(page.locator('.notification-toast')).toContainText('Hyperlocal synthetic incoming');
      await ui(page.getByRole('link', { name: 'View order queue', exact: true })).toHaveAttribute(
        'href',
        '/fulfillment?tab=in_queue',
      );
      await ui(main.locator('#notification-area')).toContainText('Hyperlocal synthetic incoming');
      await ui(main.locator('.queue-band')).toContainText('Hyperlocal');
      await ui(compact.locator('.swal2-container')).toContainText('Hyperlocal synthetic incoming');
      await ui.poll(() => oscillators.length).toBeGreaterThan(beforeAudio);
      for (const original of [main, compact])
        await ui
          .poll(() => original.evaluate(() => Reflect.get(window, '__sourceMediaPlayed') as number))
          .toBeGreaterThan(0);
      expect(await fixture.recipients(id)).toMatchObject([{ pos_admin_id: 7, is_viewed: 0 }]);
      expect((await feed()).data[0]?.id).toBe(id);
    });

    it('retains stored Hyperlocal routing and explicit live false while correcting numeric JSON precision and preserving navigation scope', async () => {
      await fixture.seedNotice(nextId(1), 'Hyperlocal Accepted synthetic');
      await fixture.seedNotice(nextId(2), 'Order shipped synthetic');
      const source = await sourcePage(),
        page = await workspace();
      await ui(source.locator('a.noti-' + nextId(1))).toHaveAttribute(
        'href',
        '/orders/hyperlocal/progress/?tab=in_queue',
      );
      await ui(source.locator('a.noti-' + nextId(2))).toHaveAttribute(
        'href',
        `/orders/online/${notificationOrder}/show/`,
      );
      await ui(article(page, 'Hyperlocal Accepted synthetic').getByRole('link')).toHaveAttribute(
        'href',
        '/fulfillment?tab=in_queue',
      );
      await ui(article(page, 'Order shipped synthetic').getByRole('link')).toHaveAttribute(
        'href',
        '/orders?orderId=' + notificationOrder,
      );
      const wire = frames(await socket('source'));
      const id = sourcePublish('Hyperlocal explicit false synthetic', false);
      await fixture.publish(id, false);
      await ui.poll(() => wire.length).toBe(1);
      expect(String(z.object({ order_id: z.number() }).parse(wire[0]).order_id)).not.toBe(
        notificationOrder,
      );
      const target = article(page, 'Hyperlocal explicit false synthetic').getByRole('link');
      await ui(target).toHaveAttribute('href', '/orders?orderId=' + notificationOrder);
      await target.click();
      await ui(page).toHaveURL(fixture.origin + '/orders?orderId=' + notificationOrder);
      expect(await page.evaluate(() => history.state as unknown)).toMatchObject({
        usr: { orderSelection: { operatorId: '7', storeId: '1' } },
      });
      await ui.poll(async () => (await fixture.recipients(id))[0]?.is_viewed).toBe(1);
    });

    it('executes original login/read controls and proves server recipient, origin, store and current-check-in isolation', async () => {
      const sourceAnonymous = frames(await socket('source', null));
      const allowed = frames(await socket('candidate'));
      await expect(socket('candidate', null)).rejects.toThrow('WS_HTTP_401');
      await expect(
        socket('candidate', '7', '1', { origin: 'https://example.invalid' }),
      ).rejects.toThrow('WS_HTTP_403');
      await expect(socket('candidate', '7', '2')).rejects.toThrow('WS_HTTP_403');
      await expect(socket('candidate', '8')).rejects.toThrow('WS_HTTP_403');
      await fixture.checkIn('8', '1');
      const otherRecipient = frames(await socket('candidate', '8')),
        otherStore = frames(await socket('candidate', '9', '2'));
      await fixture.checkIn('8', null); // Original producer targets only checked-in actor 7.
      const id = sourcePublish('Recipient isolation synthetic');
      await fixture.checkIn('8', '1');
      await fixture.publish(id, true);
      await ui.poll(() => allowed.length).toBe(1);
      await ui.poll(() => sourceAnonymous.length).toBe(1);
      await new Promise((done) => setTimeout(done, 150));
      expect(otherRecipient).toEqual([]);
      expect(otherStore).toEqual([]);
      expect(fixture.source({ action: 'dispatch', serialized: '', actor: '7' })).toMatchObject({
        status: 200,
        body: { status: 'fail', message: 'Provide the id' },
      });
      expect(fixture.source({ action: 'dispatch', serialized: 'noti_id=' + id })).toMatchObject({
        status: 302,
      });
      expect(
        fixture.source({ action: 'dispatch', serialized: 'noti_id=' + id, actor: '8' }),
      ).toMatchObject({ status: 200, body: { status: 'success', message: 'Recorded' } });
      expect((await fixture.recipients(id))[0]?.is_viewed).toBe(0);
      expect((await http(notificationFeed + '/bad/read-receipt', 'PUT')).status).toBe(400);
      expect((await http(notificationFeed + '/' + id + '/read-receipt', 'PUT', '8')).status).toBe(
        200,
      );
      expect((await fixture.recipients(id))[0]?.is_viewed).toBe(0);
    });

    it('joins original static read controls and native repeated-read outcomes to authoritative App read-race and committed-response recovery', async () => {
      await fixture.seedNotice(nextId(1), 'Read first synthetic');
      await fixture.seedNotice(nextId(2), 'Read second synthetic');
      const source = await sourcePage();
      for (let attempt = 0; attempt < 2; attempt++) {
        const popupPromise = source.waitForEvent('popup');
        await source.locator('a.noti-' + nextId(1)).click();
        const popup = await popupPromise;
        await popup.close();
        await ui.poll(() => fixture.sourceTraffic.length).toBe(attempt + 1);
      }
      expect(await source.locator('a.noti-' + nextId(1)).getAttribute('is-viewed')).toBe('0');
      expect((await fixture.recipients(nextId(1)))[0]?.is_viewed).toBe(1);
      expect((await fixture.recipients(nextId(2)))[0]?.is_viewed).toBe(0);
      const page = await workspace();
      expect((await feed()).unreadCount).toBe(1);
      const incoming = sourcePublish('Read race incoming synthetic');
      await fixture.publish(incoming, true);
      await ui(article(page, 'Read race incoming synthetic')).toBeVisible();
      fixture.loseNextReadResponse();
      await article(page, 'Read second synthetic')
        .getByRole('button', { name: 'Mark read' })
        .click();
      await ui.poll(async () => (await fixture.recipients(nextId(2)))[0]?.is_viewed).toBe(1);
      await ui(
        article(page, 'Read second synthetic').getByRole('button', { name: 'Mark read' }),
      ).toHaveCount(0);
      expect((await feed()).unreadCount).toBe(1);
      expect(
        fixture.traffic.filter(
          (row) => row.method === 'PUT' && row.path.endsWith(nextId(2) + '/read-receipt'),
        ),
      ).toHaveLength(1);
      const before = await fixture.financialRows();
      await Promise.all([
        http(notificationFeed + '/' + incoming + '/read-receipt', 'PUT'),
        http(notificationFeed + '/' + incoming + '/read-receipt', 'PUT'),
      ]);
      expect((await feed()).unreadCount).toBe(0);
      expect(await fixture.financialRows()).toEqual(before);
    });

    it('recovers persisted notices over actual automatic reconnect and suppresses duplicate pointer replay', async () => {
      const page = await workspace();
      fixture.disconnect();
      const id = sourcePublish('Disconnected persisted synthetic');
      await fixture.publish(id, true);
      await ui.poll(() => fixture.streamCount('candidate')).toBe(1);
      await ui(article(page, 'Disconnected persisted synthetic')).toBeVisible();
      const count = (await feed()).unreadCount;
      await fixture.publish(id, true);
      await fixture.publish(id, true);
      await ui(article(page, 'Disconnected persisted synthetic')).toHaveCount(1);
      expect((await feed()).unreadCount).toBe(count);
      expect((await fixture.notices()).filter((row) => row.id === id)).toHaveLength(1);
    });

    it('revokes live delivery using actual current actor, assignment, check-in and native session expiry', async () => {
      await fixture.seedNotice(nextId(1), 'Authority synthetic');
      const page = await workspace(),
        credential = await fixture.cookie();
      const live = await socket('candidate');
      const closed = new Promise<number>((done) => live.once('close', done));
      await fixture.archiveActor(false);
      await fixture.publish(nextId(1), false);
      expect(await closed).toBe(1008);
      expect((await http(notificationFeed, 'GET', '7', credential)).status).toBe(401);
      await ui(page.locator('.notification-panel article')).toHaveCount(0);
      await fixture.archiveActor(true);
      for (const revoke of [() => fixture.removeAssignment(), () => fixture.expireCheckIn()]) {
        await fixture.reset();
        await fixture.seedNotice(nextId(1), 'Authority synthetic');
        const stream = await socket('candidate');
        const close = new Promise<number>((done) => stream.once('close', done));
        await revoke();
        await fixture.publish(nextId(1), false);
        expect(await close).toBe(1008);
        expect((await http()).status).toBe(403);
      }
      await fixture.reset();
      const short = await socket('candidate', '7', '1', { ttl: 750 });
      expect(await new Promise<number>((done) => short.once('close', done))).toBe(1008);
    });

    it('rejects malformed real Redis messages and uses safe React text and internal navigation for original unsafe titles/URLs', async () => {
      const page = await workspace(),
        source = await sourcePage();
      const receiver = frames(await socket('candidate'));
      for (const raw of [
        'not-json',
        '{}',
        JSON.stringify({
          event: 'notification.created',
          notificationId: 'bad',
          storeId: '1',
          userIds: ['7'],
          isNewOrder: false,
        }),
      ])
        await fixture.rawEvent(raw);
      const unsafe = '<img src=x onerror="window.notificationSourcePwned=true"> synthetic';
      const id = sourcePublish(unsafe, false);
      await fixture.publish(id, false);
      await ui.poll(() => receiver.length).toBe(1);
      await ui(article(page, unsafe)).toBeVisible();
      expect(await page.locator('.notification-widget img').count()).toBe(0);
      expect(
        await page.evaluate(() => Reflect.get(window, 'notificationSourcePwned') as unknown),
      ).toBeUndefined();
      await ui
        .poll(() =>
          source.evaluate(() => Reflect.get(window, 'notificationSourcePwned') as unknown),
        )
        .toBe(true);
      await fixture.seedNotice(
        nextId(10),
        'Unsafe URL synthetic',
        1,
        ['7'],
        notificationOrder,
        String.fromCharCode(47, 92) + 'example.invalid',
      );
      await fixture.publish(nextId(10), false);
      await ui(article(page, 'Unsafe URL synthetic').getByRole('link')).toHaveAttribute(
        'href',
        '/orders?orderId=' + notificationOrder,
      );
      expect((await feed()).data.find((row) => row.id === nextId(10))?.url).toBeNull();
      const malformed = await socket('source');
      const terminated = new Promise<void>((done) => malformed.once('close', () => done()));
      fixture.source({ action: 'malformed' });
      await terminated;
      expect(receiver).toHaveLength(2);
    });
  },
);
