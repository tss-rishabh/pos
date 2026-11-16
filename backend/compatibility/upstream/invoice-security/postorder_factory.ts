import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fastify, { type FastifyRequest } from 'fastify';
import config from './src/config/server.config.ts';
import { npsPayload, npsQuery } from './src/utils/validator.ts';
import {
  invoiceFeedbackConfiguration,
  verifyInvoiceFeedback,
} from './src/utils/PosInvoiceFeedback.ts';
import {
  emitFeedbackEvent,
  feedbackLogger,
  withFeedbackRequest,
} from './src/utils/PosFeedbackPrivacy.ts';

const endpoint = '/api/v1/post-order/nps/new-feedback';
/** Isolated entrypoint: never import main, authHandler, logger or instrumentation. */
export async function createFeedbackApp(env: NodeJS.ProcessEnv = process.env) {
  const security = invoiceFeedbackConfiguration(
    [config.jwtSecret, config.jwtSecret512, config.nps.secretKey],
    env,
  );
  const { loadSurvey, submitSurvey, alreadySubmittedPage, thankYouPage } =
    await import('./src/controllers/nps/index.ts');
  const assets = {
    html: readFileSync(new URL('./pos_feedback_public/index.html', import.meta.url), 'utf8'),
    js: readFileSync(new URL('./pos_feedback_public/feedback.js', import.meta.url), 'utf8'),
    css: readFileSync(new URL('./pos_feedback_public/feedback.css', import.meta.url), 'utf8'),
  };
  const app = fastify({
    logger: false,
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 32 * 1024,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    keepAliveTimeout: 5000,
    ajv: { customOptions: { coerceTypes: true, useDefaults: true, removeAdditional: true } },
  });
  // No raw IP is retained. Bounded, process-local rate control supplements edge limits.
  const rateKey = randomBytes(32),
    rates = new Map<string, { count: number; until: number }>();
  function permit(request: FastifyRequest) {
    const now = Date.now(),
      key = createHmac('sha256', rateKey).update(request.ip).digest('hex');
    let entry = rates.get(key);
    if (!entry || entry.until <= now) {
      if (rates.size >= 10000) {
        for (const [id, row] of rates) if (row.until <= now) rates.delete(id);
        if (rates.size >= 10000) return false;
      }
      entry = { count: 0, until: now + 60000 };
      rates.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= 60;
  }
  app.addHook('onRequest', (request, response, done) => {
    withFeedbackRequest(request.id, () => {
      emitFeedbackEvent('customer-feedback.nps.request');
      response.header('Cache-Control', 'no-store');
      response.header('Referrer-Policy', 'no-referrer');
      response.header('X-Content-Type-Options', 'nosniff');
      response.header('X-Request-ID', request.id);
      const origin = request.headers.origin;
      if (origin !== undefined && (typeof origin !== 'string' || !security.origins.has(origin))) {
        void response.status(403).send({ error: { code: 'FEEDBACK_ORIGIN_INVALID' } });
        return;
      }
      if (origin) {
        response.header('Access-Control-Allow-Origin', origin);
        response.header('Vary', 'Origin');
      }
      if (!permit(request)) {
        void response.status(429).send({ error: { code: 'FEEDBACK_RATE_LIMITED' } });
        return;
      }
      if (
        request.routeOptions.url === endpoint &&
        request.method !== 'OPTIONS' &&
        !verifyInvoiceFeedback(request, response, security)
      ) {
        void response.status(401).send({ error: { code: 'FEEDBACK_PROOF_INVALID' } });
        return;
      }
      done();
    });
  });
  app.setErrorHandler((error, request, response) => {
    withFeedbackRequest(request.id, () => feedbackLogger.error(error));
    const code =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : null;
    const status = code === 400 || code === 413 ? code : 503;
    return response
      .status(status)
      .send({
        error: { code: status === 503 ? 'FEEDBACK_UNAVAILABLE' : 'FEEDBACK_INPUT_INVALID' },
      });
  });
  app.setNotFoundHandler((_request, response) =>
    response.status(404).send({ error: { code: 'FEEDBACK_RESOURCE_NOT_FOUND' } }),
  );
  app.addHook('onResponse', async (request) => {
    withFeedbackRequest(request.id, () => emitFeedbackEvent('customer-feedback.nps.complete'));
  });
  app.options(endpoint, async (_request, response) =>
    response
      .header('Access-Control-Allow-Methods', 'GET, POST')
      .header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-POS-Feedback-Contract',
      )
      .header('Access-Control-Max-Age', '0')
      .status(204)
      .send(),
  );
  app.get(endpoint, { schema: { querystring: npsQuery } }, loadSurvey);
  app.post(endpoint, { schema: { body: npsPayload } }, submitSurvey);
  app.get('/api/v1/post-order/nps/feedback', alreadySubmittedPage);
  app.get('/api/v1/post-order/nps/thank-you', thankYouPage);
  app.get('/invoice-feedback', async (_request, response) =>
    response
      .header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      )
      .type('text/html; charset=utf-8')
      .send(assets.html),
  );
  app.get('/invoice-feedback.js', async (_request, response) =>
    response.type('application/javascript; charset=utf-8').send(assets.js),
  );
  app.get('/invoice-feedback.css', async (_request, response) =>
    response.type('text/css; charset=utf-8').send(assets.css),
  );
  return app;
}
