import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, request } from '../api/client';
import { principalSchema, sessionSchema } from '../api/schemas';
import { ErrorState, Loading } from '../components/common';
import {
  clearDesktopSsoReference,
  readDesktopSsoReference,
  saveDesktopSsoReference,
  markDesktopSsoCreation,
  hasPendingDesktopSsoCreation,
  type DesktopSsoReference,
} from '../offline/desktop-sso';
export { isDesktopRuntime } from '../lib/desktop-runtime';

const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const flowSchema = z
  .object({
    id: z.uuid(),
    code: z.string().regex(/^\d{6}$/),
    expires: z.number().int().positive().safe(),
    browserUrl: z.url().max(2048),
  })
  .strict();
const statusSchema = z
  .object({
    status: z.enum([
      'pending',
      'awaiting-approval',
      'authorized',
      'consumed',
      'cancelled',
      'locked',
    ]),
    expires: z.number().int().positive().safe(),
  })
  .strict();
const currentFlowSchema = statusSchema.extend({ id: z.uuid() }).strict();
type CreatedFlow = z.infer<typeof flowSchema>;
type Flow = DesktopSsoReference &
  Partial<Pick<CreatedFlow, 'code' | 'browserUrl'>> & { recoveredWithoutBrowser?: boolean };
type Session = z.infer<typeof sessionSchema>;
function flowPath(flow: Flow) {
  return '/api/v1/auth/desktop-sso-sessions/' + encodeURIComponent(flow.id);
}
function validateBrowserUrl(flow: CreatedFlow): void {
  const url = new URL(flow.browserUrl);
  if (
    url.origin !== window.location.origin ||
    url.pathname !== '/api/v1/auth/sso/login' ||
    url.hash ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].length !== 2 ||
    url.searchParams.get('desktop') !== flow.id ||
    !proof.safeParse(url.searchParams.get('ticket')).success
  )
    throw new Error('The desktop sign-in link could not be verified.');
}

