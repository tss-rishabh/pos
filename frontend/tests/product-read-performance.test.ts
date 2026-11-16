import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page, Product } from '../src/api/types';

const fixture = vi.hoisted(() => ({
  options: undefined as unknown,
  request: vi.fn(),
  bulkPut: vi.fn(),
  cached: vi.fn(),
}));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useInfiniteQuery: (options: unknown) => {
    fixture.options = options;
    return {};
  },
}));
vi.mock('../src/api/client', async (original) => ({
  ...(await original<typeof import('../src/api/client')>()),
  request: fixture.request,
}));
vi.mock('../src/offline/database', async (original) => ({
  ...(await original<typeof import('../src/offline/database')>()),
  db: {
    catalog: {
      bulkPut: fixture.bulkPut,
      where: () => ({ equals: () => ({ toArray: fixture.cached }) }),
    },
  },
}));

import { ApiError, NetworkError } from '../src/api/client';
import { useProducts } from '../src/hooks/use-pos';

type Query = (context: {
  pageParam: string;
  signal: AbortSignal;
}) => Promise<Page<Product> & { cached: boolean }>;
function query(onRead: (milliseconds: number) => void) {
  useProducts('44', '1', 'shirt', false, onRead);
  return (fixture.options as { queryFn: Query }).queryFn;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const product: Product = {
  id: '9007199254740993',
  name: 'Fixture shirt',
  erpName: '',
  barcode: null,
  parentId: '0',
  type: '1',
  price: '10.00',
  specialPrice: '10.00',
  exclusivePrice: null,
  stock: 3,
  gst: 5,
  image: null,
};
describe('completed product read measurement', () => {
  beforeEach(() => {
    fixture.request.mockReset().mockResolvedValue({ data: [product], nextCursor: null });
    fixture.bulkPut.mockReset().mockResolvedValue(undefined);
    fixture.cached.mockReset().mockResolvedValue([product]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('measures the real query only after its cache write completes, with no extra request', async () => {
    const write = deferred(),
      started = deferred(),
      measured = vi.fn();
    fixture.bulkPut.mockImplementation(async () => {
      started.resolve();
      await write.promise;
    });
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(35.25);
    const pending = query(measured)({ pageParam: '0', signal: new AbortController().signal });
    await started.promise;
    expect(measured).not.toHaveBeenCalled();
    write.resolve();
    expect(await pending).toEqual({ data: [product], nextCursor: null, cached: false });
    expect(measured).toHaveBeenCalledExactlyOnceWith(25.25);
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(fixture.cached).not.toHaveBeenCalled();
  });

  it('measures successful offline IndexedDB reads and preserves the source filtering', async () => {
    fixture.request.mockRejectedValue(new NetworkError());
    fixture.cached.mockResolvedValue([product, { ...product, id: '2', stock: 0 }]);
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(46.5);
    const measured = vi.fn();
    expect(await query(measured)({ pageParam: '0', signal: new AbortController().signal })).toEqual(
      { data: [product], nextCursor: null, cached: true },
    );
    expect(measured).toHaveBeenCalledExactlyOnceWith(36.5);
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });

  it('does not publish failed or cancelled reads', async () => {
    const measured = vi.fn();
    fixture.request.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Denied'));
    await expect(
      query(measured)({ pageParam: '0', signal: new AbortController().signal }),
    ).rejects.toMatchObject({ status: 403 });
    const controller = new AbortController();
    fixture.bulkPut.mockImplementationOnce(async () => {
      controller.abort();
    });
    await query(measured)({ pageParam: '0', signal: controller.signal });
    expect(measured).not.toHaveBeenCalled();
  });

  it('retains the callback captured by the original query and isolates metadata failure', async () => {
    const write = deferred(),
      started = deferred(),
      first = vi.fn(() => {
        throw new Error('Optional metadata failed');
      }),
      replacement = vi.fn();
    fixture.bulkPut.mockImplementationOnce(async () => {
      started.resolve();
      await write.promise;
    });
    const pending = query(first)({ pageParam: '0', signal: new AbortController().signal });
    await started.promise;
    query(replacement);
    write.resolve();
    await expect(pending).resolves.toMatchObject({ data: [product], cached: false });
    expect(first).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });
});
