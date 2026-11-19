import type { FastifyInstance, RouteOptions } from 'fastify';
import { z } from 'zod';

/**
 * Declarative request validation (Phase E2). Every route declares zod schemas for the parts of
 * the request it accepts: `params`, `querystring`, `body` (POST/PUT/PATCH/DELETE) and `headers`.
 * Fastify runs them before authentication and the handler; a failure becomes a 400
 * `INVALID_REQUEST` whose details never echo submitted values (see `validationIssues`).
 *
 * Handlers keep parsing their inputs with the same schema objects, so transforms, defaults and
 * coercions stay where the handler reads them; the declared schema is the gate and the contract.
 */
export interface RouteSchema {
  params?: z.ZodType;
  querystring?: z.ZodType;
  body?: z.ZodType;
  headers?: z.ZodType;
}

/** Routes without a query string reject every query key. */
export const noQuery = z.strictObject({});
/** Routes without a body accept no body (Fastify passes `null`) or an empty JSON object. */
export const noBody = z.union([z.null(), z.strictObject({})]);
/**
 * Header objects are the one systematic passthrough: browsers, Electron and proxies add their
 * own transport headers (user agent, cookies, forwarding, fetch metadata), so only the headers a
 * route consumes are declared and validated, and every other header is left untouched.
 */
export const requestHeaders = <T extends z.core.$ZodLooseShape>(shape: T) => z.looseObject(shape);
/** Transport headers only: the route reads no request header of its own. */
export const transportHeaders = requestHeaders({});
/** The operator assertion the web client sends on owner-bound requests (`X-Operator-ID`). */
export const operatorHeaders = requestHeaders({
  'x-operator-id': z
    .string()
    .regex(/^[1-9]\d{0,19}$/)
    .optional(),
});

/** Route options fragment: `{ ...trace(...), ...routeSchema({ params, querystring, body, headers }) }`. */
export function routeSchema(schema: RouteSchema): { schema: RouteSchema } {
  return { schema };
}

export interface RegisteredRoute {
  method: string;
  url: string;
  schema: RouteSchema | undefined;
  handler: RouteOptions['handler'];
  authentication: 'session' | 'service';
}
const registries = new WeakMap<FastifyInstance, RegisteredRoute[]>();
/** Every route registered on the app, with its declared schemas (route-validation test). */
export function registeredRoutes(app: FastifyInstance): RegisteredRoute[] {
  return [...(registries.get(app) || [])];
}

/** Validate with the declared zod schema; the handler still receives the original value. */
export function registerRouteValidation(app: FastifyInstance) {
  const registry: RegisteredRoute[] = [];
  registries.set(app, registry);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods)
      registry.push({
        method,
        url: route.url,
        schema: route.schema as RouteSchema | undefined,
        handler: route.handler,
        authentication: route.config?.authentication || 'session',
      });
  });
  app.setValidatorCompiler(({ schema, method, url, httpPart }) => {
    if (!(schema instanceof z.ZodType))
      throw new Error(`Route ${method} ${url} declares a non-zod ${httpPart ?? 'request'} schema.`);
    return (data: unknown) => {
      const result = schema.safeParse(data);
      return result.success ? { value: data } : { error: result.error };
    };
  });
}

const safeSegment = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const issueMessages: Record<string, string> = {
  invalid_type: 'Enter a value of the expected type.',
  too_big: 'The value is too large or too long.',
  too_small: 'The value is too small, too short or missing.',
  invalid_format: 'The value is not in the expected format.',
  not_multiple_of: 'The value is not an allowed step.',
  unrecognized_keys: 'Remove fields this request does not accept.',
  invalid_union: 'The value does not match any accepted form.',
  invalid_key: 'A key is not in the expected format.',
  invalid_element: 'An entry is not in the expected format.',
  invalid_value: 'Choose one of the accepted values.',
};

/**
 * Field-level validation detail without submitted values: paths keep schema field names and
 * array positions only (record keys, which are data, become `*`), and messages come from a fixed
 * table, so no value, unknown key name or provider text reaches the client or the logs.
 */
export function validationIssues(issues: readonly z.core.$ZodIssue[]) {
  return issues.slice(0, 50).map((issue) => ({
    path: issue.path
      .map((segment) =>
        typeof segment === 'number' || (typeof segment === 'string' && safeSegment.test(segment))
          ? String(segment)
          : '*',
      )
      .join('.'),
    code: issue.code,
    // Custom issues carry messages authored in our schemas (static text, never input values).
    message:
      issue.code === 'custom' && issue.message
        ? issue.message.slice(0, 200)
        : (issueMessages[issue.code] ?? 'Check this field.'),
  }));
}
