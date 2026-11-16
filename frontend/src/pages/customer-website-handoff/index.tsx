import { useEffect, useRef, useState } from 'react';
import type { Principal } from '../../api/types';
import { captureOperatorScope } from '../../api/client';
import {
  issueWebsiteHandoff,
  revokeWebsiteHandoff,
  websiteCapabilities,
  websiteHandoffUrl,
  type WebsiteGrant,
} from './api';

export interface CustomerWebsiteHandoffProps {
  user: Principal;
  storeId: string;
  checkoutId: string;
  checkoutVersion: number;
  online: boolean;
  disabled?: boolean;
  /** Parent supplies its approved external opener, including the desktop origin policy. */
  onOpen: (url: string) => void | Promise<void>;
}
export function CustomerWebsiteHandoffAction(props: CustomerWebsiteHandoffProps) {
  const { user, storeId, checkoutId, checkoutVersion, online, disabled = false, onOpen } = props;
  const scope = JSON.stringify([
    user.id,
    user.role,
    user.userType,
    [...user.storeIds].sort(),
    storeId,
    checkoutId,
    checkoutVersion,
    disabled,
  ]);
  const current = useRef(scope);
  current.current = scope;
  const controller = useRef(new AbortController());
  const intent = useRef<string | null>(null);
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [prepared, setPrepared] = useState<{
    grant: WebsiteGrant;
    origin: string;
    deadline: number;
  } | null>(null);
  useEffect(() => {
    controller.current.abort();
    controller.current = new AbortController();
    intent.current = null;
    setConsent(false);
    setBusy(false);
    setMessage('');
    setPrepared(null);
    return () => controller.current.abort();
  }, [scope]);
  useEffect(() => {
    if (!prepared) return;
    const timer = setTimeout(
      () => {
        setPrepared(null);
        intent.current = null;
        setMessage('This website link expired. Prepare a new link.');
      },
      Math.max(0, prepared.deadline - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [prepared]);
  function operationScope() {
    const signal = AbortSignal.any([captureOperatorScope(user.id), controller.current.signal]);
    const assert = () => {
      signal.throwIfAborted();
      if (current.current !== scope)
        throw new DOMException('The current sale changed.', 'AbortError');
    };
    assert();
    return { signal, assert };
  }
  async function prepare() {
    if (disabled || !online || !consent || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const { signal, assert } = operationScope();
      const capabilities = await websiteCapabilities(user.id, storeId, checkoutId, signal);
      assert();
      if (!capabilities.available || !capabilities.receiverOrigin) {
        setMessage('Customer website sign-in is not available.');
        return;
      }
      if (capabilities.requiresVerification) {
        setMessage('Verify the current customer before opening their website account.');
        return;
      }
      if (capabilities.checkoutVersion !== checkoutVersion) {
        setMessage('This sale changed. Refresh it before continuing.');
        return;
      }
      intent.current ??= crypto.randomUUID();
      const grant = await issueWebsiteHandoff(
        user.id,
        storeId,
        checkoutId,
        checkoutVersion,
        intent.current,
        signal,
      );
      assert();
      websiteHandoffUrl(grant.url, capabilities.receiverOrigin);
      setPrepared({
        grant,
        origin: capabilities.receiverOrigin,
        deadline: performance.now() + grant.expiresAt - grant.serverNow,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (current.current === scope)
        setMessage('Could not prepare the website link. Retry this action.');
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  async function open() {
    if (disabled || !online || !prepared || busy || prepared.deadline <= performance.now()) return;
    try {
      const { assert } = operationScope();
      assert();
      await onOpen(websiteHandoffUrl(prepared.grant.url, prepared.origin));
      assert();
      setMessage('Website sign-in opened. The link works once and expires shortly.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (current.current === scope)
        setMessage('The customer website could not be opened. Try again before this link expires.');
    }
  }
  async function revoke() {
    if (disabled || !online || !prepared || busy) return;
    setBusy(true);
    try {
      const { signal, assert } = operationScope();
      await revokeWebsiteHandoff(user.id, storeId, checkoutId, prepared.grant.id, signal);
      assert();
      setPrepared(null);
      intent.current = null;
      setMessage('The unused website link was cancelled.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (current.current === scope)
        setMessage('Could not cancel the link. It will expire shortly.');
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  return (
    <section aria-label="Customer website sign-in">
      <label>
        <input
          type="checkbox"
          checked={consent}
          disabled={disabled || !online || busy || Boolean(prepared)}
          onChange={(event) => setConsent(event.currentTarget.checked)}
        />{' '}
        The verified customer agrees to open their website account on this device.
      </label>
      {!prepared ? (
        <button
          type="button"
          className="button secondary"
          disabled={disabled || !online || !consent || busy}
          onClick={() => void prepare()}
        >
          {busy ? 'Preparing website…' : 'Prepare customer website'}
        </button>
      ) : (
        <>
          <button
            type="button"
            className="button secondary"
            disabled={disabled || !online || busy}
            onClick={() => void open()}
          >
            Open customer website
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={disabled || !online || busy}
            onClick={() => void revoke()}
          >
            Cancel website link
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
