import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  profileAdjustment,
  readCustomerProfile,
  type ProfileScope,
} from '../customer-insights/client';

/**
 * Legacy "Birthday Missing" prompt (`create_order.html:8073-8100`): shown once per customer and
 * tab when the connected customer has no birthday; Cancel remembers the dismissal
 * (`localStorage birthday_reminder_{user}_{tab}`), Confirm saves the date.
 */
const dismissKey = (customerId: string, checkoutId: string) =>
  `birthday_reminder_${customerId}_${checkoutId}`;
function dismissed(key: string) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function BirthdayPrompt({
  scope,
  checkoutVersion,
  disabled,
  onSaved,
}: {
  scope: ProfileScope;
  checkoutVersion: number;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const key = dismissKey(scope.customerId, scope.checkoutId);
  const [hidden, setHidden] = useState(() => dismissed(key)),
    [date, setDate] = useState(''),
    [problem, setProblem] = useState(''),
    [busy, setBusy] = useState(false);
  const profile = useQuery({
    queryKey: [
      scope.operatorId,
      'birthday-prompt',
      scope.checkoutId,
      scope.customerId,
      checkoutVersion,
    ],
    enabled: !hidden,
    retry: false,
    staleTime: 0,
    queryFn: ({ signal }) => readCustomerProfile(scope, checkoutVersion, signal),
  });
  if (hidden || !profile.data || profile.data.profile.birthday || !profile.data.editable)
    return null;
  const current = profile.data;
  return (
    <div role="dialog" aria-label="Birthday Missing" className="birthday-prompt">
      <h3>Birthday Missing</h3>
      <p>It Seems This Customer Do Not Have Birthday, Please Add a date</p>
      <input
        type="date"
        placeholder="Birthday"
        value={date}
        onChange={(event) => setDate(event.target.value)}
        disabled={disabled || busy}
      />
      {problem && <p role="alert">{problem}</p>}
      <button
        type="button"
        className="button primary"
        disabled={disabled || busy || !date}
        onClick={() => {
          setBusy(true);
          setProblem('');
          void profileAdjustment(
            scope,
            {
              operationId: crypto.randomUUID(),
              expectedVersion: current.checkoutVersion,
              expectedEtag: current.etag,
              changes: { birthday: date },
            },
            false,
          )
            .then(async () => {
              setHidden(true);
              await onSaved();
            })
            .catch((error: unknown) =>
              setProblem(error instanceof Error ? error.message : 'The birthday was not saved.'),
            )
            .finally(() => setBusy(false));
        }}
      >
        Confirm
      </button>
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          try {
            localStorage.setItem(key, '1');
          } catch {
            // The prompt stays dismissed for this view when storage is unavailable.
          }
          setHidden(true);
        }}
      >
        cancel
      </button>
    </div>
  );
}
