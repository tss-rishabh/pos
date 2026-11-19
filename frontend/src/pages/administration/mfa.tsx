import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { X } from 'lucide-react';
import { request } from '../../api/client';
import { RequestReference, useProblem } from '../../components/common';
import './styles.css';

const settingsSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  canReplace: z.boolean(),
});
const enrollmentSchema = z.object({
  id: z.uuid(),
  expiresAt: z.iso.datetime(),
  qrDataUrl: z
    .string()
    .max(256000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
});
const successSchema = z.object({ status: z.literal('success'), message: z.string() });
type MfaSettings = z.infer<typeof settingsSchema>;
type Enrollment = z.infer<typeof enrollmentSchema>;

/** Authenticator secrets remain in this mounted dialog only; never in persisted/query state. */
export function OperatorMfaButton({
  operatorId,
  operatorName,
  self = false,
  onChanged,
  actorId,
}: {
  operatorId: string;
  operatorName: string;
  self?: boolean;
  onChanged?: (credentialsChanged?: boolean) => Promise<unknown> | void;
  actorId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="button secondary" onClick={() => setOpen(true)}>
        Authenticator
      </button>
      {open && (
        <OperatorMfaDialog
          key={operatorId}
          operatorId={operatorId}
          operatorName={operatorName}
          self={self}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
          actorId={actorId}
        />
      )}
    </>
  );
}

function OperatorMfaDialog({
  operatorId,
  operatorName,
  self,
  onClose,
  onChanged,
  actorId,
}: {
  operatorId: string;
  operatorName: string;
  self: boolean;
  onClose: () => void;
  onChanged?: (credentialsChanged?: boolean) => Promise<unknown> | void;
  actorId?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    lifecycle = useRef<AbortController | null>(null),
    startId = useRef(crypto.randomUUID()),
    controlId = useRef(crypto.randomUUID());
  const [settings, setSettings] = useState<MfaSettings | null>(null),
    [enrollment, setEnrollment] = useState<Enrollment | null>(null),
    [code, setCode] = useState(''),
    [secret, setSecret] = useState(''),
    [mode, setMode] = useState<'disable' | 'replace'>('disable'),
    [busy, setBusy] = useState(true),
    [error, setError, errorCause, reportError] = useProblem(),
    [message, setMessage] = useState('');
  const path = `/api/v1/admin/operators/${encodeURIComponent(operatorId)}`;
  const signal = () => {
    const controller = lifecycle.current;
    if (!controller) throw new Error('Authenticator editor is closed.');
    return AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
  };
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    const element = dialog.current;
    element?.showModal();
    void request(
      `${path}/mfa`,
      {
        operatorId: actorId,
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      },
      settingsSchema,
    )
      .then((value) => {
        if (!controller.signal.aborted) setSettings(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          reportError(failure, 'Authenticator settings could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      lifecycle.current = null;
      element?.close();
    };
  }, [path]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (failure) {
      if (lifecycle.current && !lifecycle.current.signal.aborted)
        reportError(failure, 'Authenticator settings could not be saved.');
    } finally {
      if (lifecycle.current && !lifecycle.current.signal.aborted) setBusy(false);
    }
  }
  async function refresh(message: string, credentialsChanged = false) {
    setEnrollment(null);
    setCode('');
    setSecret('');
    startId.current = crypto.randomUUID();
    controlId.current = crypto.randomUUID();
    if (self && credentialsChanged) {
      setSettings(null);
      setMessage(`${message} Sign in again to continue.`);
      await onChanged?.(true);
      return;
    }
    const value = await request(
      `${path}/mfa`,
      { operatorId: actorId, cache: 'no-store', signal: signal() },
      settingsSchema,
    );
    if (!lifecycle.current?.signal.aborted) {
      setSettings(value);
      setMessage(message);
      await onChanged?.(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="administration-dialog"
      aria-labelledby="operator-mfa-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="administration-dialog-heading">
        <div>
          <div className="eyebrow">ACCOUNT SECURITY</div>
          <h2 id="operator-mfa-title">Authenticator for {operatorName}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close authenticator"
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
          <RequestReference error={errorCause} />
        </div>
      )}
      {message && (
        <div className="administration-status" role="status">
          {message}
        </div>
      )}
      {settings && (
        <>
          <p>Authenticator is {settings.enabled ? 'enabled' : 'disabled'}.</p>
          {!settings.enabled && !enrollment && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const value = await request(
                    `${path}/mfa-enrollments`,
                    {
                      operatorId: actorId,
                      method: 'POST',
                      cache: 'no-store',
                      signal: signal(),
                      body: JSON.stringify({
                        operationId: startId.current,
                        expectedVersion: settings.version,
                      }),
                    },
                    enrollmentSchema,
                  );
                  if (!lifecycle.current?.signal.aborted) setEnrollment(value);
                })
              }
            >
              Set up authenticator
            </button>
          )}
          {enrollment && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await request(
                    `${path}/mfa-enrollments/${enrollment.id}/verification`,
                    {
                      operatorId: actorId,
                      method: 'POST',
                      cache: 'no-store',
                      signal: signal(),
                      body: JSON.stringify({ code }),
                    },
                    successSchema,
                  );
                  await refresh(result.message, true);
                });
              }}
            >
              <p>
                Scan this code with your authenticator, then enter its six-digit code. The QR
                expires at {new Date(enrollment.expiresAt).toLocaleTimeString()}.
              </p>
              <img
                className="administration-mfa-qr"
                src={enrollment.qrDataUrl}
                alt="Private authenticator setup QR"
                referrerPolicy="no-referrer"
              />
              <label>
                Authenticator code
                <input
                  aria-label="Authenticator code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  disabled={busy}
                />
              </label>
              <div className="administration-dialog-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await request(
                        `${path}/mfa-enrollments/${enrollment.id}`,
                        {
                          operatorId: actorId,
                          method: 'DELETE',
                          cache: 'no-store',
                          signal: signal(),
                        },
                        successSchema,
                      );
                      await refresh(result.message);
                    })
                  }
                >
                  Cancel setup
                </button>
                <button className="button primary" disabled={busy}>
                  Verify authenticator
                </button>
              </div>
            </form>
          )}
          {settings.canReplace && !enrollment && (
            <form
              className="administration-mfa-controls"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await request(
                    `${path}/mfa`,
                    {
                      operatorId: actorId,
                      method: 'PUT',
                      cache: 'no-store',
                      signal: signal(),
                      body: JSON.stringify({
                        operationId: controlId.current,
                        expectedVersion: settings.version,
                        mode,
                        ...(mode === 'replace' ? { secret, code } : {}),
                      }),
                    },
                    successSchema,
                  );
                  await refresh(result.message, true);
                });
              }}
            >
              <p>
                Resetting the authenticator signs this operator out of existing sessions. Disabling
                it restores their configured OTP delivery channel.
              </p>
              <label>
                Authenticator action
                <select
                  aria-label="Authenticator action"
                  value={mode}
                  disabled={busy}
                  onChange={(event) => {
                    setMode(event.target.value === 'replace' ? 'replace' : 'disable');
                    setSecret('');
                    setCode('');
                    controlId.current = crypto.randomUUID();
                  }}
                >
                  <option value="disable">Disable authenticator</option>
                  <option value="replace">Replace with a supplied secret</option>
                </select>
              </label>
              {mode === 'replace' && (
                <>
                  <label>
                    New authenticator secret
                    <input
                      aria-label="New authenticator secret"
                      type="password"
                      autoComplete="new-password"
                      pattern="[A-Z2-7]{32,128}"
                      minLength={32}
                      maxLength={128}
                      required
                      value={secret}
                      onChange={(event) => {
                        setSecret(event.target.value.trim().toUpperCase());
                        controlId.current = crypto.randomUUID();
                      }}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    New authenticator code
                    <input
                      aria-label="New authenticator code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      minLength={6}
                      maxLength={6}
                      required
                      value={code}
                      onChange={(event) => {
                        setCode(event.target.value.replace(/\D/g, ''));
                        controlId.current = crypto.randomUUID();
                      }}
                      disabled={busy}
                    />
                  </label>
                </>
              )}
              <button
                className="button secondary"
                disabled={busy || (mode === 'disable' && !settings.configured && !settings.enabled)}
              >
                Apply authenticator reset
              </button>
            </form>
          )}
        </>
      )}
      {/* One status: once the current action's message is set, it replaces the busy text while
          the follow-up refresh still holds the controls. */}
      {busy && !message && <p role="status">Loading authenticator settings…</p>}
    </dialog>
  );
}
