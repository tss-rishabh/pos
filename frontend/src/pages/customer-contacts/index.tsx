import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Phone } from 'lucide-react';
import { ApiError, captureOperatorScope } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import {
  emailPattern,
  mobilePattern,
  readContactWorkspace,
  saveEmail,
  saveTelephone,
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
/**
 * Legacy "Add Mobile No." (`create_order.html:575-580`, `:7814-7867`) and the placeholder-email
 * prompt (`:7926-7976`): plain updates of the checkout customer's contact.
 */
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
  const [mobile, setMobile] = useState(''),
    [email, setEmail] = useState(''),
    [problem, setProblem] = useState(''),
    [notice, setNotice] = useState(''),
    [saving, setSaving] = useState(false);
  const workspace = useQuery({
    queryKey: [
      'customer-contacts',
      scope.operatorId,
      scope.storeId,
      scope.checkoutId,
      scope.customerId,
      checkoutVersion,
    ],
    queryFn: ({ signal }) => readContactWorkspace(scope, signal),
    enabled: online,
    staleTime: 0,
  });
  async function submit(kind: 'telephone' | 'email', event: FormEvent) {
    event.preventDefault();
    if (saving || disabled || !online) return;
    const value = kind === 'telephone' ? mobile.trim() : email.trim();
    if (kind === 'telephone' ? !mobilePattern.test(value) : !emailPattern.test(value)) {
      setProblem(
        kind === 'telephone'
          ? 'Please provide a valid mobile number'
          : 'Please provide a valid email',
      );
      return;
    }
    setProblem('');
    setNotice('');
    setSaving(true);
    actions.onPending(true);
    try {
      await actions.act(async () => {
        const signal = captureOperatorScope(scope.operatorId);
        const result =
          kind === 'telephone'
            ? await saveTelephone(scope, value, signal)
            : await saveEmail(scope, value, signal);
        setNotice(result.message);
        await actions.onSaved();
        await workspace.refetch();
      });
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'The contact could not be saved.');
    } finally {
      setSaving(false);
      actions.onPending(false);
    }
  }
  if (!online) return null;
  if (workspace.isLoading) return <Loading />;
  if (workspace.error)
    return <ErrorState error={workspace.error} retry={() => void workspace.refetch()} />;
  const value = workspace.data;
  if (!value || (!value.canAddTelephone && !value.canChangeEmail && !notice && !problem))
    return null;
  return (
    <section aria-label="Customer contact" className="customer-contact-panel">
      {value.canAddTelephone && (
        <form
          className="customer-contact-card"
          onSubmit={(event) => void submit('telephone', event)}
        >
          <label>
            <Phone size={14} /> User Mobile Number
            <input
              type="tel"
              inputMode="numeric"
              maxLength={10}
              placeholder="Enter Mobile Number to be Registered"
              value={mobile}
              disabled={disabled || saving}
              onChange={(event) => setMobile(event.currentTarget.value)}
            />
          </label>
          <small>
            Updating number for e-mail: <b>{value.email}</b>
          </small>
          <button type="submit" className="button secondary" disabled={disabled || saving}>
            Add Mobile No.
          </button>
        </form>
      )}
      {value.canChangeEmail && (
        <form className="customer-contact-card" onSubmit={(event) => void submit('email', event)}>
          <label>
            <Mail size={14} /> Add User&apos;s Email ID
            <input
              type="email"
              placeholder="Email Address"
              value={email}
              disabled={disabled || saving}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
          </label>
          <button type="submit" className="button secondary" disabled={disabled || saving}>
            Submit
          </button>
        </form>
      )}
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
    </section>
  );
}
