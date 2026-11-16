import { afterEach, expect, it, vi } from 'vitest';
import { fileChecksum, uploadPrivateFile } from '../src/lib/private-upload';

afterEach(() => vi.unstubAllGlobals());
it('omits browser credentials and blocks redirects while sending signed upload fields', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', send);
  const file = new File(['fixture'], 'fixture.png', { type: 'image/png' });
  await uploadPrivateFile(
    file,
    {
      url: 'https://upload.example.test/',
      fields: { key: 'fixture', policy: 'private-fixture-token' },
    },
    new AbortController().signal,
  );
  const options = send.mock.calls[0]![1]!;
  expect(options.credentials).toBe('omit');
  expect(options.redirect).toBe('error');
  expect(options.body).toBeInstanceOf(FormData);
  expect((options.body as FormData).get('file')).toBeInstanceOf(File);
  expect(await fileChecksum(file, new AbortController().signal)).toBe(
    '8W0F7GspJI0sYa2x6SY/eOT3us4blVAUotF4cs/kBk0=',
  );
});
it('rejects unsafe upload destinations and hides transport error details', async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error('fixture-private-token@example.test'));
  vi.stubGlobal('fetch', send);
  const file = new File(['fixture'], 'fixture.png');
  await expect(
    uploadPrivateFile(
      file,
      { url: 'http://remote.example.test/', fields: {} },
      new AbortController().signal,
    ),
  ).rejects.toThrow('upload destination');
  expect(send).not.toHaveBeenCalled();
  await expect(
    uploadPrivateFile(
      file,
      { url: 'https://upload.example.test/', fields: {} },
      new AbortController().signal,
    ),
  ).rejects.toThrow('File upload could not finish. Try again.');
});
