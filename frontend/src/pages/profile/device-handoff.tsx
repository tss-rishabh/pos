import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { X } from 'lucide-react';
import { request } from '../../api/client';
import '../administration/styles.css';

const base = '/api/v1/operators/current/device-handoffs';
const codeSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  serverNow: z.number().positive().safe(),
  expiresAt: z.number().positive().safe(),
  qrDataUrl: z
    .string()
    .max(256000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
});
type Code = z.infer<typeof codeSchema>;
export function DeviceHandoffButton({ ownerId, online }: { ownerId: string; online: boolean }) {
  const [open, setOpen] = useState(false),
    capabilities = useQuery({
      queryKey: [ownerId, 'device-handoff-capabilities'],
      enabled: online,
      retry: false,
      staleTime: 60000,
      queryFn: () => request(base + '/capabilities', {}, z.object({ available: z.boolean() })),
    });
  if (!capabilities.data?.available) return null;
  return (
    <>
      <button className="button secondary" disabled={!online} onClick={() => setOpen(true)}>
        Device sign-in
      </button>
      {open && (
        <DeviceHandoffDialog operatorId={ownerId} online={online} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
/** Codes and PNG credentials exist only while this dialog is mounted. */
function DeviceHandoffDialog({
  online,
  onClose,
  operatorId,
}: {
  online: boolean;
  onClose: () => void;
  operatorId: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    active = useRef<AbortController | null>(null),
    offset = useRef(0),
    [code, setCode] = useState<Code | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [clock, setClock] = useState(Date.now());
  async function issue() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setCode(null);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await request(
        base,
        {
          method: 'POST',
          operatorId,
          body: JSON.stringify({}),
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        },
        codeSchema,
      );
      if (controller.signal.aborted) return;
      offset.current = result.serverNow - Date.now();
      setClock(Date.now());
      setCode(result);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : 'The device code could not be loaded.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    dialog.current?.showModal();
    void issue();
    const timer = setInterval(() => setClock(Date.now()), 250),
      element = dialog.current;
    return () => {
      clearInterval(timer);
      active.current?.abort();
      element?.close();
    };
  }, []);
  useEffect(() => {
    if (!online) {
      active.current?.abort();
      setCode(null);
      setBusy(false);
    }
  }, [online]);
  async function revoke() {
    if (!code) return;
    const revision = code.revision,
      controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setCode(null);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await request(
        base + '/current',
        {
          method: 'DELETE',
          operatorId,
          body: JSON.stringify({ revision }),
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        },
        z.object({ status: z.literal('revoked') }),
      );
      if (!controller.signal.aborted) setMessage('Code revoked.');
    } catch {
      if (!controller.signal.aborted)
        setError('Revocation could not be confirmed. Refresh to review the current code.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const remaining = Math.max(
    0,
    Math.ceil(((code?.expiresAt || 0) - (clock + offset.current)) / 1000),
  );
  return (
    <dialog
      ref={dialog}
      className="administration-dialog"
      aria-labelledby="device-handoff-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="administration-dialog-heading">
        <div>
          <div className="eyebrow">ACCOUNT ACCESS</div>
          <h2 id="device-handoff-title">Device sign-in</h2>
        </div>
        <button className="icon-button" aria-label="Close device sign-in" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <p>Scan this code from your connected POS application. Each code authorizes one sign-in.</p>
      {!online && <p role="status">Reconnect to generate a device code.</p>}
      {busy && <p role="status">Confirming device code…</p>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {code && remaining > 0 && (
        <div className="profile-device-code">
          <img src={code.qrDataUrl} alt="Device sign-in QR code" />
          <strong aria-label="Device sign-in code">{code.code}</strong>
          <p role="timer">Expires in {remaining} seconds</p>
        </div>
      )}
      {code && remaining === 0 && (
        <p role="status">This code expired. Refresh to generate another.</p>
      )}
      <div className="administration-dialog-actions">
        <button
          className="button secondary"
          disabled={!online || busy}
          onClick={() => void issue()}
        >
          Refresh code
        </button>
        <button
          className="button secondary"
          disabled={!online || busy || !code}
          onClick={() => void revoke()}
        >
          Revoke code
        </button>
        <button className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}
