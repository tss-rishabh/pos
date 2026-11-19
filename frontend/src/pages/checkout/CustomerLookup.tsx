import { useState } from 'react';
import { z } from 'zod';
import { post } from '../../api/client';
import type { CheckoutReply } from './client';

/** Server reply for legacy `ajax_user_details` (`users/views.py:612-664`). */
export const customerLookupResultSchema = z.object({
  customer: z.object({
    id: z.string(),
    name: z.string(),
    telephone: z.string(),
    email: z.string(),
    customerType: z.string(),
    gstin: z.string(),
  }),
  message: z.string(),
  exclusive: z.object({
    member: z.boolean(),
    expiry: z.string().nullable(),
    message: z.string(),
  }),
  discountEligible: z.boolean(),
});
export type CustomerLookupResult = z.infer<typeof customerLookupResultSchema>;
export const lookupCustomer = (
  storeId: string,
  counterId: string,
  operatorId: string,
  query: { telephone: string; email: string },
) =>
  post(
    `/api/v1/stores/${encodeURIComponent(storeId)}/customer-lookups`,
    { counterId, telephone: query.telephone, email: query.email.trim() },
    z.object({ data: customerLookupResultSchema }),
    operatorId,
  );
/** `create_order.html:2931-2948`: legacy wording and `toLocaleDateString("en-US", …)`. */
export function exclusiveText(result: CustomerLookupResult) {
  return result.exclusive.member
    ? 'Exclusive User Till  ' +
        new Date(result.exclusive.expiry ?? '').toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
    : 'Non Exclusive User';
}
export const cashbackText = (result: CustomerLookupResult) =>
  result.discountEligible ? 'User Is Eligible For Cashback' : 'User is not eligible for cashback';

export interface CustomerLookupProps {
  storeId: string;
  counterId: string;
  operatorId: string;
  connectedCustomerId: string | null;
  disabled: boolean;
  act(task: () => Promise<void>): Promise<void>;
  mutate(
    path: string,
    method: 'POST' | 'PUT',
    body?: Record<string, unknown>,
  ): Promise<CheckoutReply>;
}
/**
 * Legacy "Fetch the User" / "Connect the User" (`create_order.html:553-655`, `:2905-3033`):
 * mobile and email are posted together; a found customer shows name, type, GSTIN, the exclusive
 * membership and cashback eligibility before connecting. "Connect the User" also replaces an
 * already connected customer within the sale (`is_cart_sync = 0`).
 */
export function CustomerLookup({
  storeId,
  counterId,
  operatorId,
  connectedCustomerId,
  disabled,
  act,
  mutate,
}: CustomerLookupProps) {
  const [telephone, setTelephone] = useState(''),
    [email, setEmail] = useState(''),
    [name, setName] = useState(''),
    [result, setResult] = useState<CustomerLookupResult | null>(null),
    [notice, setNotice] = useState('');
  const fetchUser = async () => {
    setNotice('');
    try {
      // An incomplete `9999999999` mask posts `_` and the server ignores it (`users/views.py:620`).
      const found = (
        await lookupCustomer(storeId, counterId, operatorId, {
          telephone: telephone.length === 10 ? telephone : '',
          email,
        })
      ).data;
      setResult(found);
      setName(found.customer.name);
      setTelephone(found.customer.telephone);
      setEmail(found.customer.email);
    } catch (error) {
      setResult(null);
      setName('User Not Selected');
      throw error;
    }
  };
  const connect = async (customerId: string) => {
    await mutate('customer', 'PUT', { customerId });
    setNotice('Cart has been Synced');
  };
  const connectable = result?.customer.id ?? null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void act(fetchUser);
      }}
    >
      <label>
        Name
        <input value={name} disabled readOnly />
      </label>
      <label>
        Mobile
        <input
          value={telephone}
          onChange={(event) => setTelephone(event.target.value.replace(/\D/g, '').slice(0, 10))}
          inputMode="tel"
          maxLength={10}
          placeholder="0123456789"
          autoComplete="off"
        />
      </label>
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          maxLength={254}
          placeholder="abcd@xyz.com"
          autoComplete="off"
        />
      </label>
      {result && (
        <>
          <label>
            Customer Type
            <input value={result.customer.customerType} disabled readOnly />
          </label>
          {result.customer.customerType === 'B2B' && (
            <label>
              GSTIN
              <input value={result.customer.gstin} disabled readOnly />
            </label>
          )}
          <h6 style={result.exclusive.member ? { color: 'red' } : undefined}>
            {exclusiveText(result)}
          </h6>
          {!result.exclusive.member && result.exclusive.message && (
            <small>{result.exclusive.message}</small>
          )}
          <h6 style={result.discountEligible ? { color: 'red' } : undefined}>
            {cashbackText(result)}
          </h6>
        </>
      )}
      <button className="button secondary" disabled={disabled || (!telephone && !email.trim())}>
        Fetch the User
      </button>
      {connectable && connectable !== connectedCustomerId && (
        <button
          type="button"
          className="button primary"
          disabled={disabled}
          onClick={() => void act(() => connect(connectable))}
        >
          Connect the User
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </form>
  );
}
