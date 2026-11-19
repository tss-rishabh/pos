import { useEffect, useRef, useState } from 'react';
import type { Principal } from '../../api/types';
import { captureOperatorScope } from '../../api/client';
import { RequestReference, useProblem } from '../../components/common';
import { issueWebsiteHandoff, websiteHandoffUrl } from './api';
import './style.css';

export interface CustomerWebsiteHandoffProps {
  user: Principal;
  storeId: string;
  checkoutId: string;
  /** Kept for the checkout caller; a new version resets the action. */
  checkoutVersion: number;
  online: boolean;
  disabled?: boolean;
  /** Parent supplies its approved external opener, including the desktop origin policy. */
  onOpen: (url: string) => void | Promise<void>;
}
/**
 * Legacy "Looking to place an online order? Place order now!" (`create_order.html:657-661`,
 * `:4783-4795`): opens the website signed in as the verified customer.
 */
export function CustomerWebsiteHandoffAction(props: CustomerWebsiteHandoffProps) {
  const { user, storeId, checkoutId, checkoutVersion, online, disabled = false, onOpen } = props;
  const controller = useRef(new AbortController());
  const [busy, setBusy] = useState(false),
    [message, setMessage, messageCause, reportMessage] = useProblem(),
    [minutes, setMinutes] = useState<number | null>(null);
  useEffect(() => {
    controller.current.abort();
    controller.current = new AbortController();
    setBusy(false);
    setMessage('');
    return () => controller.current.abort();
  }, [user.id, storeId, checkoutId, checkoutVersion]);
  async function placeOrder() {
    if (disabled || !online || busy) return;
    setBusy(true);
    setMessage('');
    const signal = AbortSignal.any([captureOperatorScope(user.id), controller.current.signal]);
    try {
      const result = await issueWebsiteHandoff(user.id, storeId, checkoutId, signal);
      signal.throwIfAborted();
      setMinutes(result.sessionMinutes);
      await onOpen(websiteHandoffUrl(result.webUrl));
    } catch (error) {
      if (signal.aborted) return;
      reportMessage(error, 'Could not open the customer website. Try again.', { apiOnly: true });
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Customer website order" className="customer-website-order">
      <div className="customer-website-order-row">
        <span>Looking to place an online order?</span>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || !online || busy}
          aria-busy={busy}
          onClick={() => void placeOrder()}
        >
          Place order now!
        </button>
      </div>
      <small className="caption">
        It will redirect to the website with the customer&apos;s login
        {minutes !== null
          ? `, and the session will remain active for only ${minutes} minutes.`
          : '.'}
      </small>
      {message && <p role="status">{message}</p>}
      {message && <RequestReference error={messageCause} />}
    </section>
  );
}
