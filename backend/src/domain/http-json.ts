import { AppError } from './errors.js';

/** Streaming bound applies even when Content-Length is absent or incorrect. */
export async function boundedText(response: Response, maxBytes = 2_000_000): Promise<string> {
  if (!response.body)
    throw new AppError(
      502,
      'INVALID_UPSTREAM_RESPONSE',
      'The upstream service returned an empty response.',
    );
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError(502, 'INVALID_UPSTREAM_RESPONSE', 'The upstream response is too large.');
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(joined);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      'INVALID_UPSTREAM_RESPONSE',
      'The upstream service returned an invalid response.',
    );
  } finally {
    reader.releaseLock();
  }
}
export async function boundedJson(response: Response, maxBytes = 2_000_000): Promise<unknown> {
  const value = await boundedText(response, maxBytes);
  const revive = (_key: string, item: unknown, context?: { source?: string }): unknown =>
    typeof item === 'number' &&
    Number.isInteger(item) &&
    !Number.isSafeInteger(item) &&
    context?.source
      ? context.source
      : item;
  try {
    return JSON.parse(value, revive) as unknown;
  } catch {
    throw new AppError(
      502,
      'INVALID_UPSTREAM_RESPONSE',
      'The upstream service returned an invalid response.',
    );
  }
}
