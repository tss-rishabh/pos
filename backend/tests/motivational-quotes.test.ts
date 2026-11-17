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
        `import ast, hashlib, json, os, types
from pathlib import Path
source = Path(os.environ.get('LEGACY_SOURCE_ROOT', '../../backend-pos-web')) / 'core'
pins = {'quotes.py':'5a0367c1557da49fcf1bea16b689718a674fe18bfa735507b8df1e22858c9216',
        'views.py':'20f9910156aa3c427df759bdd26f4d19992a91f0a1ea1df915fa98eb3b2de349',
        'urls.py':'d39946333ef88c2f9210844172d6191f2cf9c4adff4cb7c83be9d920d586a124'}
raw = {name:(source / name).read_bytes() for name in pins}
assert all(hashlib.sha256(raw[name]).hexdigest() == expected for name,expected in pins.items())
pool = ast.literal_eval(ast.parse(raw['quotes.py']).body[0].value)
handler = next(node for node in ast.parse(raw['views.py']).body if isinstance(node, ast.ClassDef) and node.name == 'AjaxGetQuotesView')
assert [base.id for base in handler.bases] == ['LoginRequiredMixin','View']
route = [node for node in ast.walk(ast.parse(raw['urls.py'])) if isinstance(node,ast.Call)
         and isinstance(node.func,ast.Name) and node.func.id == 'path' and node.args
         and isinstance(node.args[0],ast.Constant) and node.args[0].value == 'ajax-get-quotes/']
assert len(route) == 1 and route[0].lineno == 66
assert ast.unparse(route[0].args[1]) == 'sync_to_async(core_views.AjaxGetQuotesView.as_view(), thread_sensitive=False)'
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
