import { _electron } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { signIn } from './support/login';

test('native desktop shell loads the shared UI with a sandboxed, isolated renderer', async ({
  network,
}) => {
  const profile = await mkdtemp(join(tmpdir(), 'souled-pos-electron-'));
  const app = await _electron.launch({
    // macOS: never touch the developer's login keychain (Windows uses real DPAPI).
    args: [...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), '.'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      POS_DESKTOP_URL: 'http://localhost:4173',
      POS_DESKTOP_PROFILE_DIR: profile,
    },
  });
  app.windows().forEach(network.watch);
  app.on('window', network.watch);
  try {
    const window = await app.firstWindow();
    await signIn(window);
    await expect(window.getByRole('heading', { name: 'The counter.' })).toBeVisible();
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window?.webContents.getLastWebPreferences();
    });
    expect(preferences?.sandbox).toBe(true);
    expect(preferences?.contextIsolation).toBe(true);
    expect(preferences?.nodeIntegration).toBe(false);
    await window.screenshot({ path: 'test-results/electron-counter.png', fullPage: true });
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('desktop shell blocks external links, redirects and new windows', async ({ network }) => {
  // The shell cancels the fixture's redirect to an external origin on purpose.
  network.expectFailure({ method: 'GET', path: '/redirect', outcome: 'net::ERR_ABORTED' });
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: 'https://blocked.example.test/redirected' });
      response.end();
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        '<!doctype html><title>Navigation fixture</title><a href="/redirect">Follow redirect</a><a href="https://blocked.example.test/direct">External link</a>',
      );
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable.');
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'souled-pos-navigation-'));
  const app = await _electron.launch({
    // macOS: never touch the developer's login keychain (Windows uses real DPAPI).
    args: [...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), '.'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      POS_DESKTOP_URL: origin,
      POS_DESKTOP_PROFILE_DIR: profile,
      POS_OAUTH_ORIGINS: 'https://oauth.example.test',
      POS_APP_LINK_ORIGINS: 'https://application.example.test',
      POS_CUSTOMER_WEBSITE_ORIGIN: 'https://customer.example.test',
    },
  });
  app.windows().forEach(network.watch);
  app.on('window', network.watch);
  try {
    const window = await app.firstWindow();
    const [redirect] = await Promise.all([
      app.evaluate(
        ({ BrowserWindow }) =>
          new Promise<{ blocked: boolean; destination: string }>((done) => {
            BrowserWindow.getAllWindows()[0]!.webContents.once(
              'will-redirect',
              (event, destination) => done({ blocked: event.defaultPrevented, destination }),
            );
          }),
      ),
      window.getByRole('link', { name: 'Follow redirect' }).click({ noWaitAfter: true }),
    ]);
    expect(redirect).toEqual({
      blocked: true,
      destination: 'https://blocked.example.test/redirected',
    });
    const [navigation] = await Promise.all([
      app.evaluate(
        ({ BrowserWindow }) =>
          new Promise<boolean>((done) => {
            BrowserWindow.getAllWindows()[0]!.webContents.once('will-navigate', (event) =>
              done(event.defaultPrevented),
            );
          }),
      ),
      window.getByRole('link', { name: 'External link' }).click({ noWaitAfter: true }),
    ]);
    expect(navigation).toBe(true);
    expect(window.url()).toBe(origin + '/');
    expect(
      await window.evaluate(() => window.open('https://blocked.example.test/popup') === null),
    ).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await window.evaluate(() => Reflect.has(window, 'require'))).toBe(false);
    const policies = await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      return [
        'https://oauth.example.test/authorize',
        'https://oauth.example.test.evil.test/authorize',
        'https://user:secret@oauth.example.test/authorize',
        'http://oauth.example.test/authorize',
      ].map((destination) => {
        const event = {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
        };
        contents.emit('will-navigate', event, destination);
        return event.defaultPrevented;
      });
    });
    expect(policies).toEqual([false, true, true, true]);
    await window.goto(origin + '/application-links/customer');
    const applicationLinks = await app.evaluate(async ({ BrowserWindow, shell }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const original = shell.openExternal;
      const opened: string[] = [];
      shell.openExternal = async (destination: string) => {
        opened.push(destination);
      };
      try {
        const destinations = [
          'https://application.example.test/open?id=POSApp&store_id=42',
          'https://application.example.test.evil.test/open?store_id=42',
          'https://user:secret@application.example.test/open',
          'http://application.example.test/open',
          'file:///tmp/installer',
          'javascript:alert(1)',
          'https://application.example.test/open?redirect=blocked',
          'https://application.example.test/open?store_id=1&store_id=2',
          'https://application.example.test/open?store_id=2147483648',
        ];
        const blocked = destinations.map((destination) => {
          const event = {
            defaultPrevented: false,
            preventDefault() {
              this.defaultPrevented = true;
            },
          };
          contents.emit('will-navigate', event, destination);
          return event.defaultPrevented;
        });
        const redirect = { preventDefault() {} };
        contents.emit('will-redirect', redirect, destinations[0]);
        await contents.executeJavaScript(
          "window.open('https://application.example.test/open?store_id=42')",
        );
        return { opened, blocked };
      } finally {
        shell.openExternal = original;
      }
    });
    expect(applicationLinks.blocked).toEqual(Array(9).fill(true));
    expect(applicationLinks.opened).toEqual([
      'https://application.example.test/open?id=POSApp&store_id=42',
      'https://application.example.test/open?store_id=42',
    ]);
    expect(window.url()).toBe(origin + '/application-links/customer');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await window.goto(origin + '/');
    const customerWebsite = await app.evaluate(async ({ BrowserWindow, shell }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const original = shell.openExternal;
      const opened: string[] = [];
      const usage: (boolean | undefined)[] = [];
      shell.openExternal = async (destination, options) => {
        opened.push(destination);
        usage.push(options?.logUsage);
      };
      const valid = 'https://customer.example.test/pos/secure-login#' + 'a'.repeat(43);
      try {
        const destinations = [
          valid,
          valid.replace('customer.example.test', 'customer.example.test.evil.test'),
          valid.replace('https:', 'http:'),
          valid.replace('customer.example.test', 'user:secret@customer.example.test'),
          valid.replace('/pos/secure-login', '/other'),
          valid.replace('#', '?api_key=credential#'),
          valid + 'extra',
          valid.replace(/#.*$/, '#short'),
          'file:///tmp/website',
        ];
        const blocked = destinations.map((destination) => {
          const event = {
            defaultPrevented: false,
            preventDefault() {
              this.defaultPrevented = true;
            },
          };
          contents.emit('will-navigate', event, destination);
          return event.defaultPrevented;
        });
        contents.emit('will-redirect', { preventDefault() {} }, valid);
        await contents.executeJavaScript('window.open(' + JSON.stringify(valid) + ')');
        return { blocked, opened, usage };
      } finally {
        shell.openExternal = original;
      }
    });
    expect(customerWebsite.blocked).toEqual(Array(9).fill(true));
    expect(customerWebsite.opened).toEqual(
      Array(2).fill('https://customer.example.test/pos/secure-login#' + 'a'.repeat(43)),
    );
    expect(customerWebsite.usage).toEqual([false, false]);
    expect(window.url()).toBe(origin + '/');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
    await new Promise<void>((done, failed) =>
      server.close((error) => (error ? failed(error) : done())),
    );
  }
});
