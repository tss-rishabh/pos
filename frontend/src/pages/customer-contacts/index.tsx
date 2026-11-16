import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Phone, ShieldCheck } from 'lucide-react';
import { ApiError, captureOperatorScope } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import {
  contactCreateInput,
  contactVerifyInput,
  readContactWorkspace,
  readContactChallenge,
  readContactOperation,
  sendContactIntent,
  type ContactChallenge,
  type ContactIntent,
  type CustomerContactScope,
} from './api';
import './style.css';

export interface CustomerContactActions {
  act: (task: () => Promise<void>) => Promise<void>;
  onPending: (pending: boolean) => void;
  onSaved: () => Promise<void>;
}
export interface CustomerContactPanelProps {
  scope: CustomerContactScope;
  checkoutVersion: number;
  online: boolean;
  disabled?: boolean;
  actions: CustomerContactActions;
}
export function CustomerContactPanel(props: CustomerContactPanelProps) {
  const { scope } = props;
  return (
    <ScopedCustomerContactPanel
      key={`${scope.operatorId}:${scope.storeId}:${scope.checkoutId}:${scope.customerId}`}
      {...props}
    />
  );
}
function ScopedCustomerContactPanel({
  scope,
  checkoutVersion,
  online,
  disabled = false,
  actions,
}: CustomerContactPanelProps) {
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<'telephone' | 'email'>('email'),
    [target, setTarget] = useState(''),
    [code, setCode] = useState(''),
    [challenge, setChallenge] = useState<ContactChallenge | null>(null),
    [phase, setPhase] = useState<'idle' | 'sending' | 'uncertain' | 'refresh-needed'>('idle'),
    [problem, setProblem] = useState(''),
    [notice, setNotice] = useState(''),
    [tick, setTick] = useState(Date.now());
  const intent = useRef<ContactIntent | null>(null),
    active = useRef(false),
    lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      actions.onPending(false);
    };
  }, [scope.operatorId, scope.storeId, scope.checkoutId, scope.customerId]);
  const workspace = useQuery({
    queryKey: [
      scope.operatorId,
      'customer-contacts',
      scope.storeId,
      scope.checkoutId,
      scope.customerId,
      checkoutVersion,
    ],
    enabled: open && online && phase === 'idle',
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) =>
      readContactWorkspace(scope, AbortSignal.any([signal, lifetime.current.signal])),
  });
  const latest = useQuery({
    queryKey: [
      scope.operatorId,
      'customer-contact-challenge',
      scope.storeId,
      scope.checkoutId,
      scope.customerId,
      challenge?.id,
    ],
    enabled: open && online && Boolean(challenge) && phase !== 'sending',
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) =>
      readContactChallenge(
        scope,
        challenge!.id,
        AbortSignal.any([signal, lifetime.current.signal]),
      ),
    refetchInterval: (query) => {
      const value = query.state.data;
      return value &&
        (value.status === 'COMMITTING' || ['PENDING', 'SENDING'].includes(value.delivery ?? ''))
        ? 2000
        : false;
    },
  });
  useEffect(() => {
    const row = workspace.data?.activeChallenge;
    const available = workspace.data?.addableKinds;
    if (available?.length && !available.includes(kind)) setKind(available[0]!);
    if (row)
      setChallenge((previous) =>
        !previous || (previous.id === row.id && previous.version <= row.version) ? row : previous,
      );
  }, [workspace.data, kind]);
  useEffect(() => {
    const row = latest.data;
    if (row)
      setChallenge((previous) =>
        previous?.id === row.id && previous.version <= row.version ? row : previous,
      );
  }, [latest.data]);
  useEffect(() => {
    if (!open || !challenge) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, challenge?.id]);
  const current = workspace.data,
    frozen = disabled || !online || phase !== 'idle',
    changed = current && current.checkoutVersion !== checkoutVersion;
  const accept = async (
    result: Awaited<ReturnType<typeof sendContactIntent>>,
    attempt: ContactIntent,
    owner: AbortSignal,
  ) => {
    owner.throwIfAborted();
    setChallenge(result.challenge);
    setCode('');
    intent.current = null;
    if (result.receipt?.status === 'error') {
      setProblem(result.receipt.message);
      setPhase('idle');
      actions.onPending(false);
      return;
    }
    setNotice(
      result.receipt?.message ?? 'Verification is queued for the existing customer contact.',
    );
    if (attempt.action === 'commit') {
      setPhase('refresh-needed');
      try {
        await actions.onSaved();
        owner.throwIfAborted();
        setPhase('idle');
        actions.onPending(false);
      } catch {
        if (!owner.aborted)
          setProblem('The contact was saved. Refresh the sale before continuing.');
      }
    } else {
      setPhase('idle');
      actions.onPending(false);
    }
  };
  async function run(mode: 'send' | 'check') {
    const attempt = intent.current;
    if (!attempt || active.current || !online) return;
    if (mode === 'send' && disabled && phase === 'idle') return;
    let entered = false;
    await actions.act(async () => {
      if (active.current || intent.current !== attempt) return;
      entered = true;
      const owner = AbortSignal.any([
        captureOperatorScope(scope.operatorId),
        lifetime.current.signal,
      ]);
      active.current = true;
      actions.onPending(true);
      setPhase('sending');
      setProblem('');
      setNotice('');
      try {
        let result: Awaited<ReturnType<typeof sendContactIntent>>;
        if (mode === 'check') {
          if (attempt.action === 'create') {
            const snapshot = await readContactWorkspace(scope, owner);
            owner.throwIfAborted();
            const row = snapshot.activeChallenge;
            if (!row || row.id !== attempt.input.operationId)
              throw new Error(
                'No saved request is visible yet. Check again or retry the exact saved request.',
              );
            result = { challenge: row, receipt: null };
          } else result = await readContactOperation(scope, attempt, owner);
        } else result = await sendContactIntent(scope, attempt, owner);
        await accept(result, attempt, owner);
      } catch (error) {
        if (owner.aborted) return;
        if (intent.current === null) {
          setPhase('refresh-needed');
          setProblem('The contact is saved. Refresh the sale before continuing.');
        } else if (mode === 'send' && error instanceof ApiError && error.status < 500) {
          // Failed OTP attempts are committed too. Read their operation/challenge
          // before allowing a new intent, so a lost400 response cannot add guesses.
          if (attempt.action !== 'create') {
            try {
              const saved = await readContactOperation(scope, attempt, owner);
              await accept(saved, attempt, owner);
              return;
            } catch (readError) {
              if (owner.aborted) return;
              if (!(readError instanceof ApiError && readError.status === 404)) {
                setPhase('uncertain');
                setProblem('The contact operation is unconfirmed. Check its saved status.');
                return;
              }
            }
          }
          intent.current = null;
          setPhase('idle');
          setProblem(error.message);
          actions.onPending(false);
          void workspace.refetch();
        } else {
          setPhase('uncertain');
          setProblem(
            mode === 'check'
              ? 'No confirmed result is visible yet. Check again or retry the exact saved request.'
              : 'The request is unconfirmed. Check its saved status before retrying.',
          );
        }
      } finally {
        active.current = false;
      }
    });
    if (!entered) {
      setPhase('uncertain');
      setProblem(
        'The sale is busy. Check the saved status or retry when the current action finishes.',
      );
    }
  }
  async function begin(event: FormEvent) {
    event.preventDefault();
    if (frozen || intent.current || !current?.contactFingerprint || changed) return;
    const parsed = contactCreateInput.safeParse({
      operationId: crypto.randomUUID(),
      checkoutVersion: current.checkoutVersion,
      contactFingerprint: current.contactFingerprint,
      kind,
      value: target,
    });
    if (!parsed.success) {
      setProblem(
        kind === 'email'
          ? 'Enter a valid email within 96 characters.'
          : 'Enter a valid 10-digit Indian mobile number.',
      );
      return;
    }
    intent.current = { action: 'create', input: parsed.data };
    await run('send');
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    if (frozen || !challenge || intent.current) return;
    const parsed = contactVerifyInput.safeParse({
      operationId: crypto.randomUUID(),
      version: challenge.version,
      stage: challenge.stage,
      code,
    });
    if (!parsed.success) {
      setProblem('Enter the six-digit verification code.');
      return;
    }
    intent.current = { action: 'verify', challengeId: challenge.id, input: parsed.data };
    await run('send');
  }
  async function command(action: 'resend' | 'cancel' | 'commit' | 'recover') {
    if (frozen || !challenge || intent.current) return;
    const input = { operationId: crypto.randomUUID(), version: challenge.version };
    intent.current =
      action === 'commit'
        ? { action, challengeId: challenge.id, input: { ...input, checkoutVersion } }
        : { action, challengeId: challenge.id, input };
    await run('send');
  }
  async function refreshSale() {
    if (active.current || !online) return;
    await actions.act(async () => {
      const owner = AbortSignal.any([
        captureOperatorScope(scope.operatorId),
        lifetime.current.signal,
      ]);
      active.current = true;
      try {
        await actions.onSaved();
        owner.throwIfAborted();
        setPhase('idle');
        setProblem('');
        actions.onPending(false);
      } catch {
        if (!owner.aborted)
          setProblem('The contact was saved. Refresh the sale before continuing.');
      } finally {
        active.current = false;
      }
    });
  }
  const terminal =
      challenge && ['COMMITTED', 'CANCELLED', 'EXPIRED', 'LOCKED'].includes(challenge.status),
    pendingCode = challenge && ['PENDING_CURRENT', 'PENDING_NEW'].includes(challenge.status),
    remaining = challenge ? Math.max(0, Math.ceil((challenge.retryAt - tick) / 1000)) : 0;
  return (
    <section aria-label="Verified customer contacts" className="customer-contact-panel">
      <button
        type="button"
        className="button secondary"
        disabled={!online || phase === 'sending'}
        aria-expanded={open && online}
        onClick={() => setOpen(!open)}
      >
        <ShieldCheck size={15} />
        {open && online ? 'Hide contact verification' : 'Add a missing contact'}
      </button>
      {open && online && (
        <div className="customer-contact-card">
          <h3>Verified customer contact</h3>
          <p>
            Verify the customer’s existing contact, then the new contact. Adding a contact clears
            previous sale verification and requires a fresh quote.
          </p>
          {problem && (
            <p className="error" role="alert">
              {problem}
            </p>
          )}
          {notice && (
            <p className="success" role="status">
              {notice}
            </p>
          )}
          {phase === 'sending' && <p role="status">Saving verification…</p>}
          {phase === 'uncertain' && (
            <div className="customer-contact-recovery">
              <p>The saved request is kept for safe recovery.</p>
              <button className="button secondary" type="button" onClick={() => void run('check')}>
                Check saved status
              </button>
              <button className="button secondary" type="button" onClick={() => void run('send')}>
                Retry exact request
              </button>
            </div>
          )}
          {(phase === 'refresh-needed' || changed) && (
            <button type="button" className="button secondary" onClick={() => void refreshSale()}>
              Refresh sale
            </button>
          )}
          {!challenge &&
            phase === 'idle' &&
            (workspace.isPending || workspace.isFetching ? (
              <Loading />
            ) : workspace.isError ? (
              <ErrorState error={workspace.error} retry={() => void workspace.refetch()} />
            ) : current?.pendingElsewhere ? (
              <p>A contact change for this customer is already pending in another sale.</p>
            ) : !current?.enabled ? (
              <p>Verified contact changes are unavailable in this workspace.</p>
            ) : current.addableKinds.length === 0 ? (
              <p>
                There is no missing contact that can be verified here. Use account support if the
                existing contact is unavailable.
              </p>
            ) : (
              <form
                aria-label="Add missing customer contact"
                onSubmit={(event) => void begin(event)}
              >
                <label>
                  Contact type
                  <select
                    value={current.addableKinds.includes(kind) ? kind : current.addableKinds[0]}
                    disabled={frozen}
                    onChange={(event) => {
                      setKind(event.target.value === 'telephone' ? 'telephone' : 'email');
                      setTarget('');
                    }}
                  >
                    {current.addableKinds.includes('email') && <option value="email">Email</option>}
                    {current.addableKinds.includes('telephone') && (
                      <option value="telephone">Mobile number</option>
                    )}
                  </select>
                </label>
                <label>
                  {kind === 'email' ? 'New email' : 'New mobile number'}
                  <input
                    type={kind === 'email' ? 'email' : 'tel'}
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    disabled={frozen}
                    maxLength={kind === 'email' ? 96 : 10}
                    autoComplete="off"
                    inputMode={kind === 'telephone' ? 'numeric' : 'email'}
                    required
                  />
                </label>
                <button className="button" disabled={frozen || Boolean(changed)}>
                  {kind === 'email' ? <Mail size={15} /> : <Phone size={15} />}Verify existing
                  contact
                </button>
              </form>
            ))}
          {challenge && (
            <div className="customer-contact-proof">
              <p>
                <strong>{challenge.kind === 'email' ? 'Email' : 'Mobile'}:</strong>{' '}
                {challenge.value}
              </p>
              {pendingCode && (
                <>
                  <p>
                    {challenge.stage === 'current'
                      ? `Step 1 of 2: code sent to ${challenge.currentDestination}.`
                      : 'Step 2 of 2: code sent to the new contact.'}
                  </p>
                  {['PENDING', 'SENDING'].includes(challenge.delivery ?? '') && (
                    <p role="status">Verification delivery is queued…</p>
                  )}
                  {challenge.delivery === 'UNCERTAIN' && (
                    <p>Delivery is unconfirmed. If the code arrived, you can use it.</p>
                  )}
                  {challenge.delivery === 'REJECTED' && (
                    <p>Delivery was rejected. Request a new code after the cooldown.</p>
                  )}
                  <form
                    aria-label="Verify customer contact code"
                    onSubmit={(event) => void verify(event)}
                  >
                    <label>
                      Verification code
                      <input
                        value={code}
                        onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
                        maxLength={6}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        disabled={frozen}
                        required
                      />
                    </label>
                    <button
                      className="button"
                      disabled={
                        frozen ||
                        challenge.codeExpiresAt <= tick ||
                        !['SENDING', 'DELIVERED', 'UNCERTAIN'].includes(challenge.delivery ?? '')
                      }
                    >
                      Verify code
                    </button>
                  </form>
                  <p>
                    {challenge.attemptsRemaining} attempts remaining.{' '}
                    {challenge.codeExpiresAt <= tick ? 'This code expired. Request a new one.' : ''}
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={frozen || remaining > 0}
                    onClick={() => void command('resend')}
                  >
                    {remaining > 0 ? `Resend in ${remaining}s` : 'Resend code'}
                  </button>
                </>
              )}
              {challenge.status === 'READY' && (
                <div>
                  <p>
                    Both contacts are verified. Confirm adding this contact to the attached
                    customer.
                  </p>
                  <button
                    type="button"
                    className="button"
                    disabled={frozen}
                    onClick={() => void command('commit')}
                  >
                    Confirm contact addition
                  </button>
                </div>
              )}
              {challenge.status === 'COMMITTING' && (
                <p role="status">
                  Contact saved. Its synchronization obligation is being recorded.
                </p>
              )}
              {challenge.status === 'COMMITTED' && (
                <p role="status">
                  Contact saved and synchronization accepted. Verify the customer again before using
                  account benefits.
                </p>
              )}
              {challenge.status === 'UNCERTAIN' && (
                <div>
                  <p>
                    Contact saved; synchronization needs recovery. The customer record will not be
                    written again.
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={frozen || remaining > 0}
                    onClick={() => void command('recover')}
                  >
                    Retry saved synchronization
                  </button>
                </div>
              )}
              {['PENDING_CURRENT', 'PENDING_NEW', 'READY'].includes(challenge.status) && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={frozen}
                  onClick={() => void command('cancel')}
                >
                  Cancel contact request
                </button>
              )}
              {terminal && phase === 'idle' && (
                <>
                  <p>
                    {challenge.status === 'LOCKED'
                      ? 'The code attempt limit was reached.'
                      : challenge.status === 'EXPIRED'
                        ? 'This proof expired.'
                        : challenge.status === 'CANCELLED'
                          ? 'Contact request cancelled.'
                          : ''}
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={disabled}
                    onClick={() => {
                      setChallenge(null);
                      setTarget('');
                      setCode('');
                      setNotice('');
                      setProblem('');
                      void workspace.refetch();
                    }}
                  >
                    Done
                  </button>
                </>
              )}
              <small>Reference {challenge.id}</small>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
