import { useInfiniteQuery } from '@tanstack/react-query';
import type { Checkout, CheckoutReply } from './client';
import { checkoutSalespersonLines, readCheckoutSalespeople } from './salespeople';
import { Loader } from '../../components/loader';

export function SalespersonAssignments({
  checkout,
  operatorId,
  disabled,
  act,
  mutate,
}: {
  checkout: Checkout;
  operatorId: string;
  disabled: boolean;
  act: (task: () => Promise<void>) => Promise<void>;
  mutate: (
    path: string,
    method: 'POST' | 'PUT',
    body?: Record<string, unknown>,
  ) => Promise<CheckoutReply>;
}) {
  const directory = useInfiniteQuery({
    queryKey: ['checkout-salespeople', operatorId, checkout.storeId],
    initialPageParam: '0',
    queryFn: ({ pageParam, signal }) =>
      readCheckoutSalespeople(checkout, operatorId, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    retry: false,
  });
  const people = [
    ...new Map(
      directory.data?.pages.flatMap((page) => page.data).map((person) => [person.id, person]),
    ).values(),
  ];
  const select = (label: string, selected: string | null | undefined, productId?: string) => (
    <label key={productId ?? 'master'} title={label}>
      <span className="truncate">{label}</span>
      <select
        aria-label={label}
        disabled={disabled || directory.isPending || Boolean(directory.error)}
        value={selected ?? '0'}
        onChange={(event) => {
          const salespersonId = event.target.value;
          void act(async () => {
            await mutate('salesperson', 'PUT', {
              salespersonId,
              ...(productId ? { productId } : {}),
            });
          });
        }}
      >
        {/* Legacy "Not Selected" (value 0) removes the assignment (order/views.py:2969-3019). */}
        <option value="0">Not Selected</option>
        {selected && selected !== '0' && !people.some((person) => person.id === selected) && (
          <option value={selected}>Saved salesperson {selected}</option>
        )}
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
    </label>
  );
  let lines: ReturnType<typeof checkoutSalespersonLines>;
  try {
    lines = checkoutSalespersonLines(checkout);
  } catch {
    return <p role="alert">The product assignments could not be verified. Reload this sale.</p>;
  }
  return (
    <section className="checkout-section" aria-labelledby="checkout-salesperson-title">
      <h3 id="checkout-salesperson-title">Salesperson assignments</h3>
      <p className="caption">
        Choosing the sale salesperson sets every product to that salesperson; a product can then be
        changed on its own. Every product needs a salesperson before the order is created.
      </p>
      {directory.isPending && <Loader inline label="Loading store salespeople…" />}
      {directory.error && <p role="alert">{directory.error.message}</p>}
      <div className="form-grid checkout-salespeople">
        {select('Sale salesperson', checkout.salespersonId)}
        {lines.map((line) =>
          select(
            `Salesperson for ${line.name}`,
            checkout.lineSalespersons?.[line.id] ?? checkout.salespersonId,
            line.id,
          ),
        )}
      </div>
      <div className="toolbar">
        {directory.hasNextPage && (
          <button
            type="button"
            className="button secondary small"
            disabled={disabled || directory.isFetchingNextPage}
            aria-busy={directory.isFetchingNextPage}
            onClick={() => void directory.fetchNextPage()}
          >
            Load more salespeople
          </button>
        )}
        <button
          type="button"
          className="button secondary small"
          disabled={disabled || directory.isFetching}
          aria-busy={directory.isFetching && !directory.isPending}
          onClick={() => void directory.refetch()}
        >
          Refresh store salespeople
        </button>
      </div>
      {!directory.isPending && !directory.error && people.length === 0 && (
        <p>No active salespeople are assigned to this store.</p>
      )}
    </section>
  );
}