export function DesktopSsoLogin({
  enabled,
  disabled,
  beforeStart,
  onActiveChange,
  onSession,
}: {
  enabled: boolean;
  disabled: boolean;
  beforeStart: () => Promise<void>;
  onActiveChange: (active: boolean) => void;
  onSession: (session: Session) => Promise<void>;
}) {
  const [flow, setFlow] = useState<Flow | null>(null),
    [working, setWorking] = useState(false);
  const [resumable, setResumable] = useState<DesktopSsoReference | null>(null),
    [resumeReady, setResumeReady] = useState(false),
    [creationUnknown, setCreationUnknown] = useState(false);
  const [problem, setProblem] = useState<unknown>(null),
    [unknown, setUnknown] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const current = useRef<Flow | null>(null),
    busy = useRef(false),
    dispatch = useRef<'never' | 'inflight' | 'unknown' | 'confirmed'>('never');
  const credential = useRef<Session | null>(null),
    lifetime = useRef(new AbortController());
  const callbacks = useRef({ beforeStart, onActiveChange, onSession });
  callbacks.current = { beforeStart, onActiveChange, onSession };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    try {
      const previous = readDesktopSsoReference();
      setResumable(previous);
      setCreationUnknown(!previous && hasPendingDesktopSsoCreation());
      setResumeReady(true);
    } catch (error) {
      setProblem(error);
    }
    return () => {
      controller.abort();
      current.current = null;
    };
  }, []);
  const signal = useCallback(
    () => AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(12000)]),
    [],
  );
  const finish = useCallback(async (target: Flow, saved: Session) => {
    if (current.current !== target || lifetime.current.signal.aborted) return;
    credential.current = saved;
    dispatch.current = 'confirmed';
    setConfirmed(true);
    setUnknown(false);
    clearDesktopSsoReference(target.id);
    await callbacks.current.onSession(saved);
    if (current.current !== target || lifetime.current.signal.aborted) return;
    current.current = null;
    setFlow(null);
    callbacks.current.onActiveChange(false);
  }, []);
  const consume = useCallback(
    async (target: Flow) => {
      dispatch.current = 'inflight';
      try {
        const saved = await request(
          flowPath(target) + '/consumptions',
          { method: 'POST', body: '{}', signal: signal() },
          sessionSchema,
        );
        if (current.current !== target) return;
        await finish(target, saved);
      } catch (error) {
        if (current.current !== target || lifetime.current.signal.aborted) return;
        if (!credential.current) {
          dispatch.current = 'unknown';
          setUnknown(true);
        }
        setProblem(error);
      }
    },
    [finish, signal],
  );
  const check = useCallback(async () => {
    const target = current.current;
    if (
      !target ||
      busy.current ||
      dispatch.current === 'confirmed' ||
      lifetime.current.signal.aborted
    )
      return;
    busy.current = true;
    setWorking(true);
    try {
      if (target.expires <= Date.now()) {
        clearDesktopSsoReference(target.id);
        current.current = null;
        setFlow(null);
        callbacks.current.onActiveChange(false);
        setProblem(new Error('The original sign-in expired. Start a new sign-in.'));
        return;
      }
      const value = await request(
        flowPath(target),
        { signal: signal(), cache: 'no-store' },
        statusSchema,
      );
      if (current.current !== target || lifetime.current.signal.aborted) return;
      if (value.expires !== target.expires)
        throw new Error('The desktop sign-in changed. Start again.');
      if (['cancelled', 'locked'].includes(value.status) || value.expires <= Date.now()) {
        clearDesktopSsoReference(target.id);
        current.current = null;
        setFlow(null);
        callbacks.current.onActiveChange(false);
        setProblem(new Error('Start a new desktop sign-in.'));
        return;
      }
      if (value.status === 'authorized' && dispatch.current === 'never') {
        setWorking(true);
        await consume(target);
      } else if (value.status === 'consumed') {
        setUnknown(true);
        dispatch.current = 'unknown';
      }
    } catch (error) {
      if (current.current !== target || lifetime.current.signal.aborted) return;
      setProblem(error);
      if (error instanceof ApiError && [401, 404, 410].includes(error.status)) {
        // A missing/unavailable reply never proves that the original sign-in
        // did not commit. Retain its UUID and use only its status/consumption.
        dispatch.current = 'unknown';
        setUnknown(true);
      }
    } finally {
      busy.current = false;
      if (!lifetime.current.signal.aborted) setWorking(false);
    }
  }, [consume, signal]);
  useEffect(() => {
    if (!flow) return;
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => clearInterval(timer);
  }, [flow, check]);
  async function start() {
    if (
      busy.current ||
      disabled ||
      !enabled ||
      current.current ||
      resumable ||
      !resumeReady ||
      creationUnknown
    )
      return;
    busy.current = true;
    setWorking(true);
    setProblem(null);
    callbacks.current.onActiveChange(true);
    let dispatched = false;
    try {
      await callbacks.current.beforeStart();
      lifetime.current.signal.throwIfAborted();
      markDesktopSsoCreation();
      dispatched = true;
      const created = await request(
        '/api/v1/auth/desktop-sso-sessions',
        { method: 'POST', body: '{}', signal: signal() },
        flowSchema,
      );
      lifetime.current.signal.throwIfAborted();
      validateBrowserUrl(created);
      saveDesktopSsoReference({ id: created.id, expires: created.expires });
      current.current = created;
      credential.current = null;
      dispatch.current = 'never';
      setUnknown(false);
      setConfirmed(false);
      setFlow(created);
      window.open(created.browserUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      if (!lifetime.current.signal.aborted) {
        if (dispatched && !current.current) setCreationUnknown(true);
        setProblem(error);
        callbacks.current.onActiveChange(false);
      }
    } finally {
      busy.current = false;
      if (!lifetime.current.signal.aborted) setWorking(false);
    }
  }
  async function restoreCurrent() {
    if (current.current || busy.current || disabled || !enabled) return;
    busy.current = true;
    setWorking(true);
    setProblem(null);
    try {
      await callbacks.current.beforeStart();
      const original = await request(
        '/api/v1/auth/desktop-sso-sessions/current',
        { cache: 'no-store', signal: signal() },
        currentFlowSchema,
      );
      lifetime.current.signal.throwIfAborted();
      if (original.expires <= Date.now() || ['cancelled', 'locked'].includes(original.status)) {
        clearDesktopSsoReference(original.id);
        setCreationUnknown(false);
        setResumable(null);
        setProblem(new Error('The original sign-in has ended. Start a new sign-in.'));
        return;
      }
      const target = {
        id: original.id,
        expires: original.expires,
        recoveredWithoutBrowser: creationUnknown,
      };
      current.current = target;
      credential.current = null;
      dispatch.current = original.status === 'consumed' ? 'unknown' : 'never';
      setUnknown(original.status === 'consumed');
      setConfirmed(false);
      setCreationUnknown(false);
      setResumable(null);
      setFlow(target);
      callbacks.current.onActiveChange(true);
      saveDesktopSsoReference({ id: target.id, expires: target.expires });
    } catch (error) {
      if (!lifetime.current.signal.aborted) {
        setProblem(error);
        // Missing cookies/rows and unavailable replies are not an instruction
        // to issue a new nonce. Only this explicit GET can recover creation.
        if (!current.current) {
          setCreationUnknown(true);
          callbacks.current.onActiveChange(false);
        }
      }
    } finally {
      busy.current = false;
      if (!lifetime.current.signal.aborted) setWorking(false);
    }
  }
  async function reset() {
    if (busy.current || disabled || !enabled) return;
    busy.current = true;
    setWorking(true);
    setProblem(null);
    try {
      await request('/api/v1/auth/sessions/current', { method: 'DELETE', signal: signal() });
      lifetime.current.signal.throwIfAborted();
      // An acknowledged idempotent logout clears the HttpOnly desktop proof.
      // A missing/failed response keeps the dispatch marker and original UUID.
      clearDesktopSsoReference();
      current.current = null;
      credential.current = null;
      dispatch.current = 'never';
      setFlow(null);
      setResumable(null);
      setUnknown(false);
      setConfirmed(false);
      setCreationUnknown(false);
      callbacks.current.onActiveChange(false);
    } catch (error) {
      if (!lifetime.current.signal.aborted) setProblem(error);
    } finally {
      busy.current = false;
      if (!lifetime.current.signal.aborted) setWorking(false);
    }
  }
  async function resume() {
    if (!resumable || busy.current || disabled || !enabled || current.current) return;
    busy.current = true;
    setWorking(true);
    setProblem(null);
    callbacks.current.onActiveChange(true);
    try {
      if (resumable.expires <= Date.now()) {
        clearDesktopSsoReference(resumable.id);
        setResumable(null);
        callbacks.current.onActiveChange(false);
        setProblem(new Error('The original sign-in expired. Start a new sign-in.'));
        return;
      }
      await callbacks.current.beforeStart();
      lifetime.current.signal.throwIfAborted();
      const original = { ...resumable };
      current.current = original;
      credential.current = null;
      dispatch.current = 'never';
      setResumable(null);
      setUnknown(false);
      setConfirmed(false);
      setFlow(original);
      // The effect performs an authenticated GET first. Browser/code material
      // is deliberately unavailable after restart and is never reissued here.
    } catch (error) {
      if (!lifetime.current.signal.aborted) {
        setProblem(error);
        callbacks.current.onActiveChange(false);
      }
    } finally {
      busy.current = false;
      if (!lifetime.current.signal.aborted) setWorking(false);
    }
  }
  async function recover() {
    const target = current.current;
    if (!target || busy.current || disabled) return;
    busy.current = true;
    setWorking(true);
    setProblem(null);
    try {
      if (dispatch.current === 'confirmed' && credential.current)
        await finish(target, credential.current);
      else await consume(target);
    } catch (error) {
      if (!lifetime.current.signal.aborted) setProblem(error);
    } finally {
      busy.current = false;
      if (!lifetime.current.signal.aborted) setWorking(false);
    }
  }
  async function cancel() {
    const target = current.current;
    if (!target || busy.current || disabled) return;
    busy.current = true;
    setWorking(true);
    try {
      await request(
        flowPath(target) + '/cancellations',
        { method: 'POST', body: '{}', signal: signal() },
        z.object({ cancelled: z.literal(true) }),
      );
      if (current.current !== target) return;
      clearDesktopSsoReference(target.id);
      current.current = null;
      credential.current = null;
      setCreationUnknown(false);
      setFlow(null);
      setProblem(null);
      callbacks.current.onActiveChange(false);
    } catch (error) {
      if (!lifetime.current.signal.aborted) {
        setProblem(error);
        setUnknown(true);
        dispatch.current = 'unknown';
      }
    } finally {
      busy.current = false;
      if (!lifetime.current.signal.aborted) setWorking(false);
    }
  }
  return (
    <div className="desktop-sso-login">
      {!flow ? (
        <button
          className="button secondary full"
          type="button"
          disabled={!enabled || disabled || working || !resumeReady}
          onClick={() => void (resumable ? resume() : creationUnknown ? restoreCurrent() : start())}
        >
          {resumable
            ? 'Resume previous Google sign-in'
            : creationUnknown
              ? 'Recover original Google sign-in'
              : 'Continue with Google'}
        </button>
      ) : (
        <section aria-label="Google desktop sign-in">
          {flow.code ? (
            <>
              <p>Complete Google sign-in in your browser, then enter this code there:</p>
              <p className="desktop-sso-code" aria-label="Desktop pairing code">
                {flow.code}
              </p>
            </>
          ) : flow.recoveredWithoutBrowser ? (
            <p>
              The original request was found, but its browser link and pairing code were not
              received. Cancel this original sign-in and wait for confirmation before starting a new
              sign-in.
            </p>
          ) : (
            <p>
              Checking the original sign-in from this device. If its browser was already opened,
              finish approval there. Otherwise cancel this original sign-in before starting another.
            </p>
          )}
          <p className="caption">
            Return here after approval. This sign-in expires at{' '}
            {new Date(flow.expires).toLocaleTimeString()}.
          </p>
          <div className="toolbar">
            {!unknown && !confirmed && flow.browserUrl && (
              <button
                className="button secondary"
                type="button"
                disabled={disabled || working}
                onClick={() => {
                  if (flow.browserUrl)
                    window.open(flow.browserUrl, '_blank', 'noopener,noreferrer');
                }}
              >
                Open browser
              </button>
            )}
            {(unknown || confirmed) && (
              <button
                className="button"
                type="button"
                disabled={disabled || working}
                onClick={() => void recover()}
              >
                {confirmed ? 'Finish sign-in' : 'Recover sign-in'}
              </button>
            )}
            <button
              className="button secondary"
              type="button"
              disabled={disabled || working}
              onClick={() => void check()}
            >
              Check sign-in
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={disabled || working}
              onClick={() => void cancel()}
            >
              Cancel sign-in
            </button>
          </div>
        </section>
      )}
      {!flow && !resumable && !creationUnknown && (
        <button
          className="button secondary full"
          type="button"
          disabled={!enabled || disabled || working || !resumeReady}
          onClick={() => void restoreCurrent()}
        >
          Check previous Google sign-in
        </button>
      )}
      {(creationUnknown || unknown) && (
        <button
          className="button secondary full"
          type="button"
          disabled={!enabled || disabled || working}
          onClick={() => void reset()}
        >
          Reset desktop sign-in
        </button>
      )}
      {working && (
        <p role="status" className="caption">
          Checking sign-in…
        </p>
      )}
      {problem !== null && <ErrorState error={problem} />}
    </div>
  );
}

