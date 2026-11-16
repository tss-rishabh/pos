import { useRef, useState, type FormEvent } from 'react';
import { ApiError, captureOperatorScope } from '../../api/client';
import { requireCachedOperatorSession } from '../../offline/operator-session';
import {
  profileAdjustment,
  profileAdjustmentInput,
  type CustomerProfile,
  type ProfileAdjustmentInput,
  type ProfileScope,
} from './client';

export interface ProfileEditorActions {
  act: (task: () => Promise<void>) => Promise<void>;
  onPending: (pending: boolean) => void;
  onSaved: () => Promise<void>;
}
export function CustomerProfileEditor({
  scope,
  profile,
  disabled,
  actions,
}: {
  scope: ProfileScope;
  profile: CustomerProfile;
  disabled: boolean;
  actions: ProfileEditorActions;
}) {
  const [editing, setEditing] = useState(false);
  const [birthday, setBirthday] = useState(profile.profile.birthday ?? '');
  const [anniversary, setAnniversary] = useState(profile.profile.anniversary ?? '');
  const [gender, setGender] = useState(profile.profile.gender ?? '');
  const [customerType, setCustomerType] = useState(profile.profile.customerType ?? '');
  const [gstin, setGstin] = useState(profile.profile.gstin ?? '');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'uncertain' | 'confirmed'>('idle');
  const [problem, setProblem] = useState('');
  const intent = useRef<ProfileAdjustmentInput | null>(null);
  const active = useRef(false);

  async function run(reconcile: boolean) {
    if (active.current || disabled || !intent.current) return;
    await actions.act(async () => {
      const saved = intent.current;
      if (active.current || !saved) return;
      const owner = captureOperatorScope(scope.operatorId);
      await requireCachedOperatorSession(scope.operatorId, scope.storeId, owner);
      active.current = true;
      actions.onPending(true);
      setPhase('sending');
      setProblem('');
      try {
        await profileAdjustment(scope, saved, reconcile);
        owner.throwIfAborted();
        if (intent.current !== saved) return;
        setPhase('confirmed');
        // Once proof is known, only refresh the sale. Never repeat the write to
        // repair a failed UI refresh or a late component callback.
        intent.current = null;
        await actions.onSaved();
        actions.onPending(false);
        setEditing(false);
        setPhase('idle');
      } catch (error) {
        if (owner.aborted) return;
        if (intent.current === null) {
          setPhase('confirmed');
          setProblem('Customer details were saved. Reload the sale before continuing.');
        } else if (error instanceof ApiError && error.status < 500 && !reconcile) {
          intent.current = null;
          actions.onPending(false);
          setPhase('idle');
          setProblem(error.message);
        } else {
          setPhase('uncertain');
          setProblem(
            reconcile && error instanceof ApiError && error.status === 404
              ? 'No saved update is visible yet. Check again, or retry the exact saved update.'
              : 'The update is unconfirmed. Check its saved status before retrying.',
          );
        }
      } finally {
        active.current = false;
      }
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (active.current || intent.current || phase !== 'idle') return;
    const original = profile.profile;
    const parsed = profileAdjustmentInput.safeParse({
      operationId: crypto.randomUUID(),
      expectedVersion: profile.checkoutVersion,
      expectedEtag: profile.etag,
      changes: {
        ...(birthday !== (original.birthday ?? '') ? { birthday } : {}),
        ...(anniversary !== (original.anniversary ?? '') ? { anniversary } : {}),
        ...(gender !== (original.gender ?? '') ? { gender } : {}),
        ...(customerType !== (original.customerType ?? '') ? { customerType } : {}),
        ...(gstin !== (original.gstin ?? '') ? { gstin } : {}),
      },
    });
    if (!parsed.success || (customerType === 'B2B' && !/^[0-9A-Z]{15}$/.test(gstin))) {
      setProblem('Choose a valid change. Business customers need a 15 character GSTIN.');
      return;
    }
    intent.current = parsed.data;
    await run(false);
  }
  if (!editing)
    return (
      <button
        type="button"
        className="button secondary"
        disabled={disabled || !profile.editable}
        onClick={() => setEditing(true)}
      >
        Edit customer details
      </button>
    );
  const frozen = disabled || phase !== 'idle';
  return (
    <form
      className="customer-profile-editor"
      aria-label="Edit customer details"
      onSubmit={(event) => void submit(event)}
    >
      <fieldset disabled={frozen}>
        <legend>Customer details</legend>
        <label>
          Birthday
          <input
            type="date"
            min="1000-01-01"
            value={birthday}
            onChange={(event) => setBirthday(event.target.value)}
          />
        </label>
        <label>
          Anniversary
          <input
            type="date"
            min="1000-01-01"
            value={anniversary}
            onChange={(event) => setAnniversary(event.target.value)}
          />
        </label>
        <label>
          Gender
          <select
            aria-label="Gender"
            value={gender}
            onChange={(event) => setGender(event.target.value)}
          >
            <option value="" disabled>
              Choose gender
            </option>
            <option value="F">Female</option>
            <option value="M">Male</option>
            <option value="O">Other</option>
          </select>
        </label>
        <label>
          Customer type
          <select
            aria-label="Customer type"
            value={customerType}
            onChange={(event) => {
              setCustomerType(event.target.value);
              if (event.target.value === 'B2C') setGstin('');
            }}
          >
            <option value="" disabled>
              Choose customer type
            </option>
            <option value="B2C">Individual</option>
            <option value="B2B">Business</option>
          </select>
        </label>
        {customerType === 'B2B' && (
          <label>
            GSTIN
            <input
              maxLength={15}
              value={gstin}
              onChange={(event) =>
                setGstin(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))
              }
            />
          </label>
        )}
        <p className="caption">
          Saving clears the current quote so the sale can recalculate customer benefits.
        </p>
        <div className="toolbar">
          <button className="button" type="submit">
            Save customer details
          </button>
          <button className="button secondary" type="button" onClick={() => setEditing(false)}>
            Cancel edit
          </button>
        </div>
      </fieldset>
      {problem && (
        <p role="alert" className="inline-error">
          {problem}
        </p>
      )}
      {phase === 'sending' && <p role="status">Checking customer update…</p>}
      {phase === 'uncertain' && (
        <div className="toolbar">
          <button
            className="button secondary"
            type="button"
            disabled={disabled}
            onClick={() => void run(true)}
          >
            Check saved update
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={disabled}
            onClick={() => void run(false)}
          >
            Retry exact saved update
          </button>
        </div>
      )}
      {phase === 'confirmed' && (
        <button
          className="button secondary"
          type="button"
          disabled={disabled}
          onClick={() =>
            void actions.act(async () => {
              await actions.onSaved();
              actions.onPending(false);
              setEditing(false);
              setPhase('idle');
            })
          }
        >
          Reload sale
        </button>
      )}
    </form>
  );
}
