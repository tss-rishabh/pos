import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** W26 UAT desktop support. Ports follow backend/tools/uat-e2e/uat-stack.ts (base 4760). */
const base = Number(process.env.W26_PORT_BASE ?? '4760');
export const workspace = `http://localhost:${base}`;
export const control = `http://127.0.0.1:${base + 4}`;
export const evidence = resolve(import.meta.dirname, '../../.tmp/w26');
mkdirSync(join(evidence, 'shots'), { recursive: true });

/** Real UAT identities given by the user (never another customer). */
export const uat = { operatorId: '268', storeId: '7', counterId: '7', customerId: '12132565' };

function credentials() {
  const text = readFileSync(join(homedir(), '.config/pos-uat/uat.env'), 'utf8');
  const value = (key: string) => {
    const line = text.split('\n').find((entry) => entry.startsWith(`${key}=`));
    if (!line) throw new Error(`uat.env has no ${key}`);
    return line
      .slice(key.length + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  };
  return {
    username: value('UAT_LOGIN_USERNAME'),
    password: value('UAT_LOGIN_PASSWORD'),
    otp: value('UAT_FIXED_OTP'),
  };
}

export interface Desktop {
  app: ElectronApplication;
  page: Page;
  profile: string;
}
/** The dev (unpackaged) Electron app on the UAT workspace, with the macOS mock keychain. */
export async function launchDesktop(label: string, profile?: string): Promise<Desktop> {
  const directory = profile ?? (await mkdtemp(join(tmpdir(), 'w26-uat-profile-')));
  const app = await _electron.launch({
    args: ['--use-mock-keychain', '.'],
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      POS_DESKTOP_URL: workspace,
      POS_DESKTOP_PROFILE_DIR: directory,
    },
  });
  const page = await app.firstWindow();
  recordApi(page, label);
  return { app, page, profile: directory };
}

export async function closeDesktop(desktop: Desktop) {
  const child = desktop.app.process();
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((done) => child.once('exit', () => done()));
  void desktop.app.close().catch(() => undefined);
  const done = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 15000)),
  ]);
  if (!done) {
    child.kill('SIGTERM');
    await exited;
  }
}

/**
 * Every /api/ response: method, path (no query), status and, for errors, the error code only.
 * Bodies, query values and headers are never recorded.
 */
export function recordApi(page: Page, label: string) {
  page.on('response', (response) => {
    let path = '';
    try {
      path = new URL(response.url()).pathname;
    } catch {
      return;
    }
    if (!path.startsWith('/api/')) return;
    const status = response.status();
    const method = response.request().method();
    const write = (code?: string) =>
      appendFileSync(
        join(evidence, 'api-log.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), label, method, path, status, code })}\n`,
      );
    if (status < 400) return write();
    response
      .json()
      .then((body: unknown) => {
        const record = body as { code?: unknown; error?: { code?: unknown } };
        const code = record?.error?.code ?? record?.code;
        write(typeof code === 'string' && /^[A-Z0-9_]{2,80}$/.test(code) ? code : undefined);
      })
      .catch(() => write());
  });
}

/** Real sign-in: password, then the fixed login OTP for user 268, store 7. */
export async function signIn(page: Page, storeId = uat.storeId) {
  const login = credentials();
  await page.getByLabel('Email or username').fill(login.username);
  await page.getByLabel('Password', { exact: true }).fill(login.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Login store')).toBeVisible();
  await page.getByLabel('Login store').selectOption(storeId);
  await page.getByLabel('Verification code').fill(login.otp);
  await page.getByRole('button', { name: 'Verify & check in' }).click();
}

export async function shot(page: Page, name: string) {
  await page
    .screenshot({ path: join(evidence, 'shots', `${name}.png`), fullPage: true })
    .catch(() => undefined);
}

export async function stackControl<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(control + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control ${path} failed with ${response.status}`);
  return (await response.json()) as T;
}

/** Appends one line to the UAT write ledger scratch file (turned into w26-uat-writes.md). */
export function ledger(entry: Record<string, unknown>) {
  appendFileSync(
    join(evidence, 'writes.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
}

/** Visible text of the main region, for flow notes (UAT test data only). */
export async function mainText(page: Page) {
  return (
    await page
      .locator('main')
      .first()
      .innerText()
      .catch(() => '')
  ).slice(0, 4000);
}
