import { z } from 'zod';

/** Callback carries only an opaque receipt ID; no code, webhook or staff identity. */
export function pendingSlackConnection(search = window.location.search): string | null {
  const result = z.uuid().safeParse(new URLSearchParams(search).get('slackConnection'));
  return result.success ? result.data : null;
}
