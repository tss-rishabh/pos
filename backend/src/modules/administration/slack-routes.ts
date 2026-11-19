import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createHmac } from 'node:crypto';
import type { Config } from '../../config.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { routeSchema, transportHeaders } from '../../domain/route-validation.js';
import {
  slackBroadcastChannel,
  slackCallbackInput,
  slackConnectInput,
  type SlackConnectResult,
  type slackConnectionService,
} from './slack-connections.js';

/** Slack's OAuth redirect carries only `code`, `state` and `error` (legacy view reads no other key). */
const slackCallbackQuery = slackCallbackInput.strict();

/**
 * Popup script of legacy `stores/templates/stores/slack_callback.html:30-38`: post the result to
 * the opener form over BroadcastChannel `tss-slack-connect`, then close on success.
 */
const popupScript = `(function () {
  var result = JSON.parse(document.getElementById('slack-result').textContent);
  if ('BroadcastChannel' in window) {
    var channel = new BroadcastChannel(${JSON.stringify(slackBroadcastChannel)});
    channel.postMessage(result);
    channel.close();
    if (result.ok) window.close();
  }
  var copy = document.getElementById('slack-copy');
  if (copy) copy.addEventListener('click', function () {
    navigator.clipboard.writeText(document.getElementById('slack-url').value);
    copy.textContent = 'Copied';
  });
})();`;
const popupScriptHash = createHash('sha256').update(popupScript).digest('base64');
const html = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
/** JSON inside a `<script type="application/json">` element; `<` is escaped as Django's json_script. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/&/g, '\\u0026');
export function slackCallbackPage(result: SlackConnectResult) {
  const body = result.ok
    ? `<h3 class="ok">Connected to ${html(result.channel || 'the selected channel')}</h3>
<p>The URL has been filled into the store form. Close this window and click Save there. If the field is still empty, copy the URL below and paste it in.</p>
<input id="slack-url" type="text" value="${html(result.url || '')}" readonly>
<button type="button" id="slack-copy">Copy URL</button>`
    : `<h3 class="err">Slack connect failed</h3>
<p>${html(result.error || '')}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>POS | Slack Connect</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px 16px; background: #f4f6f9; color: #212529; }
.box { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
.ok { color: #1e7e34; } .err { color: #bd2130; }
input { width: 100%; box-sizing: border-box; padding: 8px; margin: 12px 0; font-family: monospace; font-size: 13px; }
button { padding: 8px 14px; cursor: pointer; }
</style>
</head>
<body>
<div class="box">
${body}
</div>
<script id="slack-result" type="application/json">${scriptJson(result)}</script>
<script>${popupScript}</script>
</body>
</html>`;
}

export function registerSlackConnections(
  app: FastifyInstance,
  config: Config,
  service: ReturnType<typeof slackConnectionService>,
) {
  const binding = (request: FastifyRequest) => {
    const cookie = request.cookies?.pos_session;
    if (!cookie) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return createHmac('sha256', config.SESSION_SECRET + ':slack-session-binding')
      .update(cookie)
      .digest('hex');
  };
  const trace = (action: string) => ({
    config: {
      trace: { module: 'administration', resource: 'store-slack-connection', action },
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  });
  const page = (reply: FastifyReply, result: SlackConnectResult, status = 200) =>
    reply
      .code(status)
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${popupScriptHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      )
      .type('text/html; charset=utf-8')
      .send(slackCallbackPage(result));
  /** Errors (sign-in, permission) render in the popup, as the legacy page does. */
  const guarded =
    (run: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await run(request, reply);
      } catch (error) {
        if (error instanceof AppError && error.status < 500)
          return page(
            reply,
            { ok: false, error: error.message, url: null, channel: null, nonce: null },
            error.status,
          );
        throw error;
      }
    };
  app.get(
    '/api/v1/admin/slack/connect',
    {
      ...trace('start'),
      ...routeSchema({ querystring: slackConnectInput, headers: transportHeaders }),
    },
    guarded(async (request, reply) => {
      const outcome = await service.start(
        authenticated(request),
        slackConnectInput.parse(request.query),
        binding(request),
      );
      if ('result' in outcome) return page(reply, outcome.result);
      return reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .redirect(outcome.redirect, 302);
    }),
  );
  app.get(
    '/api/v1/admin/slack/oauth/callback',
    {
      ...trace('complete'),
      ...routeSchema({ querystring: slackCallbackQuery, headers: transportHeaders }),
    },
    guarded(async (request, reply) => {
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      return page(
        reply,
        await service.complete(
          authenticated(request),
          slackCallbackQuery.parse(request.query),
          binding(request),
          controller.signal,
        ),
      );
    }),
  );
}
