import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import { downloadReportCsv } from '../../src/pages/finance/download';
describe('operator-bound private CSV downloads', () => {
  const anchor = { href: '', download: '', click: vi.fn() };
  beforeEach(() => {
    setRequestOperator('1');
    anchor.click.mockClear();
    vi.stubGlobal('document', { createElement: () => anchor });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    setRequestOperator(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('uses captured actor and scoped transport and permits only bounded CSV files', async () => {
    const fetch = vi.fn(
      async (_path: string, _options: RequestInit) =>
        new Response('a,b\r\n1,2', { headers: { 'Content-Type': 'text/csv' } }),
    );
    vi.stubGlobal('fetch', fetch);
    await downloadReportCsv(
      '/api/v1/report-exports/12345678-1234-1234-1234-123456789abc/file',
      'unsafe/name\n.csv',
      '1',
    );
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe('unsafe-name-.csv');
    const options = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(options?.headers).get('X-Operator-ID')).toBe('1');
    expect(options).toMatchObject({ credentials: 'include', redirect: 'error' });
    await expect(downloadReportCsv('https://invalid.test/private', 'x.csv', '1')).rejects.toThrow(
      'Invalid report download path',
    );
  });
  it('discards a file whose owner changes while its body is being consumed', async () => {
    let release: (() => void) | undefined;
    const reading = vi.fn(),
      body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reading();
            return new Promise<void>((resolve) => {
              release = () => {
                controller.enqueue(new TextEncoder().encode('a,b\r\n1,2'));
                controller.close();
                resolve();
              };
            });
          },
        },
        { highWaterMark: 0 },
      ),
      response = new Response(body, { headers: { 'Content-Type': 'text/csv' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const pending = downloadReportCsv(
      '/api/v1/report-exports/12345678-1234-1234-1234-123456789abc/file',
      'x.csv',
      '1',
    );
    await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
    setRequestOperator('2');
    release?.();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(anchor.click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
