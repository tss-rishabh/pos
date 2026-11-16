import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import { AppError } from '../src/domain/errors.js';
import { demoUser } from '../src/modules/demo.js';
import { registerMotivationalQuotes } from '../src/modules/motivational-quotes/index.js';
import { motivationalQuotePool } from '../src/modules/motivational-quotes/pool.js';
import { registerEventCatalog, resourceRoutes } from '../src/observability/events.js';

describe('source customer-service thoughts', () => {
  it('preserves every result of the actual pinned Python handler', () => {
    const output = execFileSync(
      'python3',
      [
        '-c',
        `import ast, hashlib, json, types
from pathlib import Path
source = Path('../../backend-pos-web/core')
pool_file = source / 'quotes.py'
assert hashlib.sha256(pool_file.read_bytes()).hexdigest() == '5a0367c1557da49fcf1bea16b689718a674fe18bfa735507b8df1e22858c9216'
pool = ast.literal_eval(ast.parse(pool_file.read_text()).body[0].value)
handler = next(node for node in ast.parse((source / 'views.py').read_text()).body if isinstance(node, ast.ClassDef) and node.name == 'AjaxGetQuotesView')
method = next(node for node in handler.body if isinstance(node, ast.FunctionDef) and node.name == 'get')
space = {'json': json, 'quotes': types.SimpleNamespace(quotes_list=pool), 'HttpResponse': lambda body, **kwargs: json.loads(body)}
exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), 'pinned-quote-handler', 'exec'), space)
results=[]
for index in range(len(pool)):
    space['random'] = types.SimpleNamespace(choice=lambda values: values[index])
    value = space['get'](None, None)
    assert value['status'] == 'success'
    results.append(value['data'])
print(json.dumps(results))`,
      ],
      { encoding: 'utf8' },
    );
    expect(z.array(z.string()).parse(JSON.parse(output) as unknown)).toEqual(motivationalQuotePool);
    expect(motivationalQuotePool).toHaveLength(83);
  });

  it('requires authentication and serves only a source quote under a resource event', async () => {
    const app = Fastify();
    registerEventCatalog(app);
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-fixture-operator'] === 'signed-in') request.principal = demoUser;
    });
    app.setErrorHandler((error, _request, reply) => {
      const status =
        error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500;
      return reply.code(status).send({ rejected: true });
    });
    registerMotivationalQuotes(app);
    try {
      const anonymous = await app.inject('/api/v1/motivational-quotes/random');
      expect(anonymous.statusCode).toBe(401);
      const headers = { 'x-fixture-operator': 'signed-in' };
      const reply = await app.inject({ url: '/api/v1/motivational-quotes/random', headers });
      expect(reply.statusCode).toBe(200);
      const body = z
        .object({ text: z.string() })
        .strict()
        .parse(reply.json() as unknown);
      expect(motivationalQuotePool).toContain(body.text);
      expect(resourceRoutes(app)).toEqual([
        {
          module: 'workspace',
          resource: 'motivational-quote',
          action: 'read',
          method: 'GET',
          path: '/api/v1/motivational-quotes/random',
          authentication: 'session',
        },
      ]);
      const malformed = await app.inject({
        url: '/api/v1/motivational-quotes/random?text=untrusted',
        headers,
      });
      expect(malformed.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
