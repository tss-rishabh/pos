import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { ErrorState, Loading } from '../../components/common';
import { readCustomerProfile } from './client';
import { CustomerProfileEditor, type ProfileEditorActions } from './editor';
export { customerProfileResponse } from './client';
import './style.css';

export function CustomerProfileCard({
  operatorId,
  storeId,
  checkoutId,
  customerId,
  checkoutVersion,
  online,
  disabled = false,
  actions,
}: {
  operatorId: string;
  storeId: string;
  checkoutId: string;
  customerId: string;
  checkoutVersion: number;
  online: boolean;
  disabled?: boolean;
  actions?: ProfileEditorActions;
}) {
  const [open, setOpen] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  const profile = useQuery({
    queryKey: [
      operatorId,
      'checkout-customer-profile',
      storeId,
      checkoutId,
      customerId,
      checkoutVersion,
    ],
    enabled: open && online && !updatePending,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) =>
      readCustomerProfile({ operatorId, storeId, checkoutId, customerId }, checkoutVersion, signal),
  });
  const value = profile.data?.profile;
  return (
    <section aria-label="Customer details">
      <button
        className="button secondary"
        type="button"
        disabled={!online || updatePending}
        aria-expanded={open && online}
        onClick={() => setOpen(!open)}
      >
        <UserRound size={15} />
        {open && online ? 'Hide customer details' : 'Customer details'}
      </button>
      {open && online && (
        <div className="customer-profile-panel">
          {profile.isPending || profile.isFetching ? (
            <Loading />
          ) : profile.isError ? (
            <ErrorState error={profile.error} retry={() => void profile.refetch()} />
          ) : (
            value && (
              <dl>
                <dt>Name</dt>
                <dd>{[value.firstName, value.lastName].filter(Boolean).join(' ') || '—'}</dd>
                <dt>Email</dt>
                <dd>{value.email || '—'}</dd>
                <dt>Mobile</dt>
                <dd>{value.telephone || '—'}</dd>
                <dt>Gender</dt>
                <dd>
                  {value.gender === 'M'
                    ? 'Male'
                    : value.gender === 'F'
                      ? 'Female'
                      : value.gender === 'O'
                        ? 'Other'
                        : '—'}
                </dd>
                <dt>Birthday</dt>
                <dd>{value.birthday || '—'}</dd>
                <dt>Anniversary</dt>
                <dd>{value.anniversary || '—'}</dd>
                <dt>Customer type</dt>
                <dd>{value.customerType || '—'}</dd>
                <dt>GSTIN</dt>
                <dd>{value.gstin || '—'}</dd>
              </dl>
            )
          )}
        </div>
      )}
      {open && profile.data && actions && !profile.isPending && !profile.isError && (
        <div hidden={!online || profile.isFetching}>
          <CustomerProfileEditor
            key={profile.data.etag}
            scope={{ operatorId, storeId, checkoutId, customerId }}
            profile={profile.data}
            disabled={disabled || !online}
            actions={{
              ...actions,
              onPending: (pending) => {
                setUpdatePending(pending);
                actions.onPending(pending);
              },
            }}
          />
        </div>
      )}
    </section>
  );
}