const approvalSchema = z
  .object({
    user: principalSchema,
    expires: z.number().int().positive().safe(),
    approved: z.boolean(),
  })
  .strict();
export function DesktopSsoApprovalPage() {
  const [code, setCode] = useState(''),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<unknown>(null),
    [approved, setApproved] = useState(false);
  const proof = useQuery({
    queryKey: ['desktop-sso-browser-approval'],
    queryFn: ({ signal }) =>
      request('/api/v1/auth/desktop-sso/approval', { signal, cache: 'no-store' }, approvalSchema),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  async function verify() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await request(
        '/api/v1/auth/desktop-sso/approval',
        { method: 'POST', body: JSON.stringify({ code }) },
        z.object({ approved: z.literal(true) }),
      );
      setCode('');
      setApproved(true);
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login desktop-sso-approval">
      <section className="login-form">
        <div className="wordmark">
          the souled store<span>DESKTOP SIGN-IN</span>
        </div>
        <h1>Finish desktop sign-in</h1>
        {proof.isPending ? (
          <Loading />
        ) : proof.isError ? (
          <ErrorState error={proof.error} retry={() => void proof.refetch()} />
        ) : (
          proof.data &&
          (approved || proof.data.approved ? (
            <p role="status">Sign-in approved. Return to Souled POS.</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              <p>
                Sign in to the desktop app as <strong>{proof.data.user.name}</strong> (
                {proof.data.user.email}). Approve only if you started sign-in on your POS device.
              </p>
              <label>
                Code shown in the POS desktop app
                <input
                  aria-label="Desktop pairing code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                />
              </label>
              <button
                className="button full"
                type="submit"
                disabled={busy || code.length !== 6 || proof.data.expires <= Date.now()}
              >
                Approve desktop sign-in
              </button>
            </form>
          ))
        )}
        {problem !== null && (
          <>
            <ErrorState error={problem} />
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void proof.refetch().then((value) => {
                  if (value.data?.approved) {
                    setProblem(null);
                    setCode('');
                    setApproved(true);
                  }
                })
              }
            >
              Check approval
            </button>
          </>
        )}
      </section>
    </main>
  );
}
