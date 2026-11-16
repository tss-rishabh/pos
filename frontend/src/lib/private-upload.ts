import { z } from 'zod';

export const privateUploadSchema = z.object({
  url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (import.meta.env.DEV &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname)))
    );
  }),
  fields: z.record(z.string(), z.string()),
});
export async function fileChecksum(file: File, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  signal.throwIfAborted();
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
/** Signed form fields carry authorization; browser cookies never go to object storage. */
export async function uploadPrivateFile(
  file: File,
  target: z.infer<typeof privateUploadSchema>,
  signal: AbortSignal,
  timeoutMs = 600000,
): Promise<void> {
  const parsed = privateUploadSchema.safeParse(target);
  if (!parsed.success) throw new Error('The upload destination is unavailable.');
  const form = new FormData();
  for (const [name, value] of Object.entries(parsed.data.fields)) form.append(name, value);
  form.append('file', file, file.name);
  try {
    const response = await fetch(parsed.data.url, {
      method: 'POST',
      body: form,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Upload was not accepted.');
  } catch {
    throw new Error('File upload could not finish. Try again.');
  }
}
