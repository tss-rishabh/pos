import { useEffect, useState } from 'react';
import { db } from '../../offline/database';
import type { ScanScope } from './barcode';

export function parseDraftQuantity(value: string): number {
  if (!/^\d{1,3}$/.test(value) || BigInt(value) > 999n)
    throw new Error('Enter a whole quantity from 0 to 999.');
  return Number(value);
}
export async function commitDraftQuantity(
  scope: ScanScope,
  productId: string,
  quantity: number,
  signal: AbortSignal,
  isCurrent: () => boolean,
) {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999)
    throw new Error('Enter a whole quantity from 0 to 999.');
  const check = () => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new DOMException('The active sale changed.', 'AbortError');
  };
  check();
  await db.transaction('rw', db.drafts, async () => {
    const draft = await db.drafts.get([scope.ownerId, scope.draftId]);
    check();
    if (!draft || draft.storeId !== scope.storeId || draft.counterId !== scope.counterId)
      throw new DOMException('The active sale changed.', 'AbortError');
    if (!draft.lines.some((line) => line.productId === productId)) return;
    await db.drafts.put({
      ...draft,
      updatedAt: Date.now(),
      lines:
        quantity === 0
          ? draft.lines.filter((line) => line.productId !== productId)
          : draft.lines.map((line) =>
              line.productId === productId ? { ...line, quantity } : line,
            ),
    });
    check();
  });
}
export function DraftQuantity({
  name,
  quantity,
  onCommit,
}: {
  name: string;
  quantity: number;
  onCommit: (quantity: number) => Promise<void>;
}) {
  const [value, setValue] = useState(String(quantity)),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  useEffect(() => {
    setValue(String(quantity));
    setError('');
  }, [quantity]);
  async function commit() {
    if (pending) return;
    if (value === '') {
      setValue(String(quantity));
      setError('');
      return;
    }
    try {
      const next = parseDraftQuantity(value);
      if (next === quantity) {
        setValue(String(quantity));
        setError('');
        return;
      }
      setPending(true);
      await onCommit(next);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update quantity.');
    } finally {
      setPending(false);
    }
  }
  return (
    <span className="counter-quantity-input">
      <input
        aria-label={`Quantity ${name}`}
        inputMode="numeric"
        value={value}
        disabled={pending}
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          setValue(event.target.value);
          setError('');
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
    </span>
  );
}
