import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { InvoiceDocumentAction } from './document';
import { currentInvoiceSession, invoiceActorSignal, invoiceIdentity } from './session';

const identifier = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const capability = z
  .object({
    storeId: identifier,
    orderId: identifier,
    actions: z
      .array(
        z
          .object({ kind: z.enum(['online', 'same-day', 'express']), available: z.boolean() })
          .strict(),
      )
      .max(3),
  })
  .strict();
export function OrderInvoiceActions({
  user,
  storeId,
  orderId,
  online,
}: {
  user: Principal;
  storeId: string;
  orderId: string;
  online: boolean;
}) {
  const scope = [invoiceIdentity(user), storeId, orderId].join(':'),
    [loaded, setLoaded] = useState<{ scope: string; value: z.infer<typeof capability> } | null>(
      null,
    ),
    [failed, setFailed] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        if (!online) return;
        const signal = invoiceActorSignal(user, controller.signal);
        await currentInvoiceSession(user, storeId, signal);
        const value = await request(
          `/api/v1/stores/${identifier.parse(storeId)}/orders/${identifier.parse(orderId)}/invoices/capabilities`,
          { operatorId: user.id, signal, cache: 'no-store' },
          capability,
        );
        await currentInvoiceSession(user, storeId, signal);
        signal.throwIfAborted();
        if (
          value.storeId !== storeId ||
          value.orderId !== orderId ||
          new Set(value.actions.map((action) => action.kind)).size !== value.actions.length
        )
          throw new Error('Invoice scope changed.');
        setLoaded({ scope, value });
        setFailed(null);
      } catch {
        if (!controller.signal.aborted) setFailed(scope);
      }
    }
    void load();
    return () => controller.abort();
  }, [scope, online, retry]);
  if (!online) return null;
  if (failed === scope)
    return (
      <button className="button secondary" onClick={() => setRetry((value) => value + 1)}>
        Retry invoice options
      </button>
    );
  if (loaded?.scope !== scope) return null;
  return (
    <>
      {loaded.value.actions.map((action) => (
        <InvoiceDocumentAction
          key={scope + ':' + action.kind}
          user={user}
          storeId={storeId}
          orderId={orderId}
          kind={action.kind}
          online={online}
          available={action.available}
        />
      ))}
    </>
  );
}
