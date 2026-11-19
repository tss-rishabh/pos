import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { Checkout } from './client';
import {
  emailPattern,
  readContactWorkspace,
  saveEmail,
  type CustomerContactScope,
} from '../customer-contacts/api';

/**
 * Legacy `email_popup()` (`create_order.html:7926-7990`): after a product add that adds an
 * exclusive membership (`extra.exclusive_product`, i.e. `prod_type == 5`, `order/views.py:1732`)
 * while the connected customer's email is a dummy (`"temp.id" in user_obj.email`, `:1710`, `:2275`),
 * ask for the real email. Submit validates the legacy pattern ("Please provide a valid email"),
 * posts `ajax-m-user-email` (here W5's `…/customer-contacts/email`); success shows the message and
 * reloads the sale ("Window reloading..."); failure shows the server message and keeps the popup.
 */
function membershipIds(checkout: Checkout): Set<string> {
  return new Set(
    (checkout.cart?.products.items ?? [])
      .filter((item) => Number(item.prod_type) === 5)
      .map((item) => String(item.prod_id)),
  );
}

export function MembershipEmailPrompt({
  checkout,
  operatorId,
  disabled,
  onSaved,
  onNotice,
}: {
  checkout: Checkout;
  operatorId: string;
  disabled: boolean;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const previous = useRef<{ checkoutId: string; ids: Set<string> } | null>(null),
    [open, setOpen] = useState(false),
    [email, setEmail] = useState(''),
    [problem, setProblem] = useState(''),
    [busy, setBusy] = useState(false);
  const customerId = checkout.customerId;
  const scope: CustomerContactScope | null = customerId
    ? { operatorId, storeId: checkout.storeId, checkoutId: checkout.id, customerId }
    : null;
  useEffect(() => {
    const ids = membershipIds(checkout),
      before = previous.current;
    previous.current = { checkoutId: checkout.id, ids };
    // Only an add shows the popup; a sale that already held the membership does not.
    if (!before || before.checkoutId !== checkout.id || !customerId) return;
    if (![...ids].some((id) => !before.ids.has(id))) return;
    const controller = new AbortController();
    void readContactWorkspace(
      { operatorId, storeId: checkout.storeId, checkoutId: checkout.id, customerId },
      controller.signal,
    )
      .then((workspace) => {
        if (workspace.email.includes('temp.id')) {
          setEmail('');
          setProblem('');
          setOpen(true);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [checkout, customerId, operatorId]);
  if (!open || !scope) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="membership-email-title"
      className="membership-email-prompt"
    >
      <h3 id="membership-email-title">Add User&apos;s Email ID!</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!emailPattern.test(email)) {
            setProblem('Please provide a valid email');
            return;
          }
          setBusy(true);
          setProblem('');
          void saveEmail(scope, email, AbortSignal.timeout(15000))
            .then(async (result) => {
              setOpen(false);
              onNotice(result.message);
              await onSaved();
            })
            .catch((error: unknown) =>
              setProblem(
                error instanceof ApiError || error instanceof Error
                  ? error.message
                  : 'The email was not saved.',
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Exclusive membership added to the cart and we do not have user&apos;s Email Id, requesting
          you to add user&apos;s email ID to map the membership with user&apos;s Email Id otherwise
          membership will be map with dummy Email Id
          <input
            type="email"
            placeholder="Email Address"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={96}
            required
            autoFocus
            disabled={disabled || busy}
          />
        </label>
        {problem && <p role="alert">{problem}</p>}
        <button className="button primary" disabled={disabled || busy}>
          Submit
        </button>
        <button type="button" className="button secondary" onClick={() => setOpen(false)}>
          Close
        </button>
      </form>
    </div>
  );
}
