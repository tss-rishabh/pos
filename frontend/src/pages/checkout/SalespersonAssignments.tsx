import { useInfiniteQuery } from '@tanstack/react-query';
import type { Checkout, CheckoutReply } from './client';
import { checkoutSalespersonLines, readCheckoutSalespeople } from './salespeople';

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
    <label key={productId ?? 'master'}>
      {label}
      <select
        data-cashier-action={productId ? undefined : 'salesperson'}
        aria-keyshortcuts={productId ? undefined : 'S'}
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
    <details>
      <summary>Salesperson assignments</summary>
      <p className="caption">
        Choosing the sale salesperson sets every product to that salesperson; a product can then be
        changed on its own. Every product needs a salesperson before the order is created.
      </p>
      {directory.isPending && <p role="status">Loading store salespeople…</p>}
      {directory.error && <p role="alert">{directory.error.message}</p>}
      {select('Sale salesperson', checkout.salespersonId)}
      {lines.map((line) =>
        select(
          `Salesperson for ${line.name}`,
          checkout.lineSalespersons?.[line.id] ?? checkout.salespersonId,
          line.id,
        ),
      )}
      {directory.hasNextPage && (
        <button
          className="button secondary"
          disabled={disabled || directory.isFetchingNextPage}
          onClick={() => void directory.fetchNextPage()}
        >
          Load more salespeople
        </button>
      )}
      <button
        className="button secondary"
        disabled={disabled || directory.isFetching}
        onClick={() => void directory.refetch()}
      >
        Refresh store salespeople
      </button>
      {!directory.isPending && !directory.error && people.length === 0 && (
        <p>No active salespeople are assigned to this store.</p>
      )}
    </details>
  );
}
