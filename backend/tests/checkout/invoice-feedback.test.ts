import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const directory = resolve('compatibility/upstream/invoice-security'),
  commit = 'a941f4e84ed485c10169132a3972b8db74ab31bc',
  repo = resolve('../../backend-tss-post-order'),
  feedbackKey = 'separate-feedback-signing-key-'.repeat(3),
  customerKey = 'customer-signing-key-'.repeat(3),
  orderId = '9007199254740993',
  canary = 'PRIVATE-CUSTOMER@example.test-COOKIE-SECRET-QUERY-SQL-VENDOR';
const env = {
  POS_INVOICE_FEEDBACK_KEYS_JSON: JSON.stringify([{ id: 'invoice-fixture-1', key: feedbackKey }]),
  POS_INVOICE_FEEDBACK_MAX_TTL_SECONDS: '3600',
  POS_FEEDBACK_WEB_ORIGINS: JSON.stringify(['https://feedback.example.test']),
};
function proof(payload: Record<string, unknown> = {}, key = feedbackKey) {
  const now = Math.floor(Date.now() / 1000),
    encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url'),
    content = `${encode({ alg: 'HS256', typ: 'JWT', kid: 'invoice-fixture-1' })}.${encode({
      v: 1,
      iss: 'pos-invoice',
      aud: 'tss-pos-feedback',
      type: 'nps',
      purpose: 'nps',
      order_id: orderId,
      iat: now,
      exp: now + 3600,
      jti: '1'.repeat(32),
      ...payload,
    })}`;
  return content + '.' + createHmac('sha256', key).update(content).digest('base64url');
}
const source = (path: string) =>
  execFileSync('git', ['show', `${commit}:${path}`], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
function declaration(text: string, name: string) {
  const ast = ts.createSourceFile(
    'source.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const node = ast.statements.find((item) =>
    ts.isFunctionDeclaration(item)
      ? item.name?.text === name
      : ts.isVariableStatement(item) &&
        item.declarationList.declarations.some(
          (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
        ),
  );
  if (!node) throw new Error('Pinned source declaration was not found.');
  return node.getText(ast);
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
  vi.restoreAllMocks();
});
interface FixtureHelpers {
  events: { kind: string; orderId: unknown }[];
  fail: (value: boolean) => void;
}
async function fixture() {
  const root = await mkdtemp(resolve('.invoice-feedback-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  async function put(path: string, value: string) {
    const target = join(root, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, value);
  }
  await put('package.json', '{"type":"module"}');
  for (const [target, input] of [
    ['index.html', 'feedback.html'],
    ['feedback.js', 'feedback-client.js'],
    ['feedback.css', 'feedback.css'],
  ])
    await put('pos_feedback_public/' + target, await readFile(join(directory, input!), 'utf8'));
  for (const [target, input] of [
    ['pos_feedback_factory.ts', 'postorder_factory.ts'],
    ['src/utils/PosInvoiceFeedback.ts', 'PosInvoiceFeedback.ts'],
    ['src/utils/PosFeedbackPrivacy.ts', 'PosFeedbackPrivacy.ts'],
    ['src/utils/PosInvoiceFeedbackProof.ts', 'feedback-proof.ts'],
  ])
    await put(target!, await readFile(join(directory, input!), 'utf8'));
  await put(
    'src/config/server.config.ts',
    `export default {
    jwtSecret: ${JSON.stringify(customerKey)}, jwtSecret512: 'second-customer-key',
    nps: { secretKey: 'legacy-nps-key', baseUrl: 'https://feedback.example.test',
      exceptionUrl: 'https://feedback.example.test/unavailable', thankyouImage: '',
      xploroKey: 'PRIVATE-BUSINESS-KEY', xploroSecretKey: 'PRIVATE-VENDOR-KEY',
      xploroApiUrl: 'https://vendor.example.test' }
  };`,
  );
  const validator = source('src/utils/validator.ts');
  await put(
    'src/utils/validator.ts',
    [declaration(validator, 'npsPayload'), declaration(validator, 'npsQuery')].join('\n'),
  );
  await put(
    'src/utils/templates/index.ts',
    `export function renderTemplate() { return '<html>Thanks</html>'; }`,
  );
  await put(
    'src/controllers/nps/index.ts',
    source('src/controllers/nps/index.ts').replace(
      'import logger from "../../utils/logger.ts";',
      'import logger from "../../utils/PosFeedbackPrivacy.ts";',
    ),
  );
  await put('src/controllers/nps/dto.ts', source('src/controllers/nps/dto.ts'));
  const vendor = declaration(source('src/controllers/nps/helper.ts'), 'sendNpstoXploro');
  await put(
    'src/controllers/nps/vendor.ts',
    `import config from '../../config/server.config.ts';
    import logger from '../../utils/PosFeedbackPrivacy.ts';
    const axios = { post: async (_url: string, _body: unknown, _options: unknown) => {
      await Promise.resolve(); return { data: { email: ${JSON.stringify(canary)}, token: ${JSON.stringify(canary)} } };
    }};
    ${vendor}
  `,
  );
  await put(
    'src/controllers/nps/helper.ts',
    `
    export { sendNpstoXploro } from './vendor.ts';
    export const events: {kind:string;orderId:unknown}[] = [];
    let failed = false;
    export function fail(value:boolean) { failed=value; }
    export async function getPromoterScore(orderId:unknown) {
      events.push({kind:'read',orderId}); await Promise.resolve();
      if(failed) throw Object.assign(new Error(${JSON.stringify(canary)}), { sql: ${JSON.stringify(canary)} });
      return {score:4};
    }
    export async function getNpsUserRating() { return [{optionId:0,rating:null,comment:'Existing feedback'},{optionId:1,rating:2,comment:null}]; }
    export async function getPromoterScoreOptions() { return [{id:1,optionName:'Store service'}]; }
    export async function verifyOrderExclusiveness() { return false; }
    export async function getUserIdFromOrder() { return {userId:777}; }
    export async function updateNpsScore(orderId:unknown) { events.push({kind:'update',orderId}); }
    export async function createPromoterScore(orderId:unknown) { events.push({kind:'create',orderId}); }
    export async function bulkUpdateUserRating(orderId:unknown) { events.push({kind:'ratings',orderId}); }
    export async function updateNpsComment(orderId:unknown) { events.push({kind:'comment',orderId}); }
    export async function bulkCreateNpsRating() { throw new Error('Unexpected branch'); }
    export async function createNpsFeedback() { throw new Error('Unauthenticated redirect route must not run'); }
    export async function getNpsFeedback() { throw new Error('Unauthenticated redirect route must not run'); }
  `,
  );
  const factory = (await import(pathToFileURL(join(root, 'pos_feedback_factory.ts')).href)) as {
      createFeedbackApp: (configuration: NodeJS.ProcessEnv) => Promise<FastifyInstance>;
    },
    app = await factory.createFeedbackApp(env);
  cleanup.push(() => app.close());
  const helpers = (await import(
    pathToFileURL(join(root, 'src/controllers/nps/helper.ts')).href
  )) as FixtureHelpers;
  return { root, app, helpers, factory };
}
const headers = (token = proof()) => ({
  authorization: token,
  'x-pos-feedback-contract': 'pos-feedback-proof-v1',
  origin: 'https://feedback.example.test',
  cookie: canary,
  'x-request-id': canary,
});
function captureLogs() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

describe('isolated original-source invoice feedback consumer', () => {
  it('keeps both reviewable patches read-only and refuses stale or absent private configuration', async () => {
    for (const script of ['prepare.py', 'prepare_postorder.py'])
      execFileSync('python3', [join(directory, script)], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 65536,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    const { factory } = await fixture();
    await expect(factory.createFeedbackApp({})).rejects.toThrow('not configured');
    await expect(
      factory.createFeedbackApp({
        ...env,
        POS_INVOICE_FEEDBACK_KEYS_JSON: JSON.stringify([
          { id: 'invoice-fixture-1', key: customerKey },
        ]),
      }),
    ).rejects.toThrow('not configured');
    await expect(
      factory.createFeedbackApp({
        ...env,
        POS_FEEDBACK_WEB_ORIGINS: '["http://feedback.example.test"]',
      }),
    ).rejects.toThrow();
  });
  it('executes literal source GET/POST with exact long order IDs and a separate purpose proof', async () => {
    captureLogs();
    const { app, helpers } = await fixture();
    const loaded = await app.inject({
      method: 'GET',
      url: '/api/v1/post-order/nps/new-feedback?score=7',
      headers: headers(),
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toEqual({
      score: 4,
      isExclusive: false,
      additionalFeedback: 'Existing feedback',
      options: [{ id: 1, optionName: 'Store service', rating: 2 }],
      redirectTo: null,
    });
    expect(loaded.headers['x-pos-feedback-contract']).toBe('pos-feedback-proof-v1');
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/v1/post-order/nps/new-feedback',
      headers: headers(),
      payload: {
        score: 8,
        additionalFeedback: 'Store team was helpful',
        optionsResponses: [{ id: 1, rating: 3 }],
      },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toEqual({
      redirectTo: 'https://feedback.example.test/api/v1/post-order/nps/thank-you',
      error: false,
      errorMessage: null,
    });
    expect(helpers.events.length).toBeGreaterThan(2);
    expect(helpers.events.every((event) => event.orderId === orderId)).toBe(true);
    const publicPage = await app.inject({ method: 'GET', url: '/invoice-feedback' });
    expect(publicPage.statusCode).toBe(200);
    expect(publicPage.headers['content-security-policy']).toContain("script-src 'self'");
    expect(publicPage.headers['cache-control']).toBe('no-store');
    const script = await app.inject({ method: 'GET', url: '/invoice-feedback.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('application/javascript');
  });
  it('rejects customer/legacy/missing/expired/cross-purpose proofs before source reads and does not register order-only writers', async () => {
    captureLogs();
    const { app, helpers } = await fixture(),
      path = '/api/v1/post-order/nps/new-feedback?score=7';
    for (const token of [
      '',
      canary,
      proof({}, customerKey),
      proof({ purpose: 'login' }),
      proof({ aud: 'customer' }),
      proof({ order_id: Number(orderId) }),
      proof({ exp: 1 }),
      proof({ sub: '777' }),
    ])
      expect(
        (await app.inject({ method: 'GET', url: path, headers: headers(token) })).statusCode,
      ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: path, headers: { authorization: proof() } }))
        .statusCode,
    ).toBe(401);
    expect(helpers.events).toEqual([]);
    for (const route of [
      '/api/v1/post-order/nps/?order_id=777&score=10',
      '/api/v1/post-order/nps/pos?order_id=777&score=10',
      '/other?token=' + canary,
    ])
      expect((await app.inject({ method: 'GET', url: route, headers: headers() })).statusCode).toBe(
        404,
      );
    const invalidOrigin = await app.inject({
      method: 'GET',
      url: path,
      headers: { ...headers(), origin: 'https://untrusted.example.test' },
    });
    expect(invalidOrigin.statusCode).toBe(403);
    expect(helpers.events).toEqual([]);
  });
  it('keeps token, cookie, URL, body, database error and vendor-response canaries out of every scoped log', async () => {
    const logs = captureLogs(),
      { app, helpers } = await fixture();
    const token = proof(),
      authHeaders = headers(token);
    await app.inject({ method: 'GET', url: '/not-found?token=' + canary, headers: authHeaders });
    await app.inject({
      method: 'POST',
      url: '/api/v1/post-order/nps/new-feedback',
      headers: authHeaders,
      payload: { score: 8, additionalFeedback: canary, optionsResponses: [{ id: 1, rating: 2 }] },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/post-order/nps/new-feedback',
      headers: authHeaders,
      payload: { score: canary },
    });
    helpers.fail(true);
    const failed = await app.inject({
      method: 'POST',
      url: '/api/v1/post-order/nps/new-feedback',
      headers: authHeaders,
      payload: { score: 8, additionalFeedback: canary },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain(canary);
    await new Promise((done) => setTimeout(done, 10));
    expect(logs.join('')).not.toContain(canary);
    expect(logs.join('')).not.toContain(token);
    const events = logs
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.length).toBeGreaterThan(5);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual([
        'eventId',
        'module',
        'requestId',
        'resource',
        'userId',
      ]);
      expect(event).toMatchObject({ module: 'customer-feedback', resource: 'nps', userId: null });
      expect(event.requestId).toMatch(/^[a-f0-9-]{36}$/);
    }
  });
  it('isolates concurrent correlations and returns bounded errors without reflecting raw validation data', async () => {
    const logs = captureLogs(),
      { app } = await fixture();
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        app.inject({
          method: 'GET',
          url: '/api/v1/post-order/nps/new-feedback?score=7',
          headers: { ...headers(), cookie: canary + index },
        }),
      ),
    );
    expect(replies.every((reply) => reply.statusCode === 200)).toBe(true);
    const ids = new Set(replies.map((reply) => reply.headers['x-request-id']));
    expect(ids.size).toBe(20);
    const events = logs
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { requestId: string; eventId: string });
    for (const id of ids)
      expect(
        events.filter((event) => event.requestId === id).map((event) => event.eventId),
      ).toEqual(['customer-feedback.nps.request', 'customer-feedback.nps.complete']);
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/post-order/nps/new-feedback',
      headers: headers(),
      payload: { score: 8, additionalFeedback: canary.repeat(1000) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body).not.toContain(canary);
  });
  it('the original generic customer-token decoders reject a valid separate feedback capability', async () => {
    captureLogs();
    const { root } = await fixture(),
      sourceAuth = source('src/utils/authHandler.ts');
    const decoder = join(root, 'customer-decoder.ts');
    await writeFile(
      decoder,
      `import crypto from 'node:crypto'; const TOKEN_EXPIRED='TOKEN_EXPIRED';
      ${declaration(sourceAuth, 'decodeJwt')}
      ${declaration(sourceAuth, 'decodeJwt512')}
      export { decodeJwt,decodeJwt512 };`,
    );
    const loaded = (await import(pathToFileURL(decoder).href)) as {
      decodeJwt: (token: string, key: string) => unknown;
      decodeJwt512: (token: string, key: string) => unknown;
    };
    expect(() => loaded.decodeJwt(proof(), customerKey)).toThrow();
    expect(() => loaded.decodeJwt512(proof(), 'second-customer-key')).toThrow();
    // Even a separately configured verifier cannot accidentally create a login subject.
    expect(() => loaded.decodeJwt(proof(), feedbackKey)).toThrow('missing sub');
  });
  it('strictly typechecks the new production entrypoint, verifier and closed logger against typed source seams', async () => {
    captureLogs();
    const { root } = await fixture();
    await writeFile(
      join(root, 'src/controllers/nps/index.ts'),
      `import type {RouteHandlerMethod} from 'fastify';
      export declare const loadSurvey:RouteHandlerMethod;
      export declare const submitSurvey:RouteHandlerMethod;
      export declare const alreadySubmittedPage:RouteHandlerMethod;
      export declare const thankYouPage:RouteHandlerMethod;`,
    );
    await writeFile(
      join(root, 'src/utils/validator.ts'),
      `import type {SchemaObject} from 'ajv';
      export declare const npsPayload:SchemaObject;
      export declare const npsQuery:SchemaObject;`,
    );
    await writeFile(
      join(root, 'pos_feedback_main.ts'),
      await readFile(join(directory, 'postorder_main.ts'), 'utf8'),
    );
    const configuration = join(root, 'tsconfig.json');
    await writeFile(
      configuration,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          types: ['node'],
          noUnusedLocals: true,
          noUnusedParameters: true,
        },
        files: [
          'pos_feedback_main.ts',
          'pos_feedback_factory.ts',
          'src/utils/PosInvoiceFeedback.ts',
          'src/utils/PosFeedbackPrivacy.ts',
          'src/utils/PosInvoiceFeedbackProof.ts',
        ],
      }),
    );
    const checked = spawnSync(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '--project', configuration],
      {
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 65536,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    expect(checked.stdout + checked.stderr).toBe('');
    expect(checked.status).toBe(0);
  }, 30000);
});
