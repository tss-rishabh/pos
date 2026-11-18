/** Owned official-emulator transport. Successful responses always come from Cloud. */
import { BigQuery } from '@google-cloud/bigquery';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { compileFixtureStatements, equalCapability } from './fixture-sql.js';

const inputSchema = z.object({
  manifestPath: z.string().startsWith('/'),
  keyFilename: z.string().startsWith('/'),
}).strict();
const object = z.record(z.string(), z.unknown());
const resultReference = z.object({
  jobReference: z.object({ projectId: z.literal('tssgcp2025'), jobId: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/) }).optional(),
}).passthrough();
const metadata = z.object({ statistics: z.object({ query: z.object({
  statementType: z.literal('SELECT'), totalBytesProcessed: z.string().regex(/^\d+$/),
}) }) }).passthrough();

async function main() {
  // This process must never inherit the backend child's emulator endpoint.
  if (process.env.BIGQUERY_EMULATOR_HOST || !process.send) throw new Error('PRIVATE_PROXY_PROCESS_REQUIRED');
  let input = '';
  for await (const value of process.stdin) { input += String(value); if (input.length > 4096) throw new Error('INVALID_PROXY_INPUT'); }
  const settings = inputSchema.parse(JSON.parse(input) as unknown);
  const fixture = compileFixtureStatements(JSON.parse(await readFile(settings.manifestPath, 'utf8')) as unknown);
  const { project, location, maximumBytesBilled, maximumRequests } = fixture.manifest;
  const cloud = new BigQuery({ projectId: project, location, keyFilename: settings.keyFilename,
    apiEndpoint: 'https://bigquery.googleapis.com' });
  const capability = randomBytes(32).toString('hex');
  const acceptedJobs = new Set<string>();
  const counts = { queryAdmissionDryRuns: 0, estimatorDryRuns: 0, queries: 0, jobReads: 0, denied: 0 };
  let requestCount = 0;
  // Official SDK GoogleAuth request transport preserves raw API response shaping.
  // Only this process holds Cloud credentials; no incoming auth header is reused.
  const send = async (method: 'GET' | 'POST', path: string, data?: unknown) =>
    cloud.authClient.request<unknown>({ method, url: 'https://bigquery.googleapis.com' + path,
      ...(data === undefined ? {} : { data }), timeout: 10000 });
  function prepare(body: unknown, kind: 'jobs' | 'queries') {
    const document = object.parse(body), config = kind === 'jobs' ? object.parse(document.configuration) : document;
    const query = kind === 'jobs' ? object.parse(config.query) : config;
    if (query.useLegacySql !== false || BigInt(z.string().regex(/^\d+$/).parse(query.maximumBytesBilled)) !== BigInt(maximumBytesBilled))
      throw new Error('INVALID_SYNTHETIC_QUERY_BUDGET');
    const deadline = Number(kind === 'jobs' ? config.jobTimeoutMs : query.jobTimeoutMs ?? query.timeoutMs);
    if (!Number.isInteger(deadline) || deadline < 1 || deadline > 10000) throw new Error('INVALID_SYNTHETIC_QUERY_DEADLINE');
    if (query.destinationTable || config.load || config.copy || config.extract || query.allowLargeResults || query.connectionProperties)
      throw new Error('QUERY_SIDE_EFFECT_FORBIDDEN');
    const labels = object.parse(kind === 'jobs' ? config.labels : query.labels);
    if (labels.application !== 'pos-rewrite' || !['order-search', 'order-history', 'public-order-history'].includes(String(labels.resource)))
      throw new Error('UNEXPECTED_SYNTHETIC_RESOURCE');
    const rewritten = fixture.rewrite(z.string().parse(query.query));
    const preparedQuery = { ...query, query: rewritten };
    return { document, config, query: preparedQuery,
      body: kind === 'jobs' ? { ...document, configuration: { ...config, query: preparedQuery } } : preparedQuery,
      dryRun: (kind === 'jobs' ? config.dryRun : query.dryRun) === true };
  }
  const server = createServer(async (incoming, outgoing) => {
    const fail = (status = 403) => { counts.denied++; outgoing.writeHead(status, { 'content-type': 'application/json' }); outgoing.end('{"error":{"code":"OWNED_QUERY_REFUSED"}}'); };
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(incoming.socket.remoteAddress ?? '')) return fail();
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const match = /^\/owned\/([a-f0-9]{64})(\/bigquery\/v2\/projects\/tssgcp2025\/(jobs|queries)(?:\/([A-Za-z0-9_-]{1,1024}))?)$/.exec(url.pathname);
      if (!match || !equalCapability(match[1]!, capability) || ++requestCount > maximumRequests) return fail();
      const path = match[2]! + url.search, kind = match[3] as 'jobs' | 'queries', job = match[4];
      if ([...url.searchParams.keys()].some(key => !['location', 'maxResults', 'pageToken', 'timeoutMs', 'prettyPrint'].includes(key)) ||
        (url.searchParams.has('location') && url.searchParams.get('location') !== location)) return fail();
      if (incoming.method === 'GET') {
        if (!job || !acceptedJobs.has(job)) return fail();
        counts.jobReads++;
        const response = await send('GET', path);
        outgoing.writeHead(response.status, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(response.data)); return;
      }
      if (incoming.method !== 'POST' || job || url.search) return fail();
      let text = '';
      for await (const chunk of incoming) { text += String(chunk); if (Buffer.byteLength(text) > 2_000_000) return fail(413); }
      const prepared = prepare(JSON.parse(text) as unknown, kind);
      if (!prepared.dryRun) {
        // Re-establish actual Cloud SELECT/byte classification before execution,
        // even though the production estimator has already sent its own dry run.
        const admission = await send('POST', `/bigquery/v2/projects/${project}/jobs`, {
          configuration: { query: prepared.query, dryRun: true, jobTimeoutMs: '10000', labels: { application: 'pos-rewrite', resource: 'order-search' } },
          jobReference: { projectId: project, location },
        });
        const checked = metadata.parse(admission.data);
        if (BigInt(checked.statistics.query.totalBytesProcessed) > BigInt(maximumBytesBilled)) return fail();
        counts.queryAdmissionDryRuns++;
      }
      const response = await send('POST', path, prepared.body);
      if (prepared.dryRun) {
        const checked = metadata.parse(response.data);
        if (BigInt(checked.statistics.query.totalBytesProcessed) > BigInt(maximumBytesBilled)) return fail();
        counts.estimatorDryRuns++;
      } else counts.queries++;
      const reference = resultReference.parse(response.data).jobReference;
      if (reference) acceptedJobs.add(reference.jobId);
      outgoing.writeHead(response.status, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(response.data));
    } catch (error: unknown) {
      // Relay an actual Cloud API failure body only for the fixed BigQuery origin.
      const cloudFailure = z.object({ response: z.object({ status: z.number().int().min(400).max(599), data: z.unknown(), config: z.object({ url: z.string().startsWith('https://bigquery.googleapis.com/bigquery/v2/') }) }) }).safeParse(error);
      if (cloudFailure.success) { outgoing.writeHead(cloudFailure.data.response.status, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(cloudFailure.data.response.data)); }
      else fail(503);
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('PRIVATE_PROXY_UNAVAILABLE');
  process.send!({ type: 'owned-bigquery-ready', endpoint: `http://127.0.0.1:${address.port}/owned/${capability}/bigquery/v2` });
  process.on('message', (message: unknown) => {
    if (!z.object({ type: z.literal('stop') }).strict().safeParse(message).success) return;
    server.closeAllConnections(); server.close(() => { process.send?.({ type: 'owned-bigquery-stopped', counts }); process.disconnect?.(); });
  });
}
main().catch(() => { process.stderr.write('OWNED_BIGQUERY_PROXY_UNAVAILABLE\n'); process.exitCode = 1; });
