import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, LockKeyhole, Monitor } from 'lucide-react';
import { z } from 'zod';
import { post, request } from '../api/client';
import { capabilitiesSchema, loginChallengeSchema, sessionSchema } from '../api/schemas';
import { ErrorState } from '../components/common';
import { loginChallengePendingKey } from '../hooks/use-pos';
import { useWorkspace } from '../state/workspace';

type Challenge = z.infer<typeof loginChallengeSchema>;
export function Login() {
  const client = useQueryClient(),
    workspace = useWorkspace();
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [challenge, setChallenge] = useState<Challenge | null>(null),
    [code, setCode] = useState(''),
    [factor, setFactor] = useState<'otp' | 'totp'>('otp'),
    [storeId, setStore] = useState(''),
    [notice, setNotice] = useState('');
  const options = useQuery({
    queryKey: ['login-options'],
    queryFn: () => request('/api/v1/auth/capabilities', {}, capabilitiesSchema),
    retry: false,
  });
  const mayRestoreChallenge = useRef(true);
  function showChallenge(value: Challenge) {
    mayRestoreChallenge.current = false;
    setChallenge(value);
    setFactor(value.method);
    setStore(value.stores.length === 1 ? value.stores[0]!.id : '');
    setNotice(value.message);
    setCode('');
  }
  // Only a browser holding an unexpired password-step cookie has a challenge to restore.
  const challengePending = client.getQueryData<boolean>(loginChallengePendingKey) === true;
  useEffect(() => {
    if (!options.data?.password || !challengePending) return;
    let active = true;
    void request('/api/v1/auth/challenges/current', {}, loginChallengeSchema)
      .then((value) => {
        if (active && mayRestoreChallenge.current) showChallenge(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [options.data?.password, challengePending]);
  async function complete() {
    await client.invalidateQueries({ queryKey: ['operator'] });
  }
  async function clearPendingLogout() {
    // Explicit password/SSO sign-in supersedes an in-flight mount restore.
    // Its late response must not replace the new challenge or erase entered OTP.
    mayRestoreChallenge.current = false;
    if (localStorage.getItem('pos-pending-logout')) {
      await request('/api/v1/auth/sessions/current', { method: 'DELETE' });
      localStorage.removeItem('pos-pending-logout');
    }
  }
  async function login(form: HTMLFormElement) {
    if (busy) return;
    // Disabled controls are omitted by FormData. Capture before locking the UI
    // or awaiting a pending logout, while keeping credentials in this call only.
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await clearPendingLogout();
      showChallenge(
        await post(
          '/api/v1/auth/sessions',
          { username: data.get('username'), password: data.get('password') },
          loginChallengeSchema,
        ),
      );
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await post(
        '/api/v1/auth/challenges/current/verifications',
        { code, factor, storeId },
        sessionSchema,
      );
      setCode('');
      // Store 0 is legacy "Not at the store": signed in without a store check-in.
      if (storeId !== '0') workspace.setStore(storeId);
      await complete();
    } catch (error) {
      setCode('');
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    setBusy(true);
    setError(null);
    try {
      const value = await post('/api/v1/auth/challenges/current/resends', {}, loginChallengeSchema);
      setChallenge(value);
      setNotice(value.message);
      setFactor('otp');
      setCode('');
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-story">
        <div className="wordmark">
          the souled store<span>RETAIL WORKSPACE</span>
        </div>
        <div>
          <div className="eyebrow">GOOD DAYS START HERE</div>
          <h1>
            More time
            <br />
            for your
            <br />
            <em>customers.</em>
          </h1>
          <p>
            One familiar workspace.
            <br />
            At every counter, in every store.
          </p>
        </div>
        <div className="login-footer">
          <Monitor size={17} />
          Made for desktop & web
        </div>
      </section>
      <section className="login-form">
        <div className="eyebrow">{challenge ? 'ONE MORE STEP' : 'WELCOME BACK'}</div>
        <h2>{challenge ? 'Make it securely yours.' : 'Let’s open the store.'}</h2>
        <p>
          {challenge
            ? factor === 'totp'
              ? 'Enter the code from your authenticator and select your store.'
              : 'Enter the login OTP sent through your registered channel.'
            : 'Sign in with your store account to get started.'}
        </p>
        {options.isError ? (
          <ErrorState error={options.error} retry={() => void options.refetch()} />
        ) : challenge ? (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              <label>
                Store
                <select
                  aria-label="Login store"
                  required
                  value={storeId}
                  onChange={(event) => setStore(event.target.value)}
                >
                  <option value="">Select a store</option>
                  {challenge.stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                  <option value="0">Not at the store</option>
                </select>
              </label>
              <label>
                {factor === 'totp' ? 'Authenticator code' : 'Login OTP'}
                <input
                  autoFocus
                  aria-label="Verification code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </label>
              {notice && <p role="status">{notice}</p>}
              <button
                className="button primary full"
                disabled={busy || challenge.locked || code.length !== 6 || !storeId}
              >
                Verify & check in
                <ArrowRight size={17} />
              </button>
            </form>
            <button
              className="button secondary full"
              disabled={busy || challenge.locked}
              onClick={() => void resend()}
            >
              {factor === 'totp' ? 'Send a login OTP' : 'Resend OTP'}
            </button>
            {challenge.method === 'totp' && factor === 'otp' && (
              <button
                className="button secondary full"
                onClick={() => {
                  setFactor('totp');
                  setCode('');
                }}
              >
                Use authenticator code
              </button>
            )}
            <button
              className="button secondary full"
              onClick={() => {
                setChallenge(null);
                setCode('');
                setError(null);
              }}
            >
              <ArrowLeft size={15} />
              Use another account
            </button>
          </>
        ) : (
          <>
            {options.data?.password && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void login(event.currentTarget);
                }}
              >
                <label>
                  Email or username
                  <input
                    autoFocus
                    name="username"
                    disabled={busy}
                    autoComplete="username"
                    required
                    maxLength={150}
                    placeholder="you@thesouledstore.com"
                  />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    disabled={busy}
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={4096}
                    placeholder="Enter your password"
                  />
                </label>
                <button className="button primary full" disabled={busy}>
                  {busy ? 'Checking credentials…' : 'Continue'}
                  <ArrowRight size={18} />
                </button>
              </form>
            )}
          </>
        )}
        {error !== null && <ErrorState error={error} />}
        <small className="login-security">
          <LockKeyhole size={13} />
          Your store data stays scoped to your account.
        </small>
      </section>
    </main>
  );
}
